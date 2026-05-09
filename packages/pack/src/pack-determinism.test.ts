/**
 * End-to-end byte-identity determinism suite (AC-M5-8 / U2 / E-M5-3).
 *
 * The per-module tests in this package each pin one slice of the U2
 * invariant ("same inputs → same bytes"). This suite exercises the
 * composition: it runs `generatePack` twice over a richer fixture and
 * asserts every file under `outDir` is byte-identical across runs.
 *
 * Per-variant assertions:
 *   1. `m1.packHash === m2.packHash`
 *   2. `readdir(outA).sort()` deep-equals `readdir(outB).sort()`
 *      (same file set; no missing/extra files)
 *   3. For every file `f` in the directory:
 *      `Buffer.compare(readFile(outA/f), readFile(outB/f)) === 0`
 *
 * Variant matrix (≥ 4 per the AC-M5-8 packet):
 *   V1. Empty embeddings — store has no `exportEmbeddingsParquet` hook;
 *       sidecar is absent; manifest.files[] lists 7 BOM bodies (excluding
 *       manifest+readme). 9 files on disk: 7 bodies + readme.md + manifest.json.
 *   V2. Populated embeddings — fake @internal `exportEmbeddingsParquet`
 *       (duck-typed onto the graph view, AC-A-4) writes a deterministic
 *       parquet body; sidecar is present; embeddings.parquet bytes are
 *       identical across runs.
 *   V3. Mixed framework labels — ProjectProfile.frameworks is a duplicated,
 *       reverse-sorted list. file-tree.jsonl frameworks must be alpha-sorted +
 *       deduped to the same byte sequence on both runs.
 *   V4. Grouped findings — multiple findings sharing (severity, ruleId)
 *       must group stably; findings.jsonl bytes match across runs.
 *
 * The chonkie loader is a deterministic stub so the test never depends on
 * the real `@chonkiejs/core` install (worktree native-binding lesson).
 */

import { strict as assert } from "node:assert";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { GraphNode } from "@opencodehub/core-types";
import type { IGraphStore, ITemporalStore, ListNodesOptions, Store } from "@opencodehub/storage";
import { type GeneratePackInternalOpts, generatePack } from "./index.js";

// ---------------------------------------------------------------------------
// Fixture knobs
// ---------------------------------------------------------------------------

interface FixtureKnobs {
  /**
   * Attach a duck-typed @internal `exportEmbeddingsParquet` helper to the
   * graph fake so AC-A-4's sidecar emits 4 deterministic bytes. The
   * helper lives on the graph view because `runVariant` wraps the fake
   * with `backend: "duck"`, where the sidecar narrows on `store.graph`.
   */
  readonly withEmbeddings: boolean;
  /** Use a duplicated, reverse-sorted ProjectProfile.frameworks list. */
  readonly withMixedFrameworks: boolean;
  /** Add multiple findings sharing (severity, ruleId) for grouping. */
  readonly withGroupedFindings: boolean;
}

interface RawEdge {
  readonly from_id: string;
  readonly to_id: string;
  readonly type: string;
}

