/**
 * Tests for `codehub query` CLI command — parity with the MCP `query` tool.
 *
 * We cover:
 *   - `--context` / `--goal` prefix the search text.
 *   - `--content` attaches + caps source bodies.
 *   - `--max-symbols` is accepted through the type surface (no-op today).
 *   - Hybrid path runs when embeddings are populated + embedder resolves.
 *   - Hybrid collapses to BM25 with a stderr warning when the embedder fails.
 *   - `--bm25-only` skips the embedder probe entirely.
 *
 * The fake store intercepts the `embeddings` count probe so we can steer
 * the hybrid-vs-BM25 branch without staging DuckDB or ONNX weights.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { Embedder } from "@opencodehub/embedder";
import type {
  DuckDbStore,
  SearchQuery,
  SearchResult,
  SqlParam,
  SymbolSummaryRow,
  VectorQuery,
  VectorResult,
} from "@opencodehub/storage";
import { runQuery } from "./query.js";

interface FakeNode {
  readonly name: string;
  readonly kind: string;
  readonly filePath: string;
}

interface FakeStoreOptions {
  readonly embeddingRows?: number;
  readonly searchRows?: readonly SearchResult[];
  readonly vectorRows?: readonly VectorResult[];
  readonly nodes?: ReadonlyMap<string, FakeNode>;
  /** P04 symbol summaries — keyed by nodeId. Omit to simulate legacy indexes. */
  readonly summaryRows?: ReadonlyMap<string, SymbolSummaryRow>;
}

interface FakeStoreHandle {
  lastQuery: string | null;
  searchCalls: number;
  vectorCalls: number;
  embeddingCountQueries: number;
  closed: boolean;
  readonly store: DuckDbStore;
}

function makeFakeStore(opts: FakeStoreOptions = {}): FakeStoreHandle {
  const embeddingRows = opts.embeddingRows ?? 0;
  const searchRows = opts.searchRows ?? [];
  const vectorRows = opts.vectorRows ?? [];
  const nodes = opts.nodes ?? new Map<string, FakeNode>();
  const summaryRows = opts.summaryRows;


  const handle: FakeStoreHandle = {
    lastQuery: null,
    searchCalls: 0,
    vectorCalls: 0,
    embeddingCountQueries: 0,
    closed: false,
    store: {} as DuckDbStore,
  };
  // Minimal DuckDbStore surface: the CLI query path calls `search`,
  // `vectorSearch`, `query` (for the embeddings probe + metadata
  // hydration), `lookupSymbolSummariesByNode` (for P04 summary join),
  // and `close`. Stubbing those is enough; the rest is cast.
  const impl = {
    search: async (q: SearchQuery) => {
      handle.lastQuery = q.text;
      handle.searchCalls += 1;
      return searchRows;
    },
    vectorSearch: async (_q: VectorQuery) => {
      handle.vectorCalls += 1;
      return vectorRows;
    },
    query: async (
      sql: string,
      params: readonly SqlParam[] = [],
    ): Promise<readonly Record<string, unknown>[]> => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized === "SELECT COUNT(*) AS n FROM embeddings") {
        handle.embeddingCountQueries += 1;
        return [{ n: embeddingRows }];
      }
      if (normalized.startsWith("SELECT id, name, kind, file_path FROM nodes WHERE id IN")) {
        const idSet = new Set(params.map((p) => String(p)));
        const out: Record<string, unknown>[] = [];
        for (const id of idSet) {
          const meta = nodes.get(id);
          if (meta) {
            out.push({
              id,
              name: meta.name,
              kind: meta.kind,
              file_path: meta.filePath,
            });
          }
        }
        return out;
      }
      throw new Error(`unsupported sql in fake store: ${normalized}`);
    },
    ...(summaryRows !== undefined
      ? {
          lookupSymbolSummariesByNode: async (
            nodeIds: readonly string[],
          ): Promise<readonly SymbolSummaryRow[]> => {
            const out: SymbolSummaryRow[] = [];
            for (const id of nodeIds) {
              const row = summaryRows.get(id);
              if (row !== undefined) out.push(row);
            }
            return out;
          },
        }
      : {}),
    close: async () => {
      handle.closed = true;
    },
  } as unknown as DuckDbStore;
  (handle as { store: DuckDbStore }).store = impl;
  return handle;
}

