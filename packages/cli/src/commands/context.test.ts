/**
 * Tests for `codehub context` CLI command.
 *
 * Covers:
 *   - External import-tracking stubs (`file_path = '<external>'`,
 *     `kind = 'CodeElement'`) never win the resolution.
 *   - Two same-named Functions fire the ambiguity branch.
 *   - `--target-uid` short-circuits to a direct id lookup.
 *   - Zero exact-name rows fall back to BM25 search.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  DuckDbStore,
  IGraphStore,
  SearchQuery,
  SearchResult,
  SqlParam,
  TraverseQuery,
  TraverseResult,
} from "@opencodehub/storage";
import { runContext } from "./context.js";

interface FakeNodeRow {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly filePath: string;
}

interface FakeStoreOptions {
  readonly rows?: readonly FakeNodeRow[];
  readonly searchRows?: readonly SearchResult[];
  readonly traverseUp?: readonly TraverseResult[];
  readonly traverseDown?: readonly TraverseResult[];
}

interface FakeStoreHandle {
  searchCalls: number;
  traverseCalls: number;
  closed: boolean;
  readonly store: IGraphStore;
}

function makeFakeStore(opts: FakeStoreOptions = {}): FakeStoreHandle {
  const rows = opts.rows ?? [];
  const searchRows = opts.searchRows ?? [];
  const traverseUp = opts.traverseUp ?? [];
  const traverseDown = opts.traverseDown ?? [];

  const handle: FakeStoreHandle = {
    searchCalls: 0,
    traverseCalls: 0,
    closed: false,
    store: {} as IGraphStore,
  };

  const impl = {
    query: async (
      sql: string,
      params: readonly SqlParam[] = [],
    ): Promise<readonly Record<string, unknown>[]> => {
      const normalized = sql.replace(/\s+/g, " ").trim();

      if (normalized.startsWith("SELECT id, name, kind, file_path FROM nodes WHERE id = ?")) {
        const id = String(params[0] ?? "");
        const hit = rows.find((r) => r.id === id);
        if (!hit) return [];
        return [{ id: hit.id, name: hit.name, kind: hit.kind, file_path: hit.filePath }];
      }

      if (normalized.startsWith("SELECT id, name, kind, file_path FROM nodes WHERE name = ?")) {
        const name = String(params[0] ?? "");
        let extra = params.slice(1).map((p) => String(p));
        let kindFilter: string | undefined;
        let pathFilter: string | undefined;
        if (normalized.includes("AND kind = ?")) {
          kindFilter = extra[0];
          extra = extra.slice(1);
        }
        if (normalized.includes("AND file_path LIKE ?")) {
          const raw = extra[0] ?? "";
          pathFilter = raw.replace(/^%/, "").replace(/%$/, "");
        }
        const matched = rows
          .filter((r) => r.name === name)
          .filter((r) => r.filePath !== "<external>" && r.kind !== "CodeElement")
          .filter((r) => (kindFilter === undefined ? true : r.kind === kindFilter))
          .filter((r) => (pathFilter === undefined ? true : r.filePath.includes(pathFilter)))
          .slice()
          .sort((a, b) => a.filePath.localeCompare(b.filePath));
        return matched.map((r) => ({
          id: r.id,
          name: r.name,
          kind: r.kind,
          file_path: r.filePath,
        }));
      }

      if (normalized.startsWith("SELECT DISTINCT p.id AS id")) {
        return [];
      }

      throw new Error(`unsupported sql in fake store: ${normalized}`);
    },
    search: async (_q: SearchQuery) => {
      handle.searchCalls += 1;
      return searchRows;
    },
    traverse: async (q: TraverseQuery): Promise<readonly TraverseResult[]> => {
      handle.traverseCalls += 1;
      return q.direction === "up" ? traverseUp : traverseDown;
    },
    close: async () => {
      handle.closed = true;
    },
  } as unknown as IGraphStore;

  (handle as { store: IGraphStore }).store = impl;
  return handle;
}

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

function hooksFor(handle: FakeStoreHandle, repoPath: string) {
  return {
    openStore: async () => ({ store: handle.store as unknown as DuckDbStore, repoPath }),
  };
}

test("cli context: exact-name picks Function over external stub", async () => {
  const handle = makeFakeStore({
    rows: [
      {
        id: "CodeElement:<external>:@opencodehub/foo:foo",
        name: "foo",
        kind: "CodeElement",
        filePath: "<external>",
      },
      {
        id: "Function:packages/x/src/y.ts:foo",
        name: "foo",
        kind: "Function",
        filePath: "packages/x/src/y.ts",
      },
    ],
  });
  const prevExit = process.exitCode;
  const stdout = await captureStdout(async () => {
    await runContext("foo", { json: true }, hooksFor(handle, "/tmp/fake"));
  });
  const parsed = JSON.parse(stdout) as {
    target: { nodeId: string; kind: string; filePath: string } | null;
    ambiguous?: boolean;
  };
  assert.equal(parsed.ambiguous, undefined, "single real row must not be ambiguous");
  assert.ok(parsed.target !== null, "target must resolve");
  assert.equal(parsed.target?.nodeId, "Function:packages/x/src/y.ts:foo");
  assert.equal(parsed.target?.kind, "Function");
  assert.equal(parsed.target?.filePath, "packages/x/src/y.ts");
  assert.equal(handle.searchCalls, 0, "BM25 fallback must not fire when exact-name resolves");
  assert.equal(handle.closed, true);
  process.exitCode = prevExit;
});

test("cli context: two same-named Functions surface the ambiguity path", async () => {
  const handle = makeFakeStore({
    rows: [
      {
        id: "Function:packages/a/src/f.ts:foo",
        name: "foo",
        kind: "Function",
        filePath: "packages/a/src/f.ts",
      },
      {
        id: "Function:packages/b/src/g.ts:foo",
        name: "foo",
        kind: "Function",
        filePath: "packages/b/src/g.ts",
      },
    ],
  });
  const prevExit = process.exitCode;
  let stdout = "";
  const warnings = await captureStderr(async () => {
    stdout = await captureStdout(async () => {
      await runContext("foo", { json: true }, hooksFor(handle, "/tmp/fake"));
    });
  });
  const parsed = JSON.parse(stdout) as {
    ambiguous?: boolean;
    candidates?: ReadonlyArray<{ nodeId: string }>;
  };
  assert.equal(parsed.ambiguous, true, "ambiguous flag must fire");
  assert.equal(parsed.candidates?.length, 2);
  assert.equal(process.exitCode, 1, "ambiguous path must set exit code 1");
  assert.equal(handle.traverseCalls, 0, "traverse must not run on ambiguity");
  assert.equal(warnings.length, 0, "JSON mode must not emit stderr candidate list");
  process.exitCode = prevExit;
});

test("cli context: --target-uid short-circuits to direct id lookup", async () => {
  const handle = makeFakeStore({
    rows: [
      {
        id: "Function:packages/x/src/y.ts:foo",
        name: "foo",
        kind: "Function",
        filePath: "packages/x/src/y.ts",
      },
      {
        id: "Function:packages/x/src/z.ts:foo",
        name: "foo",
        kind: "Function",
        filePath: "packages/x/src/z.ts",
      },
    ],
  });
  const prevExit = process.exitCode;
  const stdout = await captureStdout(async () => {
    await runContext(
      "foo",
      { json: true, targetUid: "Function:packages/x/src/z.ts:foo" },
      hooksFor(handle, "/tmp/fake"),
    );
  });
  const parsed = JSON.parse(stdout) as {
    target: { nodeId: string } | null;
    ambiguous?: boolean;
  };
  assert.equal(parsed.ambiguous, undefined);
  assert.equal(parsed.target?.nodeId, "Function:packages/x/src/z.ts:foo");
  process.exitCode = prevExit;
});

test("cli context: zero exact-name rows fall back to BM25 search", async () => {
  const handle = makeFakeStore({
    rows: [],
    searchRows: [
      {
        nodeId: "F:mcp-stdio-server",
        score: 4,
        filePath: "packages/mcp/src/server.ts",
        name: "mcpStdioServer",
        kind: "Function",
      },
      {
        nodeId: "F:mcp-runner",
        score: 2,
        filePath: "packages/mcp/src/runner.ts",
        name: "mcpRunner",
        kind: "Function",
      },
    ],
  });
  const prevExit = process.exitCode;
  const stdout = await captureStdout(async () => {
    await runContext("mcp stdio server", { json: true }, hooksFor(handle, "/tmp/fake"));
  });
  const parsed = JSON.parse(stdout) as {
    target: { nodeId: string } | null;
    alternateCandidates: ReadonlyArray<{ nodeId: string }>;
  };
  assert.equal(handle.searchCalls, 1, "BM25 fallback must fire when exact-name yields zero rows");
  assert.equal(parsed.target?.nodeId, "F:mcp-stdio-server");
  assert.equal(parsed.alternateCandidates.length, 1);
  assert.equal(parsed.alternateCandidates[0]?.nodeId, "F:mcp-runner");
  process.exitCode = prevExit;
});
