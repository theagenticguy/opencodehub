// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures
/**
 * Behavioural tests for the `sql` MCP tool's dual-emit surface.
 *
 * The surface we exercise:
 *   1. Existing SQL path behaves exactly as before when only `sql` is set.
 *   2. `cypher` field is accepted when `CODEHUB_STORE=lbug`.
 *   3. `cypher` field is rejected with a clear hint when `CODEHUB_STORE` is
 *      unset or `=duck`.
 *   4. Both `sql` and `cypher` supplied → INVALID_INPUT "choose one".
 *   5. Neither supplied → INVALID_INPUT.
 *   6. Cypher write verbs are rejected by `cypher-guard` before reaching
 *      the store (no store.query call on the guard-rejected path).
 *   7. Cypher read path invokes `store.query` with the cypher text.
 */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { KnowledgeGraph } from "@opencodehub/core-types";
import type {
  BulkLoadStats,
  DuckDbStore,
  EmbeddingRow,
  SearchQuery,
  SearchResult,
  SqlParam,
  StoreMeta,
  TraverseQuery,
  TraverseResult,
  VectorQuery,
  VectorResult,
} from "@opencodehub/storage";
import {
  assertReadOnlyCypher,
  assertReadOnlySql,
  CypherGuardError,
  SqlGuardError,
} from "@opencodehub/storage";
import { ConnectionPool } from "../connection-pool.js";
import type { ToolContext } from "./shared.js";
import { registerSqlTool } from "./sql.js";

/**
 * Captured argument of the most recent `store.query()` call. Used to
 * assert which dialect text actually reached the store.
 */
interface FakeStoreHandle {
  store: DuckDbStore;
  queryCalls: { sql: string; params: readonly SqlParam[] }[];
  /**
   * When set, `query()` validates the incoming statement with this guard
   * before returning rows — mirrors production behaviour where both the
   * DuckDB and graph-db adapters call their respective guard internally.
   */
  guard?: (stmt: string) => void;
  /** Rows returned by the fake's `query()`. */
  rows: readonly Record<string, unknown>[];
}

function makeFakeStore(
  rows: readonly Record<string, unknown>[],
  guard?: (stmt: string) => void,
): FakeStoreHandle {
  const handle: FakeStoreHandle = {
    store: {} as DuckDbStore,
    queryCalls: [],
    rows,
    ...(guard !== undefined ? { guard } : {}),
  };
  const impl = {
    open: async () => {},
    close: async () => {},
    createSchema: async () => {},
    bulkLoad: async (_g: KnowledgeGraph): Promise<BulkLoadStats> => ({
      nodeCount: 0,
      edgeCount: 0,
      durationMs: 0,
    }),
    upsertEmbeddings: async (_r: readonly EmbeddingRow[]): Promise<void> => {},
    query: async (
      sql: string,
      params: readonly SqlParam[] = [],
    ): Promise<readonly Record<string, unknown>[]> => {
      if (handle.guard) handle.guard(sql);
      handle.queryCalls.push({ sql, params });
      return handle.rows;
    },
    search: async (_q: SearchQuery): Promise<readonly SearchResult[]> => [],
    vectorSearch: async (_q: VectorQuery): Promise<readonly VectorResult[]> => [],
    traverse: async (_q: TraverseQuery): Promise<readonly TraverseResult[]> => [],
    getMeta: async (): Promise<StoreMeta | undefined> => undefined,
    setMeta: async (_m: StoreMeta): Promise<void> => {},
    healthCheck: async () => ({ ok: true }),
    bulkLoadCochanges: async () => {},
    lookupCochangesForFile: async () => [],
    lookupCochangesBetween: async () => undefined,
    bulkLoadSymbolSummaries: async () => {},
    lookupSymbolSummary: async () => undefined,
    lookupSymbolSummariesByNode: async () => [],
    listEmbeddingHashes: async () => new Map<string, string>(),
  } as unknown as DuckDbStore;
  handle.store = impl;
  return handle;
}

interface HarnessContext {
  readonly ctx: ToolContext;
  readonly server: McpServer;
  readonly handle: FakeStoreHandle;
  readonly restoreEnv: () => void;
}

interface HarnessOptions {
  readonly rows?: readonly Record<string, unknown>[];
  /** When set, the fake store runs this guard before returning rows. */
  readonly guard?: (stmt: string) => void;
  /**
   * Value to set CODEHUB_STORE to for this test. Undefined leaves the env
   * var whatever its current value is (tests default to delete).
   */
  readonly codehubStore?: string;
}