/** Capture console.log output during `fn`. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const orig = console.log;
  const chunks: string[] = [];
  console.log = (...args: unknown[]) => {
    chunks.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return chunks.join("\n");
}

/** Capture console.warn output during `fn`. */
async function captureStderr(fn: () => Promise<void>): Promise<string[]> {
  const orig = console.warn;
  const out: string[] = [];
  console.warn = (...args: unknown[]) => {
    out.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await fn();
  } finally {
    console.warn = orig;
  }
  return out;
}

class FakeEmbedder implements Embedder {
  readonly dim = 4;
  readonly modelId = "fake-embedder/test";
  closeCount = 0;
  async embed(_text: string): Promise<Float32Array> {
    return new Float32Array([0.1, 0.2, 0.3, 0.4]);
  }
  async embedBatch(texts: readonly string[]): Promise<readonly Float32Array[]> {
    return texts.map(() => new Float32Array([0.1, 0.2, 0.3, 0.4]));
  }
  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** Build a `hooks` value that returns the fake store for any `runQuery` call. */
function hooksFor(handle: FakeStoreHandle, repoPath: string) {
  return {
    openStore: async () => ({ store: handle.store, repoPath }),
  };
}

test("cli query: --context is prefixed to the search text", async () => {
  const handle = makeFakeStore({
    searchRows: [
      { nodeId: "F:foo", score: 2, filePath: "src/foo.ts", name: "foo", kind: "Function" },
    ],
  });
  await captureStdout(async () => {
    await runQuery(
      "validate user",
      { context: "adding OAuth support" },
      hooksFor(handle, "/tmp/fake"),
    );
  });
  assert.equal(handle.lastQuery, "adding OAuth support — validate user");
});

test("cli query: --goal is prefixed to the search text", async () => {
  const handle = makeFakeStore({
    searchRows: [
      { nodeId: "F:foo", score: 2, filePath: "src/foo.ts", name: "foo", kind: "Function" },
    ],
  });
  await captureStdout(async () => {
    await runQuery(
      "validate user",
      { goal: "find the auth entry point" },
      hooksFor(handle, "/tmp/fake"),
    );
  });
  assert.equal(handle.lastQuery, "find the auth entry point — validate user");
});

test("cli query: --context + --goal are both prefixed in declared order", async () => {
  const handle = makeFakeStore({
    searchRows: [
      { nodeId: "F:foo", score: 2, filePath: "src/foo.ts", name: "foo", kind: "Function" },
    ],
  });
  await captureStdout(async () => {
    await runQuery(
      "validate user",
      {
        context: "adding OAuth support",
        goal: "existing auth validation logic",
      },
      hooksFor(handle, "/tmp/fake"),
    );
  });
  assert.equal(
    handle.lastQuery,
    "adding OAuth support — existing auth validation logic — validate user",
  );
});

test("cli query: without --context/--goal the search text is untouched", async () => {
  const handle = makeFakeStore({
    searchRows: [
      { nodeId: "F:foo", score: 2, filePath: "src/foo.ts", name: "foo", kind: "Function" },
    ],
  });
  await captureStdout(async () => {
    await runQuery("validate user", {}, hooksFor(handle, "/tmp/fake"));
  });
  assert.equal(handle.lastQuery, "validate user");
});

test("cli query: --content attaches the file body to each JSON result", async () => {
  const home = await mkdtemp(join(tmpdir(), "och-cli-query-"));
  try {
    const repoPath = resolve(home, "repo");
    const fileRel = "src/foo.ts";
    const fileAbs = resolve(repoPath, fileRel);
    await mkdir(resolve(repoPath, "src"), { recursive: true });
    await writeFile(fileAbs, "export function foo() { return 42; }\n", "utf8");
    const handle = makeFakeStore({
      searchRows: [
        { nodeId: "F:foo", score: 2, filePath: fileRel, name: "foo", kind: "Function" },
      ],
    });
    const stdout = await captureStdout(async () => {
      await runQuery("foo", { content: true, json: true }, hooksFor(handle, repoPath));
    });
    const parsed = JSON.parse(stdout) as {
      results: Array<{ content?: string; name: string }>;
    };
    assert.equal(parsed.results[0]?.name, "foo");
    assert.ok(
      parsed.results[0]?.content?.includes("export function foo"),
      "content must include the file source",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("cli query: --content silently omits the field when the file is missing", async () => {
  const home = await mkdtemp(join(tmpdir(), "och-cli-query-"));
  try {
    const repoPath = resolve(home, "repo");
    await mkdir(repoPath, { recursive: true });
    const handle = makeFakeStore({
      searchRows: [
        {
          nodeId: "F:gone",
          score: 2,
          filePath: "src/deleted.ts",
          name: "gone",
          kind: "Function",
        },
      ],
    });
    const stdout = await captureStdout(async () => {
      await runQuery("gone", { content: true, json: true }, hooksFor(handle, repoPath));
    });
    const parsed = JSON.parse(stdout) as {
      results: Array<{ content?: string }>;
    };
    assert.equal(
      parsed.results[0]?.content,
      undefined,
      "content must be omitted when the source file is unreadable",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("cli query: --content caps long files at 2000 chars with an ellipsis", async () => {
  const home = await mkdtemp(join(tmpdir(), "och-cli-query-"));
  try {
    const repoPath = resolve(home, "repo");
    const fileRel = "src/big.ts";
    const fileAbs = resolve(repoPath, fileRel);
    await mkdir(resolve(repoPath, "src"), { recursive: true });
    // 3000-char file — safely past the 2000 cap.
    await writeFile(fileAbs, "x".repeat(3000), "utf8");
    const handle = makeFakeStore({
      searchRows: [
        { nodeId: "F:big", score: 2, filePath: fileRel, name: "big", kind: "Function" },
      ],
    });
    const stdout = await captureStdout(async () => {
      await runQuery("big", { content: true, json: true }, hooksFor(handle, repoPath));
    });
    const parsed = JSON.parse(stdout) as {
      results: Array<{ content?: string }>;
    };
    const body = parsed.results[0]?.content ?? "";
    assert.ok(body.length <= 2000, `content must be ≤2000 chars; got ${body.length}`);
    assert.ok(body.endsWith("…"), "truncation ellipsis expected when the cap hits");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("cli query: --max-symbols is accepted without error (today a no-op)", async () => {
  // The CLI surface forwards --max-symbols for MCP parity; the store's
  // `search()` is not process-aware today, so the flag is a no-op. The
  // invariant tested here is that the surface compiles and runs green when
  // the option is supplied.
  const handle = makeFakeStore({
    searchRows: [
      { nodeId: "F:foo", score: 2, filePath: "src/foo.ts", name: "foo", kind: "Function" },
    ],
  });
  await captureStdout(async () => {
    await runQuery("foo", { maxSymbols: 3 }, hooksFor(handle, "/tmp/fake"));
  });
  assert.equal(handle.searchCalls, 1);
  assert.equal(handle.closed, true, "store.close() must run even on no-op flags");
});

// ---------------------------------------------------------------------------
// P02: hybrid-by-default, BM25 fallback, --bm25-only
// ---------------------------------------------------------------------------

test("cli query: embeddings populated + embedder opens → hybrid path, mode=hybrid", async () => {
  const nodes: ReadonlyMap<string, FakeNode> = new Map([
    ["F:foo", { name: "foo", kind: "Function", filePath: "src/foo.ts" }],
    ["F:bar", { name: "bar", kind: "Function", filePath: "src/bar.ts" }],
    ["F:baz", { name: "baz", kind: "Function", filePath: "src/baz.ts" }],
  ]);
  const handle = makeFakeStore({
    embeddingRows: 10,
    searchRows: [
      { nodeId: "F:foo", score: 2, filePath: "src/foo.ts", name: "foo", kind: "Function" },
      { nodeId: "F:bar", score: 1, filePath: "src/bar.ts", name: "bar", kind: "Function" },
    ],
    vectorRows: [
      { nodeId: "F:bar", distance: 0.1 },
      { nodeId: "F:baz", distance: 0.2 },
    ],
    nodes,
  });
  const fake = new FakeEmbedder();
  const stdout = await captureStdout(async () => {
    await runQuery(
      "auth handler",
      { json: true },
      { ...hooksFor(handle, "/tmp/fake"), openEmbedder: async () => fake },
    );
  });
  const parsed = JSON.parse(stdout) as {
    mode: "bm25" | "hybrid";
    results: Array<{ nodeId: string; sources: string[] }>;
  };
  assert.equal(parsed.mode, "hybrid", "mode must be hybrid when embedder opens");
  assert.equal(handle.vectorCalls, 1, "vectorSearch must run exactly once");
  assert.equal(handle.embeddingCountQueries, 1, "embeddings probe must fire once");
  assert.equal(fake.closeCount, 1, "embedder.close() must run after use");
  const ids = parsed.results.map((r) => r.nodeId).sort();
  assert.deepEqual(ids, ["F:bar", "F:baz", "F:foo"]);
  const bar = parsed.results.find((r) => r.nodeId === "F:bar");
  assert.ok(bar !== undefined);
  assert.deepEqual([...bar.sources].sort(), ["bm25", "vector"]);
});

test("cli query: embeddings populated + embedder fails → warn + BM25 fallback, mode=bm25", async () => {
  const nodes: ReadonlyMap<string, FakeNode> = new Map([
    ["F:foo", { name: "foo", kind: "Function", filePath: "src/foo.ts" }],
  ]);
  const handle = makeFakeStore({
    embeddingRows: 5,
    searchRows: [
      { nodeId: "F:foo", score: 3, filePath: "src/foo.ts", name: "foo", kind: "Function" },
    ],
    // If the BM25 fallback accidentally routed through the vector path
    // these rows would bump `handle.vectorCalls`; we assert it stays at 0.
    vectorRows: [{ nodeId: "F:bar", distance: 0.1 }],
    nodes,
  });
  let stdout = "";
  const warnings = await captureStderr(async () => {
    stdout = await captureStdout(async () => {
      await runQuery(
        "auth handler",
        { json: true },
        {
          ...hooksFor(handle, "/tmp/fake"),
          openEmbedder: async () => {
            const err = new Error(
              "Arctic Embed XS weights not found. Run `codehub setup --embeddings`.",
            );
            (err as unknown as { code: string }).code = "EMBEDDER_NOT_SETUP";
            throw err;
          },
        },
      );
    });
  });
  const parsed = JSON.parse(stdout) as {
    mode: "bm25" | "hybrid";
    results: Array<{ nodeId: string; sources: string[] }>;
  };
  assert.equal(parsed.mode, "bm25", "fallback must report BM25 mode");
  assert.equal(handle.vectorCalls, 0, "vectorSearch must not be called on fallback");
  assert.equal(parsed.results.length, 1);
  assert.deepEqual(parsed.results[0]?.sources, ["bm25"]);
  assert.ok(
    warnings.some((w) => w.includes("hybrid search unavailable") && w.includes("[cli:query]")),
    "a single [cli:query] warning must fire when the embedder can't open",
  );
});

test("cli query: --bm25-only skips the embedder probe entirely", async () => {
  const handle = makeFakeStore({
    // High embeddingRows would normally trigger hybrid; --bm25-only must
    // prevent the probe from even running.
    embeddingRows: 100,
    searchRows: [
      { nodeId: "F:foo", score: 3, filePath: "src/foo.ts", name: "foo", kind: "Function" },
    ],
  });
  let openerCalls = 0;
  const stdout = await captureStdout(async () => {
    await runQuery(
      "auth handler",
      { json: true, bm25Only: true },
      {
        ...hooksFor(handle, "/tmp/fake"),
        openEmbedder: async () => {
          openerCalls += 1;
          throw new Error("opener must not be called when --bm25-only is set");
        },
      },
    );
  });
  const parsed = JSON.parse(stdout) as {
    mode: "bm25" | "hybrid";
    results: Array<{ sources: string[] }>;
  };
  assert.equal(parsed.mode, "bm25");
  assert.equal(openerCalls, 0, "openEmbedder must not be invoked under --bm25-only");
  assert.equal(
    handle.embeddingCountQueries,
    0,
    "embeddings probe must not run when --bm25-only is set",
  );
  assert.equal(handle.vectorCalls, 0);
  assert.equal(parsed.results.length, 1);
  assert.deepEqual(parsed.results[0]?.sources, ["bm25"]);
});

// ---------------------------------------------------------------------------
// P04 summary join — `symbol_summaries` rows flow into query hits
// ---------------------------------------------------------------------------

test("cli query: summary rows are joined onto each hit in --json output (P04)", async () => {
  const summaryRows: ReadonlyMap<string, SymbolSummaryRow> = new Map([
    [
      "F:foo",
      {
        nodeId: "F:foo",
        contentHash: "c0ffee",
        promptVersion: "1",
        modelId: "global.anthropic.claude-haiku-4-5-v1:0",
        summaryText: "Greet the user by name.",
        signatureSummary: "name: string",
        returnsTypeSummary: "a greeting string",
        createdAt: "2026-04-22T00:00:00.000Z",
      },
    ],
  ]);
  const handle = makeFakeStore({
    searchRows: [
      { nodeId: "F:foo", score: 2, filePath: "src/foo.ts", name: "foo", kind: "Function" },
      { nodeId: "F:bar", score: 1, filePath: "src/bar.ts", name: "bar", kind: "Function" },
    ],
    summaryRows,
  });
  const stdout = await captureStdout(async () => {
    await runQuery("foo", { json: true }, hooksFor(handle, "/tmp/fake"));
  });
  const parsed = JSON.parse(stdout) as {
    results: Array<{ nodeId: string; summary?: string; signatureSummary?: string }>;
  };
  const foo = parsed.results.find((r) => r.nodeId === "F:foo");
  const bar = parsed.results.find((r) => r.nodeId === "F:bar");
  assert.ok(foo, "F:foo must be present");
  assert.equal(foo.summary, "Greet the user by name.");
  assert.equal(foo.signatureSummary, "name: string");
  assert.ok(bar, "F:bar must be present");
  assert.equal(bar.summary, undefined, "bar has no summary row; field must be absent");
});

test("cli query: summary join renders a SUMMARY column in the text formatter", async () => {
  const summaryRows: ReadonlyMap<string, SymbolSummaryRow> = new Map([
    [
      "F:foo",
      {
        nodeId: "F:foo",
        contentHash: "c0ffee",
        promptVersion: "1",
        modelId: "m",
        summaryText: "Greet the user by name.",
        createdAt: "2026-04-22T00:00:00.000Z",
      },
    ],
  ]);
  const handle = makeFakeStore({
    searchRows: [
      { nodeId: "F:foo", score: 2, filePath: "src/foo.ts", name: "foo", kind: "Function" },
    ],
    summaryRows,
  });
  const stdout = await captureStdout(async () => {
    await runQuery("foo", {}, hooksFor(handle, "/tmp/fake"));
  });
  assert.ok(stdout.includes("SUMMARY"), "SUMMARY column header must render when summaries present");
  assert.ok(stdout.includes("Greet the user by name."), "summary text must appear in the row");
});

test("cli query: text formatter suppresses SUMMARY column when no summary row exists", async () => {
  const handle = makeFakeStore({
    searchRows: [
      { nodeId: "F:foo", score: 2, filePath: "src/foo.ts", name: "foo", kind: "Function" },
    ],
  });
  const stdout = await captureStdout(async () => {
    await runQuery("foo", {}, hooksFor(handle, "/tmp/fake"));
  });
  assert.ok(
    !stdout.includes("SUMMARY"),
    "SUMMARY column must not render when no hit carries a summary",
  );
});

test("cli query: summary text is truncated to 120 chars in the text table", async () => {
  const longText = "x".repeat(500);
  const summaryRows: ReadonlyMap<string, SymbolSummaryRow> = new Map([
    [
      "F:foo",
      {
        nodeId: "F:foo",
        contentHash: "c0ffee",
        promptVersion: "1",
        modelId: "m",
        summaryText: longText,
        createdAt: "2026-04-22T00:00:00.000Z",
      },
    ],
  ]);
  const handle = makeFakeStore({
    searchRows: [
      { nodeId: "F:foo", score: 2, filePath: "src/foo.ts", name: "foo", kind: "Function" },
    ],
    summaryRows,
  });
  const stdout = await captureStdout(async () => {
    await runQuery("foo", {}, hooksFor(handle, "/tmp/fake"));
  });
  // Text formatter cap is 120 chars; the last row must not carry the full
  // 500-char body.
  assert.ok(!stdout.includes(longText), "full untruncated summary must not appear");
  assert.ok(stdout.includes("…"), "truncation ellipsis must mark the cap");
});

test("cli query: store without lookupSymbolSummariesByNode degrades silently", async () => {
  // When `summaryRows` is omitted, the fake store does not install the
  // lookup method — the CLI probe must short-circuit to an empty join
  // without throwing.
  const handle = makeFakeStore({
    searchRows: [
      { nodeId: "F:foo", score: 2, filePath: "src/foo.ts", name: "foo", kind: "Function" },
    ],
  });
  const stdout = await captureStdout(async () => {
    await runQuery("foo", { json: true }, hooksFor(handle, "/tmp/fake"));
  });
  const parsed = JSON.parse(stdout) as { results: Array<{ summary?: string }> };
  assert.equal(parsed.results[0]?.summary, undefined);
});