function makeRichFixtureStore(knobs: FixtureKnobs): IGraphStore {
  const baseNodes: GraphNode[] = [
    {
      id: "fn:a" as GraphNode["id"],
      kind: "Function",
      name: "a",
      filePath: "src/a.ts",
      startLine: 1,
      endLine: 5,
    },
    {
      id: "fn:b" as GraphNode["id"],
      kind: "Function",
      name: "b",
      filePath: "src/b.ts",
      startLine: 1,
      endLine: 5,
    },
    {
      id: "comm:core" as GraphNode["id"],
      kind: "Community",
      name: "core",
      filePath: ".",
      inferredLabel: "core",
      symbolCount: 2,
    },
    {
      id: "dep:npm:lodash@4.17.21" as GraphNode["id"],
      kind: "Dependency",
      name: "lodash",
      filePath: "package.json",
      version: "4.17.21",
      ecosystem: "npm",
      lockfileSource: "pnpm-lock.yaml",
      license: "MIT",
    },
    {
      id: "dep:npm:zod@3.23.8" as GraphNode["id"],
      kind: "Dependency",
      name: "zod",
      filePath: "package.json",
      version: "3.23.8",
      ecosystem: "npm",
      lockfileSource: "pnpm-lock.yaml",
      license: "MIT",
    },
    {
      id: "file:src/a.ts" as GraphNode["id"],
      kind: "File",
      name: "a.ts",
      filePath: "src/a.ts",
      language: "typescript",
    },
    {
      id: "file:src/b.ts" as GraphNode["id"],
      kind: "File",
      name: "b.ts",
      filePath: "src/b.ts",
      language: "typescript",
    },
  ];

  if (knobs.withMixedFrameworks) {
    // Duplicates + reverse-sorted to exercise dedupeAndSort. The on-disk
    // file-tree.jsonl must end up with `["next", "react", "vite"]` — alpha,
    // unique, regardless of input order.
    baseNodes.push({
      id: "profile:repo" as GraphNode["id"],
      kind: "ProjectProfile",
      name: "repo",
      filePath: ".",
      languages: ["typescript"],
      frameworks: ["vite", "react", "next", "react", "vite"],
      iacTypes: [],
      apiContracts: [],
      manifests: ["package.json"],
      srcDirs: ["src"],
    });
  }

  if (knobs.withGroupedFindings) {
    // Three findings sharing (error, rule-a) plus two sharing (warning, rule-c)
    // so the grouping path actually has more than one row per group.
    baseNodes.push(
      {
        id: "fnd:1" as GraphNode["id"],
        kind: "Finding",
        name: "rule-a@src/a.ts:1",
        filePath: "src/a.ts",
        ruleId: "rule-a",
        severity: "error",
        scannerId: "scanner-1",
        message: "fixme-1",
        propertiesBag: {},
        startLine: 1,
        endLine: 1,
      },
      {
        id: "fnd:2" as GraphNode["id"],
        kind: "Finding",
        name: "rule-a@src/a.ts:2",
        filePath: "src/a.ts",
        ruleId: "rule-a",
        severity: "error",
        scannerId: "scanner-1",
        message: "fixme-2",
        propertiesBag: {},
        startLine: 2,
        endLine: 2,
      },
      {
        id: "fnd:3" as GraphNode["id"],
        kind: "Finding",
        name: "rule-a@src/b.ts:3",
        filePath: "src/b.ts",
        ruleId: "rule-a",
        severity: "error",
        scannerId: "scanner-1",
        message: "fixme-3",
        propertiesBag: {},
        startLine: 3,
        endLine: 3,
      },
      {
        id: "fnd:4" as GraphNode["id"],
        kind: "Finding",
        name: "rule-c@src/a.ts:4",
        filePath: "src/a.ts",
        ruleId: "rule-c",
        severity: "warning",
        scannerId: "scanner-2",
        message: "warn-1",
        propertiesBag: {},
        startLine: 4,
        endLine: 4,
      },
      {
        id: "fnd:5" as GraphNode["id"],
        kind: "Finding",
        name: "rule-c@src/b.ts:5",
        filePath: "src/b.ts",
        ruleId: "rule-c",
        severity: "warning",
        scannerId: "scanner-2",
        message: "warn-2",
        propertiesBag: {},
        startLine: 5,
        endLine: 5,
      },
    );
  } else {
    // Provide a single unique finding so the empty-grouping path is also
    // covered without skewing other variants.
    baseNodes.push({
      id: "fnd:1" as GraphNode["id"],
      kind: "Finding",
      name: "rule-x@src/a.ts:1",
      filePath: "src/a.ts",
      ruleId: "rule-x",
      severity: "warning",
      scannerId: "scanner-1",
      message: "fixme",
      propertiesBag: {},
      startLine: 1,
      endLine: 1,
    });
  }

  const nodes: readonly GraphNode[] = baseNodes;
  const edges: readonly RawEdge[] = [{ from_id: "fn:a", to_id: "fn:b", type: "CALLS" }];

  const findingNodes = nodes.filter(
    (n): n is Extract<GraphNode, { kind: "Finding" }> => n.kind === "Finding",
  );

  const store: Record<string, unknown> = {
    listNodes: async (opts: ListNodesOptions = {}) => {
      const kinds = opts.kinds;
      if (kinds !== undefined && kinds.length === 0) return [];
      const set = kinds === undefined ? undefined : new Set(kinds);
      const filtered = set === undefined ? [...nodes] : nodes.filter((n) => set.has(n.kind));
      filtered.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return filtered;
    },
    listNodesByKind: async (kind: string) => {
      return nodes
        .filter((n) => n.kind === kind)
        .slice()
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
    listEdgesByType: async (type: string) => {
      return edges
        .filter((e) => e.type === type)
        .map((e) => ({
          id: `rel:${e.from_id}:${e.to_id}`,
          from: e.from_id,
          to: e.to_id,
          type: e.type,
          confidence: 1,
        }));
    },
    listFindings: async () => findingNodes,
  };

  if (knobs.withEmbeddings) {
    // Deterministic 4-byte parquet stand-in. Real DuckDB Parquet output is
    // also byte-stable for the same input set on the same engine version
    // (S-M5-3 / AC-M5-6); the test exercises the wiring path only.
    store["exportEmbeddingsParquet"] = async (absPath: string): Promise<unknown> => {
      const fs = await import("node:fs/promises");
      await fs.writeFile(absPath, new Uint8Array([0x50, 0x41, 0x52, 0x31]));
      return { rowCount: 2, duckdbVersion: "v1.3.99-test" };
    };
  }

  return store as unknown as IGraphStore;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

const FIXTURE_FILES: ReadonlyArray<{
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly language: string;
}> = [
  {
    path: "src/a.ts",
    bytes: new TextEncoder().encode("export const a = 1;\nexport const aa = 2;\n"),
    language: "typescript",
  },
  {
    path: "src/b.ts",
    bytes: new TextEncoder().encode("export const b = 1;\n"),
    language: "typescript",
  },
];

const COMMON_OPTS = {
  budgetTokens: 256,
  tokenizerId: "openai:o200k_base@0.8.0",
} as const;

const COMMON_INTERNAL: GeneratePackInternalOpts = {
  commit: "0".repeat(40),
  repoOriginUrl: "https://github.com/example/repo",
  duckdbVersion: "1.1.3",
  grammarCommits: { typescript: "b".repeat(40) },
  // Deterministic chonkie stub — emits one chunk per file. Avoids the real
  // import path so the test runs even when native bindings are unavailable
  // (worktree lesson).
  chonkieLoader: async () => ({
    version: "0.0.9",
    CodeChunker: {
      create: async () => ({
        chunk(text: string) {
          return [{ text, startIndex: 0, endIndex: text.length, tokenCount: 1 }];
        },
      }),
    },
  }),
};

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function runVariant(outDir: string, knobs: FixtureKnobs): Promise<{ packHash: string }> {
  const fakeGraph = makeRichFixtureStore(knobs);
  // V2 attaches a duck-typed COPY helper to the graph — wrap into a
  // backend:"duck" Store so the AC-A-4 sidecar narrows correctly. V1/V3/V4
  // never invoke the helper; the wrapper just exposes the graph view.
  const composedStore: Store = {
    backend: "duck",
    graph: fakeGraph,
    temporal: fakeGraph as unknown as ITemporalStore,
    graphFile: ":memory:",
    temporalFile: ":memory:",
    close: async () => {
      /* test owns lifecycle */
    },
  };
  const manifest = await generatePack(
    {
      repoPath: "/tmp/pack-determinism-fixture",
      outDir,
      budgetTokens: COMMON_OPTS.budgetTokens,
      tokenizerId: COMMON_OPTS.tokenizerId,
    },
    {
      ...COMMON_INTERNAL,
      store: composedStore,
      chunkerFiles: FIXTURE_FILES,
    },
  );
  return { packHash: manifest.packHash };
}

/**
 * Run the variant twice and assert byte-identity per the U2 contract.
 */
async function assertByteIdentical(label: string, knobs: FixtureKnobs): Promise<void> {
  const outA = await tempDir(`pack-det-a-${label}-`);
  const outB = await tempDir(`pack-det-b-${label}-`);
  try {
    const a = await runVariant(outA, knobs);
    const b = await runVariant(outB, knobs);

    // 1. packHash equality.
    assert.equal(a.packHash, b.packHash, `${label}: packHash diverged`);

    // 2. Same file set.
    const filesA = (await readdir(outA)).sort();
    const filesB = (await readdir(outB)).sort();
    assert.deepEqual(filesA, filesB, `${label}: file set diverged`);

    // 3. Byte-identity for every file.
    for (const f of filesA) {
      const ba = await readFile(path.join(outA, f));
      const bb = await readFile(path.join(outB, f));
      assert.equal(
        Buffer.compare(ba, bb),
        0,
        `${label}: byte-identity broken for ${f} (sizes ${ba.byteLength} vs ${bb.byteLength})`,
      );
    }
  } finally {
    await rm(outA, { recursive: true, force: true });
    await rm(outB, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Variant tests — 4 distinct shapes per the AC-M5-8 matrix.
// ---------------------------------------------------------------------------

test("V1. empty embeddings — sidecar absent, 9 files on disk, byte-identical", async () => {
  await assertByteIdentical("v1-empty-embeddings", {
    withEmbeddings: false,
    withMixedFrameworks: false,
    withGroupedFindings: false,
  });

  // Cross-check the file-set shape post-hoc. Re-run once to inspect the dir
  // (cheap; the variant fixture is tiny).
  const outDir = await tempDir("pack-det-v1-shape-");
  try {
    await runVariant(outDir, {
      withEmbeddings: false,
      withMixedFrameworks: false,
      withGroupedFindings: false,
    });
    const entries = (await readdir(outDir)).sort();
    assert.deepEqual(entries, [
      "ast-chunks.jsonl",
      "deps.jsonl",
      "file-tree.jsonl",
      "findings.jsonl",
      "licenses.md",
      "manifest.json",
      "readme.md",
      "skeleton.jsonl",
      "xrefs.jsonl",
    ]);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("V2. populated embeddings — sidecar present, parquet bytes byte-identical", async () => {
  await assertByteIdentical("v2-populated-embeddings", {
    withEmbeddings: true,
    withMixedFrameworks: false,
    withGroupedFindings: false,
  });

  // Cross-check that the sidecar is actually on disk for this variant.
  const outDir = await tempDir("pack-det-v2-shape-");
  try {
    await runVariant(outDir, {
      withEmbeddings: true,
      withMixedFrameworks: false,
      withGroupedFindings: false,
    });
    const entries = new Set(await readdir(outDir));
    assert.ok(entries.has("embeddings.parquet"), "v2 must produce embeddings.parquet");
    assert.equal(
      entries.size,
      10,
      "v2 should produce 10 files (8 BOM + readme + manifest + sidecar)",
    );
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("V3. mixed framework labels — file-tree.jsonl alpha-sorted + deduped, byte-identical", async () => {
  await assertByteIdentical("v3-mixed-frameworks", {
    withEmbeddings: false,
    withMixedFrameworks: true,
    withGroupedFindings: false,
  });

  // Cross-check the actual frameworks list in the file-tree output.
  const outDir = await tempDir("pack-det-v3-shape-");
  try {
    await runVariant(outDir, {
      withEmbeddings: false,
      withMixedFrameworks: true,
      withGroupedFindings: false,
    });
    const fileTreeText = await readFile(path.join(outDir, "file-tree.jsonl"), "utf8");
    // Every row should carry the same alpha-sorted, deduped framework list.
    const lines = fileTreeText.split("\n").filter((l) => l.length > 0);
    assert.ok(lines.length >= 1, "v3 file-tree.jsonl must have rows");
    for (const line of lines) {
      const row = JSON.parse(line) as { frameworks: readonly string[] };
      assert.deepEqual(row.frameworks, ["next", "react", "vite"]);
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("V4. grouped findings — findings.jsonl groups stably, byte-identical", async () => {
  await assertByteIdentical("v4-grouped-findings", {
    withEmbeddings: false,
    withMixedFrameworks: false,
    withGroupedFindings: true,
  });

  // Cross-check that grouping actually consolidated rows. With 3 (error,
  // rule-a) + 2 (warning, rule-c) findings we expect exactly 2 group rows.
  const outDir = await tempDir("pack-det-v4-shape-");
  try {
    await runVariant(outDir, {
      withEmbeddings: false,
      withMixedFrameworks: false,
      withGroupedFindings: true,
    });
    const findingsText = await readFile(path.join(outDir, "findings.jsonl"), "utf8");
    const rows = findingsText
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { severity: string; ruleId: string; count: number });
    assert.equal(rows.length, 2, "v4 should produce 2 finding groups");
    // Ordering: error before warning; same-severity groups sorted by ruleId ASC.
    assert.equal(rows[0]?.severity, "error");
    assert.equal(rows[0]?.ruleId, "rule-a");
    assert.equal(rows[0]?.count, 3);
    assert.equal(rows[1]?.severity, "warning");
    assert.equal(rows[1]?.ruleId, "rule-c");
    assert.equal(rows[1]?.count, 2);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Combined variant — exercises every knob together so the composition is
// covered: populated embeddings + mixed frameworks + grouped findings.
// ---------------------------------------------------------------------------

test("V5. all-knobs — every byte identical across two runs", async () => {
  await assertByteIdentical("v5-all-knobs", {
    withEmbeddings: true,
    withMixedFrameworks: true,
    withGroupedFindings: true,
  });
});