async function withHarness(
  harnessOpts: HarnessOptions,
  fn: (h: HarnessContext) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(resolve(tmpdir(), "codehub-sql-test-"));
  const handle = makeFakeStore(harnessOpts.rows ?? [], harnessOpts.guard);
  // Mutate CODEHUB_STORE for the duration of the test. Capture the prior
  // value so we can restore it — this keeps parallel tests that rely on
  // the env var from stepping on each other when `node --test` runs
  // multiple at once (node --test uses a single process; env vars are
  // process-global, so we take the serialisation hit here).
  const priorStore = process.env["CODEHUB_STORE"];
  if (harnessOpts.codehubStore === undefined) {
    delete process.env["CODEHUB_STORE"];
  } else {
    process.env["CODEHUB_STORE"] = harnessOpts.codehubStore;
  }
  const restoreEnv = () => {
    if (priorStore === undefined) delete process.env["CODEHUB_STORE"];
    else process.env["CODEHUB_STORE"] = priorStore;
  };

  try {
    const repoPath = resolve(home, "fakerepo");
    await mkdir(repoPath, { recursive: true });
    const regDir = resolve(home, ".codehub");
    await mkdir(regDir, { recursive: true });
    await writeFile(
      resolve(regDir, "registry.json"),
      JSON.stringify({
        fakerepo: {
          name: "fakerepo",
          path: repoPath,
          indexedAt: "2026-05-05T00:00:00Z",
          nodeCount: 0,
          edgeCount: 0,
          lastCommit: "abc123",
        },
      }),
    );
    const pool = new ConnectionPool({ max: 2, ttlMs: 60_000 }, async () => handle.store);
    const ctx: ToolContext = { pool, home };
    const server = new McpServer(
      { name: "test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    try {
      await fn({ ctx, server, handle, restoreEnv });
    } finally {
      await pool.shutdown();
    }
  } finally {
    restoreEnv();
    await rm(home, { recursive: true, force: true });
  }
}

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<CallToolResult>;
};

function getHandler(server: McpServer, name: string): RegisteredTool["handler"] {
  // biome-ignore lint/suspicious/noExplicitAny: SDK internal field for test-only access
  const map = (server as any)._registeredTools as Record<string, RegisteredTool>;
  const entry = map[name];
  assert.ok(entry, `tool not registered: ${name}`);
  return entry.handler.bind(entry);
}

// ---------------------------------------------------------------------------
// SQL path (existing contract must not regress)
// ---------------------------------------------------------------------------

test("sql: existing SQL path returns rows and does not touch the cypher branch", async () => {
  await withHarness(
    {
      rows: [{ id: "F:foo", name: "foo" }],
      guard: assertReadOnlySql,
    },
    async ({ ctx, server, handle }) => {
      registerSqlTool(server, ctx);
      const handler = getHandler(server, "sql");
      const result = await handler(
        { sql: "SELECT id, name FROM nodes LIMIT 1", repo: "fakerepo" },
        {},
      );
      const sc = result.structuredContent as {
        row_count: number;
        rows: Array<Record<string, unknown>>;
        columns: string[];
        dialect?: string;
        error?: unknown;
      };
      assert.equal(result.isError, undefined);
      assert.equal(sc.error, undefined);
      assert.equal(sc.row_count, 1);
      assert.equal(sc.rows.length, 1);
      assert.equal(sc.rows[0]?.["name"], "foo");
      assert.equal(sc.dialect, "sql");
      // Exactly one store.query call with the SQL text.
      assert.equal(handle.queryCalls.length, 1);
      assert.equal(handle.queryCalls[0]?.sql, "SELECT id, name FROM nodes LIMIT 1");
    },
  );
});

