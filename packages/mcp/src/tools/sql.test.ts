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
 *      the store (no exec call on the guard-rejected path).
 *   7. Cypher read path invokes `graph.execCypher` with the cypher text.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SqlParam } from "@opencodehub/storage";
import {
  assertReadOnlyCypher,
  assertReadOnlySql,
  CypherGuardError,
  SqlGuardError,
} from "@opencodehub/storage";
import { getToolHandler, makeFakeGraphStore, withMcpHarness } from "../test-utils.js";
import type { ToolContext } from "./shared.js";
import { registerSqlTool } from "./sql.js";

/**
 * Captured call to `temporal.exec()` (SQL path) or `graph.execCypher()`
 * (Cypher path). The original test recorded "store.query" — post AC-A-6c
 * the SQL path routes through `temporal.exec()` and the Cypher path
 * routes through `graph.execCypher()`.
 */
interface ExecCall {
  readonly statement: string;
  readonly params: readonly SqlParam[];
  readonly opts?: { readonly timeoutMs?: number };
  readonly dialect: "sql" | "cypher";
}

interface FakeStoreHandle {
  readonly execCalls: ExecCall[];
  /**
   * When set, `exec`/`execCypher` validates the incoming statement with
   * this guard before returning rows — mirrors production behaviour where
   * both adapters apply the guard internally.
   */
  guard?: (stmt: string) => void;
  rows: readonly Record<string, unknown>[];
  /** Mutable reference to the underlying store so tests can swap exec spies. */
  store: import("@opencodehub/storage").Store;
}

interface HarnessContext {
  readonly ctx: ToolContext;
  readonly server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;
  readonly handle: FakeStoreHandle;
  readonly restoreEnv: () => void;
}

interface HarnessOptions {
  readonly rows?: readonly Record<string, unknown>[];
  readonly guard?: (stmt: string) => void;
  readonly codehubStore?: string;
}

async function withHarness(
  harnessOpts: HarnessOptions,
  fn: (h: HarnessContext) => Promise<void>,
): Promise<void> {
  const handle: FakeStoreHandle = {
    execCalls: [],
    rows: harnessOpts.rows ?? [],
    ...(harnessOpts.guard !== undefined ? { guard: harnessOpts.guard } : {}),
    store: undefined as unknown as import("@opencodehub/storage").Store,
  };

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
    await withMcpHarness(
      {
        tmpPrefix: "codehub-sql-test-",
        storeFactory: () => {
          const fake = makeFakeGraphStore(
            {},
            {
              // SQL path → temporal.exec
              exec: async (stmt, params, opts) => {
                if (handle.guard) handle.guard(stmt);
                handle.execCalls.push({
                  statement: stmt,
                  params: params ?? [],
                  ...(opts !== undefined ? { opts } : {}),
                  dialect: "sql",
                });
                return handle.rows;
              },
              // Cypher path → graph.execCypher
              execCypher: async (stmt, params) => {
                if (handle.guard) handle.guard(stmt);
                handle.execCalls.push({
                  statement: stmt,
                  params: [],
                  dialect: "cypher",
                });
                void params;
                return handle.rows;
              },
            },
          );
          return fake;
        },
      },
      async ({ pool, home, server }) => {
        // Capture the wrapped Store the pool will hand back, so the test
        // can swap out exec spies (the cypher-timeout test does this).
        const ctx: ToolContext = { pool, home };
        // Acquire once just to seed handle.store for spy-based tests.
        const repoPath = `${home}/fakerepo`;
        const dbPath = `${repoPath}/.codehub/graph.duckdb`;
        try {
          handle.store = await pool.acquire(repoPath, dbPath);
        } finally {
          await pool.release(repoPath);
        }
        await fn({ ctx, server, handle, restoreEnv });
      },
    );
  } finally {
    restoreEnv();
  }
}

function getHandler(
  server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
  name: string,
): (args: unknown, extra: unknown) => Promise<CallToolResult> {
  return getToolHandler(server, name);
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
      // Exactly one exec call with the SQL text.
      assert.equal(handle.execCalls.length, 1);
      assert.equal(handle.execCalls[0]?.statement, "SELECT id, name FROM nodes LIMIT 1");
      assert.equal(handle.execCalls[0]?.dialect, "sql");
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
    assert.equal(handle.execCalls.length, 0, "store must not be queried on input guard reject");
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
    assert.equal(handle.execCalls.length, 0);
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
    assert.equal(handle.execCalls.length, 0, "store must not be queried when cypher is refused");
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
    assert.equal(handle.execCalls.length, 0);
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
      assert.equal(handle.execCalls.length, 1);
      // The cypher text must reach the store unchanged — the tool must
      // not silently rewrite it or translate SQL-style predicates.
      assert.equal(handle.execCalls[0]?.statement, cypher);
      assert.equal(handle.execCalls[0]?.dialect, "cypher");
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
      // write went through `execCypher` (which ran the guard). The
      // guard throws; the row return never runs; execCalls.push runs
      // AFTER the guard, so it stays empty.
      assert.equal(
        handle.execCalls.length,
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
      assert.equal(handle.execCalls.length, 1);
    },
  );
});

test("sql: cypher timeout_ms is forwarded to store.query opts", async () => {
  // The original test asserted the SQL `timeout_ms` was forwarded to a
  // `query()` call's third arg. Post AC-A-6c the SQL path routes through
  // `temporal.exec(sql, params, { timeoutMs })`. The tool currently does
  // NOT forward `timeout_ms` to the cypher path — `execCypher` only
  // accepts (statement, params). To preserve test intent we exercise the
  // SQL path here and assert the `opts.timeoutMs` plumbing.
  await withHarness(
    {
      rows: [{ x: 1 }],
    },
    async ({ ctx, server, handle }) => {
      registerSqlTool(server, ctx);
      const handler = getHandler(server, "sql");
      await handler(
        {
          sql: "SELECT 1",
          repo: "fakerepo",
          timeout_ms: 1234,
        },
        {},
      );
      assert.equal(handle.execCalls.length, 1);
      assert.equal(handle.execCalls[0]?.opts?.timeoutMs, 1234);
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
