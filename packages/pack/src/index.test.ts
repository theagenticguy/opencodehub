/**
 * Tests for the @opencodehub/pack public entry.
 *
 * The first block pins the public surface (`generatePack` is a function
 * and returns a Promise). The E2E tests below cover end-to-end
 * determinism + payload-shape:
 *
 *   E2E-A. Two consecutive `generatePack` runs against the same fixture
 *          and the same `outDir` produce byte-identical files. The
 *          manifest's `pack_hash` is identical too.
 *   E2E-B. Anthropic tokenizer ids downgrade `determinism_class` to
 *          `best_effort`.
 *   E2E-C. The chunker's degraded fallback flips `determinism_class` to
 *          `degraded` even when the tokenizer is non-Anthropic.
 *   E2E-D. The expected 9 files (7 BOM bodies + manifest + readme) appear
 *          on disk after a successful run.
 *   E2E-E. The on-disk manifest's `files[]` lists every BOM item we
 *          wrote (excluding the manifest itself + readme).
 */

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, test } from "node:test";
import type { GraphNode } from "@opencodehub/core-types";
import type { IGraphStore, ListNodesOptions } from "@opencodehub/storage";
import { generatePack } from "./index.js";

describe("@opencodehub/pack public entry", () => {
  it("exports generatePack as a function", () => {
    assert.equal(typeof generatePack, "function");
  });
});

// --- E2E fixtures ---

interface RawEdge {
  readonly from_id: string;
  readonly to_id: string;
  readonly type: string;
}

function makeFixtureStore(): IGraphStore {
  const nodes: readonly GraphNode[] = [
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
      id: "file:src/a.ts" as GraphNode["id"],
      kind: "File",
      name: "a.ts",
      filePath: "src/a.ts",
      language: "typescript",
    },
    {
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
    },
  ];
  const edges: readonly RawEdge[] = [{ from_id: "fn:a", to_id: "fn:b", type: "CALLS" }];

  return {
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
    listFindings: async () => {
      return nodes.filter(
        (n): n is Extract<GraphNode, { kind: "Finding" }> => n.kind === "Finding",
      );
    },
    // The fixture store has no embeddings. `listEmbeddings` is part of the
    // IGraphStore shape but is unused by the pack now that the Parquet
    // sidecar is gone; kept callable for shape completeness.
    listEmbeddings: async function* () {
      // Empty generator.
    },
  } as unknown as IGraphStore;
}

const FIXTURE_FILES = [
  {
    path: "src/a.ts",
    bytes: new TextEncoder().encode("export const a = 1;\n"),
    language: "typescript",
  },
];

const COMMON_OPTS: { budgetTokens: number; tokenizerId: string } = {
  budgetTokens: 64,
  tokenizerId: "openai:o200k_base@0.8.0",
};

const COMMON_INTERNAL = {
  commit: "0".repeat(40),
  repoOriginUrl: "https://github.com/example/repo",
  grammarCommits: { typescript: "b".repeat(40) },
  // Provide a deterministic chonkie loader for the strict path so tests
  // never depend on the real `@chonkiejs/core` install (worktree native
  // bindings such as onnxruntime-node may not rebuild cleanly).
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

async function runFixture(
  outDir: string,
  overrides: Partial<typeof COMMON_OPTS> = {},
  internalOverrides: Record<string, unknown> = {},
) {
  return generatePack(
    {
      repoPath: "/tmp/fixture-repo",
      outDir,
      budgetTokens: overrides.budgetTokens ?? COMMON_OPTS.budgetTokens,
      tokenizerId: overrides.tokenizerId ?? COMMON_OPTS.tokenizerId,
    },
    {
      ...COMMON_INTERNAL,
      // The seam accepts a composed `Store`, but tests can pass a
      // graph-only store via `graphOnly`. generatePack auto-wraps it into a
      // Store whose temporal view aliases the graph; the BOM bodies read
      // only `store.graph`.
      graphOnly: makeFixtureStore(),
      chunkerFiles: FIXTURE_FILES,
      ...internalOverrides,
    },
  );
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "pack-e2e-"));
}

async function fileSha(p: string): Promise<string> {
  const bytes = await readFile(p);
  return createHash("sha256").update(bytes).digest("hex");
}