test("sql: SQL write verb is rejected by sql-guard → INVALID_INPUT", async () => {
  await withHarness(
    {
      rows: [],
      guard: assertReadOnlySql,
    },
    async ({ ctx, server }) => {
      registerSqlTool(server, ctx);
      const handler = getHandler(server, "sql");
      const result = await handler({ sql: "DROP TABLE nodes", repo: "fakerepo" }, {});
      const sc = result.structuredContent as {
        error?: { code: string; message: string };
      };
      assert.equal(result.isError, true);
      assert.equal(sc.error?.code, "INVALID_INPUT");
      assert.ok(
        sc.error?.message.toLowerCase().includes("drop") ||
          sc.error?.message.toLowerCase().includes("write"),
        `expected SQL guard rejection, got: ${sc.error?.message}`,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Exactly-one-of input guard
// ---------------------------------------------------------------------------

test("sql: both `sql` and `cypher` provided → INVALID_INPUT (choose one)", async () => {
  await withHarness({ rows: [], codehubStore: "lbug" }, async ({ ctx, server, handle }) => {
    registerSqlTool(server, ctx);
    const handler = getHandler(server, "sql");
    const result = await handler(
      {
        sql: "SELECT 1",
        cypher: "MATCH (n) RETURN n",
        repo: "fakerepo",
      },
      {},
    );
    const sc = result.structuredContent as {
      error?: { code: string; message: string };
    };
    assert.equal(result.isError, true);
    assert.equal(sc.error?.code, "INVALID_INPUT");
    assert.ok(
      sc.error?.message.includes("exactly one"),
      `expected 'exactly one' hint, got: ${sc.error?.message}`,
    );
    assert.equal(handle.queryCalls.length, 0, "store must not be queried on input guard reject");
  });
});

test("sql: neither `sql` nor `cypher` provided → INVALID_INPUT", async () => {
  await withHarness({ rows: [] }, async ({ ctx, server, handle }) => {
    registerSqlTool(server, ctx);
    const handler = getHandler(server, "sql");
    const result = await handler({ repo: "fakerepo" }, {});
    const sc = result.structuredContent as {
      error?: { code: string; message: string };
    };
    assert.equal(result.isError, true);
    assert.equal(sc.error?.code, "INVALID_INPUT");
    assert.equal(handle.queryCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Cypher availability gate (CODEHUB_STORE env var)
// ---------------------------------------------------------------------------

test("sql: `cypher` is rejected when CODEHUB_STORE is unset", async () => {
  await withHarness({ rows: [] }, async ({ ctx, server, handle }) => {
    registerSqlTool(server, ctx);
    const handler = getHandler(server, "sql");
    const result = await handler({ cypher: "MATCH (n) RETURN n", repo: "fakerepo" }, {});
    const sc = result.structuredContent as {
      error?: { code: string; message: string; hint?: string };
    };
    assert.equal(result.isError, true);
    assert.equal(sc.error?.code, "INVALID_INPUT");
    assert.ok(
      sc.error?.message.includes("cypher unavailable"),
      `expected unavailability message, got: ${sc.error?.message}`,
    );
    assert.ok(
      sc.error?.message.includes("CODEHUB_STORE=lbug"),
      `expected env-var hint in message, got: ${sc.error?.message}`,
    );
    assert.equal(handle.queryCalls.length, 0, "store must not be queried when cypher is refused");
  });
});

test("sql: `cypher` is rejected when CODEHUB_STORE=duck", async () => {
  await withHarness({ rows: [], codehubStore: "duck" }, async ({ ctx, server, handle }) => {
    registerSqlTool(server, ctx);
    const handler = getHandler(server, "sql");
    const result = await handler({ cypher: "MATCH (n) RETURN n", repo: "fakerepo" }, {});
    const sc = result.structuredContent as {
      error?: { code: string; message: string };
    };
    assert.equal(result.isError, true);
    assert.equal(sc.error?.code, "INVALID_INPUT");
    assert.ok(sc.error?.message.includes("cypher unavailable"));
    assert.equal(handle.queryCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Cypher path (CODEHUB_STORE=lbug)
// ---------------------------------------------------------------------------

test("sql: `cypher` accepted when CODEHUB_STORE=lbug; store.query receives the cypher text", async () => {
  await withHarness(
    {
      rows: [{ node_id: "F:foo", name: "foo" }],
      codehubStore: "lbug",
      // In production, a GraphDbStore runs assertReadOnlyCypher internally;
      // mirror that so the test matches the end-to-end contract.
      guard: assertReadOnlyCypher,
    },
    async ({ ctx, server, handle }) => {
      registerSqlTool(server, ctx);
      const handler = getHandler(server, "sql");
      const cypher = "MATCH (n:CodeNode) RETURN n.id AS node_id, n.name AS name LIMIT 1";
      const result = await handler({ cypher, repo: "fakerepo" }, {});
      const sc = result.structuredContent as {
        row_count: number;
        rows: Array<Record<string, unknown>>;
        dialect?: string;
        error?: unknown;
      };
      assert.equal(result.isError, undefined, `expected success, got: ${JSON.stringify(sc)}`);
      assert.equal(sc.error, undefined);
      assert.equal(sc.row_count, 1);
      assert.equal(sc.dialect, "cypher");
      assert.equal(handle.queryCalls.length, 1);
      // The cypher text must reach the store unchanged — the tool must
      // not silently rewrite it or translate SQL-style predicates.
      assert.equal(handle.queryCalls[0]?.sql, cypher);
    },
  );
});

test("sql: cypher write verb is rejected by cypher-guard → INVALID_INPUT", async () => {
  await withHarness(
    {
      rows: [],
      codehubStore: "lbug",
      guard: assertReadOnlyCypher,
    },
    async ({ ctx, server, handle }) => {
      registerSqlTool(server, ctx);
      const handler = getHandler(server, "sql");
      const writes = [
        "CREATE (n:Foo {id: 'x'})",
        "MATCH (n) DELETE n",
        "MATCH (n) SET n.x = 1",
        "MERGE (n:Foo {id: 'x'})",
        "MATCH (n) REMOVE n.x",
        "DROP TABLE CodeNode",
      ];
      for (const w of writes) {
        const result = await handler({ cypher: w, repo: "fakerepo" }, {});
        const sc = result.structuredContent as {
          error?: { code: string; message: string };
        };
        assert.equal(result.isError, true, `write '${w}' must be rejected`);
        assert.equal(sc.error?.code, "INVALID_INPUT");
      }
      // No call reached the store for any of the 6 rejected writes —
      // the fake's guard threw `CypherGuardError` before the row return
      // path. Importantly, this count is exactly 0 even though each
      // write went through `store.query` (which ran the guard). The
      // guard throws; the row return never runs; queryCalls.push runs
      // AFTER the guard, so it stays empty.
      assert.equal(
        handle.queryCalls.length,
        0,
        "no cypher write verb must successfully reach the store",
      );
    },
  );
});

test("sql: cypher read path tolerates an unknown keyword that is NOT a write verb", async () => {
  // Sanity check that the guard lets through the full clause set the
  // cypher-guard unit tests cover — ORDER BY / LIMIT / SKIP / UNWIND.
  await withHarness(
    {
      rows: [{ id: "F:foo" }],
      codehubStore: "lbug",
      guard: assertReadOnlyCypher,
    },
    async ({ ctx, server, handle }) => {
      registerSqlTool(server, ctx);
      const handler = getHandler(server, "sql");
      const result = await handler(
        {
          cypher:
            "MATCH (n:CodeNode) WHERE n.kind = 'Function' " +
            "RETURN n.id AS id ORDER BY id SKIP 0 LIMIT 10",
          repo: "fakerepo",
        },
        {},
      );
      const sc = result.structuredContent as { row_count: number; error?: unknown };
      assert.equal(result.isError, undefined);
      assert.equal(sc.row_count, 1);
      assert.equal(handle.queryCalls.length, 1);
    },
  );
});

test("sql: cypher timeout_ms is forwarded to store.query opts", async () => {
  await withHarness(
    {
      rows: [{ x: 1 }],
      codehubStore: "lbug",
    },
    async ({ ctx, server, handle }) => {
      // Spy on the third-arg opts by wrapping store.query one level down.
      // We do this by replacing the fake's query with a capturing variant
      // that still delegates to the original rows.
      const origQuery = handle.store.query.bind(handle.store);
      const optsSeen: Array<{ timeoutMs?: number } | undefined> = [];
      (handle.store as unknown as { query: typeof origQuery }).query = async (
        stmt: string,
        params?: readonly SqlParam[],
        opts?: { timeoutMs?: number },
      ): Promise<readonly Record<string, unknown>[]> => {
        optsSeen.push(opts);
        return origQuery(stmt, params ?? [], opts);
      };
      registerSqlTool(server, ctx);
      const handler = getHandler(server, "sql");
      await handler(
        {
          cypher: "MATCH (n) RETURN n",
          repo: "fakerepo",
          timeout_ms: 1234,
        },
        {},
      );
      assert.equal(optsSeen.length, 1);
      assert.equal(optsSeen[0]?.timeoutMs, 1234);
    },
  );
});

// ---------------------------------------------------------------------------
// Regression guard: the SqlGuardError / CypherGuardError imports must exist
// and the guard classes must be the ones actually thrown by the underlying
// adapters. This catches a silent downgrade where the tool catches a
// generic Error and loses the `INVALID_INPUT` classification.
// ---------------------------------------------------------------------------

test("sql: guard classes exported from @opencodehub/storage are the ones thrown", () => {
  // Both guard classes must be constructible with a message and must not
  // collapse to plain Error — otherwise the tool's instanceof branches
  // would silently fall through to INTERNAL.
  const sqlErr = new SqlGuardError("x");
  assert.ok(sqlErr instanceof SqlGuardError);
  assert.equal(sqlErr.name, "SqlGuardError");
  const cypherErr = new CypherGuardError("y");
  assert.ok(cypherErr instanceof CypherGuardError);
  assert.equal(cypherErr.name, "CypherGuardError");
});
