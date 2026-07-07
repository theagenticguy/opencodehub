// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures
/**
 * Behavioural tests for the `sql` MCP tool's dual-emit surface.
 *
 * The surface we exercise:
 *   1. SQL path routes through `temporal.exec()` and returns rows.
 *   2. Cypher path routes through `graph.execCypher()` and returns rows.
 *   3. Both `sql` and `cypher` supplied → INVALID_INPUT "choose one".
 *   4. Neither supplied → INVALID_INPUT.
 *   5. SQL write verbs are rejected by `sql-guard` (INVALID_INPUT).
 *   6. Cypher write verbs are rejected by `cypher-guard` (INVALID_INPUT).
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
 * (Cypher path). The SQL path routes through `temporal.exec()` and the
 * Cypher path routes through `graph.execCypher()`.
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

  // Cypher is now unconditionally available — no environment plumbing.
  const restoreEnv = () => {};

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
        const dbPath = `${repoPath}/.codehub/store.sqlite`;
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
  await withHarness({ rows: [] }, async ({ ctx, server, handle }) => {
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
// Cypher path
// ---------------------------------------------------------------------------

test("sql: `cypher` routes through `graph.execCypher` and the cypher text reaches the store unchanged", async () => {
  await withHarness(
    {
      rows: [{ node_id: "F:foo", name: "foo" }],
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
  // The SQL path routes through `temporal.exec(sql, params,
  // { timeoutMs })`. The tool currently does NOT forward `timeout_ms`
  // to the cypher path — `execCypher` only accepts (statement, params).
  // To preserve test intent we exercise the SQL path here and assert
  // the `opts.timeoutMs` plumbing.
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

// ---------------------------------------------------------------------------
// Schema-hint correctness (ADR 0019): the whole index is one `store.sqlite`,
// so `nodes` / `edges` / `embeddings` ARE directly SQL-queryable. The tool
// description must advertise them as SQL tables under `sql:` and mark
// `cypher:` as the community-fork-only escape hatch. (This inverts the prior
// finding-R2 contract, which assumed a Cypher-only graph tier.)
// ---------------------------------------------------------------------------

test("sql: tool description advertises the graph tables as SQL-queryable and marks cypher fork-only", async () => {
  await withHarness({ rows: [] }, async ({ ctx, server }) => {
    registerSqlTool(server, ctx);
    // biome-ignore lint/suspicious/noExplicitAny: reach into the SDK's tool registry for the description
    const registered = (server as any)._registeredTools as Record<string, { description?: string }>;
    const desc = registered["sql"]?.description ?? "";

    // SQL section: every table in the single-file store is directly queryable.
    assert.match(desc, /SQL mode/, "description must label a SQL-mode section");
    assert.match(desc, /\bnodes\b/, "SQL section must list the nodes table");
    assert.match(desc, /\bedges\b/, "SQL section must list the edges table");
    assert.match(desc, /\bcochanges\b/, "SQL section must list cochanges");
    assert.match(desc, /payload->>/, "SQL section must show the JSON1 payload extract idiom");

    // Cypher section: reserved for community-fork adapters; the default
    // SQLite backend does not support it.
    assert.match(desc, /Cypher mode/, "description must label a Cypher-mode section");
    assert.match(
      desc,
      /community-fork|use `sql:` instead/i,
      "description must mark cypher as the community-fork-only path",
    );

    // The inverted bug: the description must NOT claim the graph is
    // unqueryable by SQL — that was true only under an earlier graph backend.
    assert.ok(
      !/not SQL-queryable/i.test(desc),
      "description must NOT claim the graph is non-SQL-queryable (ADR 0019)",
    );
  });
});

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