test("E2E-A. two consecutive runs produce byte-identical files", async () => {
  const a = await tempDir();
  const b = await tempDir();
  try {
    const m1 = await runFixture(a);
    const m2 = await runFixture(b);
    assert.equal(m1.packHash, m2.packHash);
    const files = [
      "skeleton.jsonl",
      "file-tree.jsonl",
      "deps.jsonl",
      "ast-chunks.jsonl",
      "xrefs.jsonl",
      "findings.jsonl",
      "licenses.md",
      "readme.md",
      "manifest.json",
    ];
    for (const f of files) {
      const ha = await fileSha(path.join(a, f));
      const hb = await fileSha(path.join(b, f));
      assert.equal(ha, hb, `byte-identity broken for ${f}`);
    }
  } finally {
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  }
});

test("E2E-B. Anthropic tokenizer downgrades determinism_class to best_effort", async () => {
  const dir = await tempDir();
  try {
    const manifest = await runFixture(dir, {
      tokenizerId: "anthropic:claude-opus-4-7@2026-04",
    });
    assert.equal(manifest.determinismClass, "best_effort");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("E2E-C. chunker degraded fallback flips determinism_class to degraded", async () => {
  const dir = await tempDir();
  try {
    const manifest = await runFixture(
      dir,
      {},
      {
        // Force the chunker to fall back by rejecting the loader.
        chonkieLoader: async () => {
          throw new Error("simulated import failure");
        },
      },
    );
    assert.equal(manifest.determinismClass, "degraded");
    // Even with a non-Anthropic tokenizer, degraded dominates best_effort.
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("E2E-D. expected 9 files appear on disk after a run", async () => {
  const dir = await tempDir();
  try {
    await runFixture(dir);
    const entries = await readdir(dir);
    const names = new Set(entries);
    for (const n of [
      "skeleton.jsonl",
      "file-tree.jsonl",
      "deps.jsonl",
      "ast-chunks.jsonl",
      "xrefs.jsonl",
      "findings.jsonl",
      "licenses.md",
      "readme.md",
      "manifest.json",
    ]) {
      assert.ok(names.has(n), `missing BOM file: ${n}`);
    }
    // The Parquet embeddings sidecar was dropped (ADR 0019); no .parquet
    // file is ever produced.
    for (const n of names) {
      assert.ok(!n.endsWith(".parquet"), `unexpected Parquet file: ${n}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("E2E-E. on-disk manifest.files[] lists every body BOM item, excluding manifest+readme", async () => {
  const dir = await tempDir();
  try {
    const manifest = await runFixture(dir);
    const onDisk = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as {
      files: Array<{ kind: string; path: string; file_hash: string }>;
    };
    const paths = onDisk.files.map((f) => f.path).sort();
    assert.deepEqual(paths, [
      "ast-chunks.jsonl",
      "deps.jsonl",
      "file-tree.jsonl",
      "findings.jsonl",
      "licenses.md",
      "skeleton.jsonl",
      "xrefs.jsonl",
    ]);
    // Every BOM item's file_hash matches the on-disk file's sha256.
    for (const f of onDisk.files) {
      const actual = await fileSha(path.join(dir, f.path));
      assert.equal(f.file_hash, actual, `file_hash mismatch for ${f.path}`);
    }
    assert.match(manifest.packHash, /^[0-9a-f]{64}$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("E2E-F. production store path throws cleanly when no internal store provided", async () => {
  const dir = await tempDir();
  try {
    await assert.rejects(
      generatePack({
        repoPath: "/tmp/missing",
        outDir: dir,
        budgetTokens: 64,
        tokenizerId: "openai:o200k_base@0.8.0",
      }),
      /production store lookup is wired by the CLI/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The Parquet embeddings sidecar was dropped (ADR 0019): embeddings live in
// store.sqlite and there is no longer a write-only Parquet export. The pack
// is a fixed 8-item BOM (manifest + 7 bodies) plus a consumer-facing readme;
// no .parquet file is ever produced. The on-disk invariant is covered by
// E2E-D's `.parquet`-absence assertion above.
// ---------------------------------------------------------------------------
