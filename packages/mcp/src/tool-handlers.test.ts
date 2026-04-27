// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures
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
import { assertReadOnlySql } from "@opencodehub/storage";
import { ConnectionPool } from "./connection-pool.js";
import { registerContextTool } from "./tools/context.js";
import { registerDependenciesTool } from "./tools/dependencies.js";
import { registerImpactTool } from "./tools/impact.js";
import { registerLicenseAuditTool } from "./tools/license-audit.js";
import { registerListReposTool } from "./tools/list-repos.js";
import { registerOwnersTool } from "./tools/owners.js";
import { registerProjectProfileTool } from "./tools/project-profile.js";
import { registerQueryTool } from "./tools/query.js";
import type { ToolContext } from "./tools/shared.js";
import { registerSqlTool } from "./tools/sql.js";

interface FakeCochangeRow {
  sourceFile: string;
  targetFile: string;
  cocommitCount: number;
  totalCommitsSource: number;
  totalCommitsTarget: number;
  lastCocommitAt: string;
  lift: number;
}

interface FakeStoreData {
  nodes: Array<Record<string, unknown>>;
  relations: Array<Record<string, unknown>>;
  cochanges?: FakeCochangeRow[];
  searchResults?: SearchResult[];
}

function makeFakeStore(data: FakeStoreData): DuckDbStore {
  const api = {
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
      // Guard runs first so the `sql` tool's INVALID_INPUT path works.
      assertReadOnlySql(sql);
      const text = sql.replace(/\s+/g, " ").trim();
      const projectNode = (n: Record<string, unknown>) => ({
        id: n["id"],
        name: n["name"],
        kind: n["kind"],
        file_path: n["file_path"],
      });

      // Analysis package: resolve-by-id lookup
      if (text.startsWith("SELECT id, name, file_path, kind FROM nodes WHERE id = ?")) {
        return data.nodes
          .filter((n) => n["id"] === (params[0] as string))
          .map(projectNode)
          .slice(0, 1);
      }
      // Analysis package: resolve-by-name lookup
      if (text.startsWith("SELECT id, name, file_path, kind FROM nodes WHERE name = ?")) {
        return data.nodes.filter((n) => n["name"] === (params[0] as string)).map(projectNode);
      }
      // Analysis package: bulk id hydration
      if (text.startsWith("SELECT id, name, file_path, kind FROM nodes WHERE id IN")) {
        const idSet = new Set(params as string[]);
        return data.nodes.filter((n) => idSet.has(String(n["id"]))).map(projectNode);
      }
      // Query tool: bulk id hydration with start_line/end_line.
      if (
        text.startsWith(
          "SELECT id, name, file_path, kind, start_line, end_line FROM nodes WHERE id IN",
        )
      ) {
        const idSet = new Set(params as string[]);
        return data.nodes
          .filter((n) => idSet.has(String(n["id"])))
          .map((n) => ({
            id: n["id"],
            name: n["name"],
            kind: n["kind"],
            file_path: n["file_path"],
            start_line: n["start_line"] ?? null,
            end_line: n["end_line"] ?? null,
          }));
      }
      // Analysis package: relation-record lookup (type + confidence + reason).
      // Params: first N placeholders are from ids, next M are to ids. We derive
      // N from the first `IN (…)` placeholder run so asymmetric splits work.
      if (text.startsWith("SELECT from_id, to_id, type, confidence, reason FROM relations")) {
        const inCounts = [...text.matchAll(/IN \(([?,\s]+)\)/g)].map(
          (m) => m[1]?.split(",").length ?? 0,
        );
        const fromCount = inCounts[0] ?? 0;
        const froms = new Set((params as string[]).slice(0, fromCount));
        const tos = new Set((params as string[]).slice(fromCount));
        return data.relations
          .filter((r) => froms.has(String(r["from_id"])) && tos.has(String(r["to_id"])))
          .map((r) => ({
            from_id: r["from_id"],
            to_id: r["to_id"],
            type: r["type"],
            confidence: r["confidence"],
            reason: r["reason"],
          }));
      }
      const projectContextNode = (n: Record<string, unknown>) => ({
        id: n["id"],
        name: n["name"],
        kind: n["kind"],
        file_path: n["file_path"],
        start_line: n["start_line"] ?? null,
        end_line: n["end_line"] ?? null,
        content: n["content"] ?? null,
      });
      // Context tool: uid-based direct lookup
      if (
        text.startsWith(
          "SELECT id, name, kind, file_path, start_line, end_line, content FROM nodes WHERE id = ?",
        )
      ) {
        const [id] = params as string[];
        return data.nodes
          .filter((n) => n["id"] === id)
          .slice(0, 1)
          .map(projectContextNode);
      }
      // Context tool: name-based lookup (with optional kind / file_path LIKE).
      // The SQL threads AND clauses through conditionally, so we detect them
      // from the text before peeling params off in the same order.
      if (
        text.startsWith(
          "SELECT id, name, kind, file_path, start_line, end_line, content FROM nodes WHERE name = ?",
        )
      ) {
        const hasKind = /AND kind = \?/.test(text);
        const hasFile = /AND file_path LIKE \?/.test(text);
        const name = String(params[0] ?? "");
        let pi = 1;
        const kindMaybe = hasKind ? String(params[pi++] ?? "") : "";
        const fileMaybe = hasFile ? String(params[pi++] ?? "") : "";
        return data.nodes
          .filter((n) => n["name"] === name)
          .filter((n) => !kindMaybe || n["kind"] === kindMaybe)
          .filter(
            (n) => !fileMaybe || String(n["file_path"] ?? "").includes(fileMaybe.replace(/%/g, "")),
          )
          .map(projectContextNode);
      }
      // Legacy context name-based lookup (kept for callers that still probe
      // without start_line/end_line/content).
      if (text.startsWith("SELECT id, name, kind, file_path FROM nodes WHERE name = ?")) {
        const hasKind = /AND kind = \?/.test(text);
        const hasFile = /AND file_path LIKE \?/.test(text);
        const name = String(params[0] ?? "");
        let pi = 1;
        const kindMaybe = hasKind ? String(params[pi++] ?? "") : "";
        const fileMaybe = hasFile ? String(params[pi++] ?? "") : "";
        return data.nodes
          .filter((n) => n["name"] === name)
          .filter((n) => !kindMaybe || n["kind"] === kindMaybe)
          .filter(
            (n) => !fileMaybe || String(n["file_path"] ?? "").includes(fileMaybe.replace(/%/g, "")),
          )
          .map(projectNode);
      }
      // Impact tool: name-probe
      if (text.startsWith("SELECT id FROM nodes WHERE name = ?")) {
        return data.nodes
          .filter((n) => n["name"] === (params[0] as string))
          .map((n) => ({ id: n["id"] }));
      }
      // Context tool: categorised-edges join (incoming or outgoing). The
      // IN (?, ?, …) placeholder list always matches CATEGORY_EDGE_TYPES in
      // the same order, so we extract the target id + the type list from
      // the first param + the rest.
      if (
        text.startsWith(
          "SELECT r.type AS rel_type, n.id, n.name, n.kind, n.file_path FROM relations",
        )
      ) {
        const targetId = String(params[0]);
        const types = new Set((params as string[]).slice(1));
        const direction: "incoming" | "outgoing" = text.includes("r.to_id = ?")
          ? "incoming"
          : "outgoing";
        return data.relations
          .filter((r) => {
            if (!types.has(String(r["type"]))) return false;
            if (direction === "incoming") return r["to_id"] === targetId;
            return r["from_id"] === targetId;
          })
          .map((r) => {
            const partnerId = direction === "incoming" ? r["from_id"] : r["to_id"];
            const node = data.nodes.find((n) => n["id"] === partnerId) ?? {};
            return {
              rel_type: r["type"],
              id: node["id"],
              name: node["name"],
              kind: node["kind"],
              file_path: node["file_path"],
            };
          });
      }
      // Context tool: HANDLES_ROUTE linkage (Operation → Route)
      if (text.includes("r.type = 'HANDLES_ROUTE'") && text.includes("n.kind = 'Operation'")) {
        const routeId = params[0];
        return data.relations
          .filter((r) => r["type"] === "HANDLES_ROUTE" && r["to_id"] === routeId)
          .map((r) => {
            const op = data.nodes.find((n) => n["id"] === r["from_id"]) ?? {};
            return {
              id: op["id"],
              file_path: op["file_path"],
              http_method: op["http_method"],
              http_path: op["http_path"],
              summary: op["summary"],
              operation_id: op["operation_id"],
            };
          });
      }
      // Context tool: owner lookup via HAS_METHOD / HAS_PROPERTY / CONTAINS
      // pointing at the target.
      if (
        text.includes("r.type IN ('HAS_METHOD','HAS_PROPERTY','CONTAINS')") &&
        text.includes("r.to_id = ?")
      ) {
        const id = params[0];
        return data.relations
          .filter(
            (r) =>
              (r["type"] === "HAS_METHOD" ||
                r["type"] === "HAS_PROPERTY" ||
                r["type"] === "CONTAINS") &&
              r["to_id"] === id,
          )
          .map((r) => {
            const src = data.nodes.find((n) => n["id"] === r["from_id"]) ?? {};
            return projectNode(src);
          });
      }
      if (text.includes("SELECT n.id, n.name, n.kind, n.file_path FROM relations")) {
        return [];
      }
      if (text.includes("SELECT DISTINCT p.id")) {
        return [];
      }
      // Context tool: confidence-breakdown edge aggregation query. Cochange
      // rows no longer sit in `relations`, so the allowed set excludes it.
      if (
        text.startsWith("SELECT confidence, reason FROM relations") &&
        text.includes("from_id = ? OR to_id = ?") &&
        text.includes("type IN")
      ) {
        const targetId = params[0];
        // The first two params are (targetId, targetId); the remaining are
        // the allowed relation types. Build the set from the tail so the
        // fake matches whatever list the tool passes today.
        const allowed = new Set((params as string[]).slice(2));
        return data.relations
          .filter(
            (r) =>
              (r["from_id"] === targetId || r["to_id"] === targetId) &&
              allowed.has(String(r["type"])),
          )
          .map((r) => ({ confidence: r["confidence"], reason: r["reason"] }));
      }
      // dependencies tool: flat SELECT over Dependency columns.
      if (
        text.startsWith(
          "SELECT id, name, file_path, version, license, lockfile_source, ecosystem FROM nodes WHERE kind = 'Dependency'",
        )
      ) {
        let rows = data.nodes.filter((n) => n["kind"] === "Dependency");
        // Consume LIKE / ecosystem params from the front of the params list
        // in the same order the tool appends them.
        let pi = 0;
        if (text.includes("file_path LIKE")) {
          const pattern = String(params[pi] ?? "").replace(/%/g, "");
          pi += 1;
          rows = rows.filter((n) => String(n["file_path"] ?? "").includes(pattern));
        }
        if (text.includes("ecosystem = ?")) {
          const ecoMatch = String(params[pi] ?? "");
          pi += 1;
          rows = rows.filter((n) => n["ecosystem"] === ecoMatch);
        }
        return rows.map((n) => ({
          id: n["id"],
          name: n["name"],
          file_path: n["file_path"],
          version: n["version"],
          license: n["license"],
          lockfile_source: n["lockfile_source"],
          ecosystem: n["ecosystem"],
        }));
      }
      // owners tool: join relations + nodes for OWNED_BY contributors.
      if (
        text.includes("SELECT c.email_hash AS email_hash") &&
        text.includes("FROM relations r JOIN nodes c")
      ) {
        const fromId = String(params[0] ?? "");
        const matches: Array<Record<string, unknown>> = [];
        for (const rel of data.relations) {
          if (String(rel["from_id"]) !== fromId) continue;
          if (String(rel["type"]) !== "OWNED_BY") continue;
          const contrib = data.nodes.find((n) => n["id"] === rel["to_id"]);
          if (!contrib || contrib["kind"] !== "Contributor") continue;
          matches.push({
            email_hash: contrib["email_hash"] ?? "",
            email_plain: contrib["email_plain"] ?? "",
            name: contrib["name"] ?? "",
            weight: typeof rel["confidence"] === "number" ? (rel["confidence"] as number) : 0,
          });
        }
        matches.sort((a, b) => {
          const aw = Number(a["weight"] ?? 0);
          const bw = Number(b["weight"] ?? 0);
          if (aw !== bw) return bw - aw;
          return String(a["email_hash"]).localeCompare(String(b["email_hash"]));
        });
        return matches;
      }
      // license_audit tool: select every Dependency row with all license columns.
      if (
        text.startsWith("SELECT id, name, version, license, lockfile_source, ecosystem, file_path")
      ) {
        return data.nodes
          .filter((n) => n["kind"] === "Dependency")
          .map((n) => ({
            id: n["id"],
            name: n["name"],
            version: n["version"],
            license: n["license"],
            lockfile_source: n["lockfile_source"],
            ecosystem: n["ecosystem"],
            file_path: n["file_path"],
          }));
      }
      // project_profile tool: select columns from the ProjectProfile row.
      if (text.startsWith("SELECT languages_json, frameworks_json")) {
        const row = data.nodes.find((n) => n["kind"] === "ProjectProfile");
        if (!row) return [];
        return [
          {
            languages_json: row["languages_json"] ?? "[]",
            frameworks_json: row["frameworks_json"] ?? "[]",
            iac_types_json: row["iac_types_json"] ?? "[]",
            api_contracts_json: row["api_contracts_json"] ?? "[]",
            manifests_json: row["manifests_json"] ?? "[]",
            src_dirs_json: row["src_dirs_json"] ?? "[]",
          },
        ];
      }
      if (text === "SELECT 1 AS one") {
        return [{ one: 1 }];
      }
      if (/^SELECT \* FROM NODES LIMIT/i.test(text)) {
        return data.nodes.slice(0, 5);
      }
      if (/^SELECT/i.test(text)) {
        return [];
      }
      throw new Error(`unsupported sql in fake store: ${text}`);
    },
    search: async (q: SearchQuery): Promise<readonly SearchResult[]> => {
      if (data.searchResults) return data.searchResults;
      return data.nodes
        .filter((n) =>
          String(n["name"] ?? "")
            .toLowerCase()
            .includes(q.text.toLowerCase()),
        )
        .slice(0, q.limit ?? 50)
        .map((n) => ({
          nodeId: String(n["id"]),
          name: String(n["name"]),
          kind: String(n["kind"]),
          filePath: String(n["file_path"]),
          score: 1,
        }));
    },
    vectorSearch: async (_q: VectorQuery): Promise<readonly VectorResult[]> => [],
    traverse: async (q: TraverseQuery): Promise<readonly TraverseResult[]> => {
      // Very tiny BFS over the in-memory relations table.
      const out: TraverseResult[] = [];
      const visited = new Set<string>([q.startId]);
      let frontier: string[] = [q.startId];
      for (let depth = 1; depth <= q.maxDepth; depth += 1) {
        const next: string[] = [];
        for (const id of frontier) {
          const edges = data.relations.filter((r) => {
            if (q.direction === "up") return r["to_id"] === id;
            if (q.direction === "down") return r["from_id"] === id;
            return r["from_id"] === id || r["to_id"] === id;
          });
          for (const edge of edges) {
            const other = q.direction === "up" ? edge["from_id"] : edge["to_id"];
            const otherId = String(other);
            if (visited.has(otherId)) continue;
            visited.add(otherId);
            out.push({ nodeId: otherId, depth, path: [q.startId, otherId] });
            next.push(otherId);
          }
        }
        frontier = next;
      }
      return out;
    },
    getMeta: async (): Promise<StoreMeta | undefined> => undefined,
    setMeta: async (_m: StoreMeta): Promise<void> => {},
    healthCheck: async () => ({ ok: true }),
    bulkLoadCochanges: async (_rows: readonly unknown[]): Promise<void> => {},
    lookupCochangesForFile: async (
      file: string,
      opts: { limit?: number; minLift?: number } = {},
    ): Promise<readonly FakeCochangeRow[]> => {
      const rows = data.cochanges ?? [];
      const minLift = opts.minLift ?? 1.0;
      const limit = opts.limit ?? 10;
      return rows
        .filter((r) => (r.sourceFile === file || r.targetFile === file) && r.lift >= minLift)
        .slice()
        .sort((a, b) => b.lift - a.lift)
        .slice(0, limit);
    },
    lookupCochangesBetween: async (
      fileA: string,
      fileB: string,
    ): Promise<FakeCochangeRow | undefined> => {
      const rows = data.cochanges ?? [];
      return rows.find(
        (r) =>
          (r.sourceFile === fileA && r.targetFile === fileB) ||
          (r.sourceFile === fileB && r.targetFile === fileA),
      );
    },
  } as unknown as DuckDbStore;
  return api;
}

async function withTestHarness(
  data: FakeStoreData,
  fn: (ctx: ToolContext, server: McpServer) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(resolve(tmpdir(), "codehub-mcp-harness-"));
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
          indexedAt: "2026-04-18T00:00:00Z",
          nodeCount: data.nodes.length,
          edgeCount: data.relations.length,
          lastCommit: "abc123",
        },
      }),
    );
    const pool = new ConnectionPool({ max: 2, ttlMs: 60_000 }, async () => makeFakeStore(data));
    const ctx: ToolContext = { pool, home };
    const server = new McpServer(
      { name: "test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    try {
      await fn(ctx, server);
    } finally {
      await pool.shutdown();
    }
  } finally {
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

test("list_repos surfaces the registry entry", async () => {
  await withTestHarness({ nodes: [], relations: [] }, async (ctx, server) => {
    registerListReposTool(server, ctx);
    const handler = getHandler(server, "list_repos");
    const result = await handler({}, {});
    const first = result.content[0];
    assert.ok(first && first.type === "text");
    assert.match(first.text, /fakerepo/);
    const sc = result.structuredContent as { repos: Array<{ name: string }> };
    assert.equal(sc.repos.length, 1);
    assert.equal(sc.repos[0]?.name, "fakerepo");
  });
});

test("query routes BM25 hits through the store", async () => {
  await withTestHarness(
    {
      nodes: [
        { id: "F:foo", name: "foo", kind: "Function", file_path: "src/foo.ts" },
        { id: "F:bar", name: "bar", kind: "Function", file_path: "src/bar.ts" },
      ],
      relations: [],
    },
    async (ctx, server) => {
      registerQueryTool(server, ctx);
      const handler = getHandler(server, "query");
      const result = await handler({ query: "foo", repo: "fakerepo" }, {});
      const sc = result.structuredContent as {
        results: Array<{ name: string }>;
        processes: unknown[];
        next_steps: string[];
      };
      assert.equal(sc.results.length, 1);
      assert.equal(sc.results[0]?.name, "foo");
      assert.deepEqual(sc.processes, []);
      assert.ok(sc.next_steps.length > 0);
    },
  );
});

test("context returns candidates on an ambiguous name", async () => {
  await withTestHarness(
    {
      nodes: [
        { id: "F:auth:1", name: "auth", kind: "Function", file_path: "src/a.ts" },
        { id: "F:auth:2", name: "auth", kind: "Function", file_path: "src/b.ts" },
      ],
      relations: [],
    },
    async (ctx, server) => {
      registerContextTool(server, ctx);
      const handler = getHandler(server, "context");
      const result = await handler({ symbol: "auth", repo: "fakerepo" }, {});
      const sc = result.structuredContent as {
        target: unknown;
        candidates: Array<{ filePath: string }>;
      };
      assert.equal(sc.target, null);
      assert.equal(sc.candidates.length, 2);
      const first = result.content[0];
      assert.ok(first && first.type === "text");
      assert.match(first.text, /ambiguous/);
    },
  );
});

test("context returns a full view on a single match", async () => {
  await withTestHarness(
    {
      nodes: [
        { id: "F:foo", name: "foo", kind: "Function", file_path: "src/foo.ts" },
        { id: "F:caller", name: "caller", kind: "Function", file_path: "src/c.ts" },
      ],
      relations: [
        {
          id: "E:1",
          from_id: "F:caller",
          to_id: "F:foo",
          type: "CALLS",
          confidence: 0.9,
        },
      ],
    },
    async (ctx, server) => {
      registerContextTool(server, ctx);
      const handler = getHandler(server, "context");
      const result = await handler({ symbol: "foo", repo: "fakerepo" }, {});
      const sc = result.structuredContent as {
        target: { id: string };
        callers: Array<{ name: string }>;
        callees: unknown[];
      };
      assert.equal(sc.target.id, "F:foo");
      assert.equal(sc.callers.length, 1);
      assert.equal(sc.callers[0]?.name, "caller");
    },
  );
});

test("context surfaces linked OpenAPI operations for a Route target", async () => {
  await withTestHarness(
    {
      nodes: [
        {
          id: "Route:src/server.ts:GET:/users/:id",
          name: "GET /users/:id",
          kind: "Route",
          file_path: "src/server.ts",
          url: "/users/:id",
          method: "GET",
        },
        {
          id: "Operation:openapi.yaml:GET:/users/{id}",
          name: "GET /users/{id}",
          kind: "Operation",
          file_path: "openapi.yaml",
          http_method: "GET",
          http_path: "/users/{id}",
          summary: "fetch one user",
          operation_id: "getUser",
        },
      ],
      relations: [
        {
          id: "E:op-route",
          from_id: "Operation:openapi.yaml:GET:/users/{id}",
          to_id: "Route:src/server.ts:GET:/users/:id",
          type: "HANDLES_ROUTE",
          confidence: 0.95,
          reason: "openapi-spec",
        },
      ],
    },
    async (ctx, server) => {
      registerContextTool(server, ctx);
      const handler = getHandler(server, "context");
      const result = await handler({ symbol: "GET /users/:id", repo: "fakerepo" }, {});
      const sc = result.structuredContent as {
        target: { id: string; kind: string };
        operations: Array<{
          method: string;
          path: string;
          summary?: string;
          operationId?: string;
          filePath: string;
        }>;
      };
      assert.equal(sc.target.kind, "Route");
      assert.equal(sc.operations.length, 1);
      const op = sc.operations[0];
      assert.ok(op);
      assert.equal(op.method, "GET");
      assert.equal(op.path, "/users/{id}");
      assert.equal(op.summary, "fetch one user");
      assert.equal(op.operationId, "getUser");
      assert.equal(op.filePath, "openapi.yaml");
      const first = result.content[0];
      assert.ok(first && first.type === "text");
      assert.match(first.text, /OpenAPI operations \(1\)/);
      assert.match(first.text, /GET \/users\/\{id\} \(getUser\)/);
    },
  );
});

test("context surfaces cochanges section from dedicated cochanges table", async () => {
  await withTestHarness(
    {
      nodes: [
        { id: "File:src/a.ts:src/a.ts", name: "src/a.ts", kind: "File", file_path: "src/a.ts" },
      ],
      relations: [],
      cochanges: [
        {
          sourceFile: "src/a.ts",
          targetFile: "src/b.ts",
          cocommitCount: 5,
          totalCommitsSource: 8,
          totalCommitsTarget: 6,
          lastCocommitAt: "2026-04-01T00:00:00.000Z",
          lift: 3.4,
        },
        {
          sourceFile: "src/a.ts",
          targetFile: "src/c.ts",
          cocommitCount: 2,
          totalCommitsSource: 8,
          totalCommitsTarget: 10,
          lastCocommitAt: "2026-02-01T00:00:00.000Z",
          lift: 1.5,
        },
      ],
    },
    async (ctx, server) => {
      registerContextTool(server, ctx);
      const handler = getHandler(server, "context");
      const result = await handler({ symbol: "src/a.ts", repo: "fakerepo" }, {});
      const sc = result.structuredContent as {
        target: { id: string };
        cochanges: Array<{
          file: string;
          cocommitCount: number;
          lift: number;
          lastCocommitAt: string;
        }>;
      };
      assert.equal(sc.target.id, "File:src/a.ts:src/a.ts");
      assert.equal(sc.cochanges.length, 2);
      // Strongest lift ranks first.
      assert.equal(sc.cochanges[0]?.file, "src/b.ts");
      assert.equal(sc.cochanges[0]?.lift, 3.4);
      assert.equal(sc.cochanges[0]?.cocommitCount, 5);
      assert.equal(sc.cochanges[1]?.file, "src/c.ts");
      const first = result.content[0];
      assert.ok(first && first.type === "text");
      assert.match(first.text, /Files often edited together with this one/);
      assert.match(first.text, /git history, NOT call dependencies/);
    },
  );
});

test("context resolves cochanges for a symbol via its enclosing file", async () => {
  await withTestHarness(
    {
      nodes: [{ id: "F:foo", name: "foo", kind: "Function", file_path: "src/a.ts" }],
      relations: [],
      cochanges: [
        {
          sourceFile: "src/a.ts",
          targetFile: "src/b.ts",
          cocommitCount: 3,
          totalCommitsSource: 4,
          totalCommitsTarget: 4,
          lastCocommitAt: "2026-03-01T00:00:00.000Z",
          lift: 2.1,
        },
      ],
    },
    async (ctx, server) => {
      registerContextTool(server, ctx);
      const handler = getHandler(server, "context");
      const result = await handler({ symbol: "foo", repo: "fakerepo" }, {});
      const sc = result.structuredContent as {
        target: { id: string };
        cochanges: Array<{ file: string }>;
      };
      assert.equal(sc.target.id, "F:foo");
      assert.equal(sc.cochanges.length, 1);
      assert.equal(sc.cochanges[0]?.file, "src/b.ts");
    },
  );
});

test("context omits cochanges section when the cochanges table is empty", async () => {
  await withTestHarness(
    {
      nodes: [{ id: "F:foo", name: "foo", kind: "Function", file_path: "src/a.ts" }],
      relations: [],
    },
    async (ctx, server) => {
      registerContextTool(server, ctx);
      const handler = getHandler(server, "context");
      const result = await handler({ symbol: "foo", repo: "fakerepo" }, {});
      const sc = result.structuredContent as { cochanges: unknown[] };
      assert.equal(sc.cochanges.length, 0);
      const first = result.content[0];
      assert.ok(first && first.type === "text");
      assert.doesNotMatch(first.text, /Files often edited together/);
    },
  );
});

test("impact drives the analysis package and groups by depth", async () => {
  await withTestHarness(
    {
      nodes: [
        { id: "F:foo", name: "foo", kind: "Function", file_path: "src/foo.ts" },
        { id: "F:a", name: "a", kind: "Function", file_path: "src/a.ts" },
        { id: "F:b", name: "b", kind: "Function", file_path: "src/b.ts" },
      ],
      relations: [
        { id: "E:1", from_id: "F:a", to_id: "F:foo", type: "CALLS", confidence: 0.9 },
        { id: "E:2", from_id: "F:b", to_id: "F:a", type: "CALLS", confidence: 0.9 },
      ],
    },
    async (ctx, server) => {
      registerImpactTool(server, ctx);
      const handler = getHandler(server, "impact");
      const result = await handler(
        { target: "F:foo", direction: "upstream", maxDepth: 3, repo: "fakerepo" },
        {},
      );
      const sc = result.structuredContent as {
        risk: string;
        byDepth: Record<string, unknown[]>;
        impactedCount: number;
        affected_processes: unknown[];
        affected_modules: unknown[];
        ambiguous: boolean;
        cochanges: unknown[];
      };
      assert.equal(sc.ambiguous, false);
      assert.ok(sc.byDepth && typeof sc.byDepth === "object");
      assert.ok(!Array.isArray(sc.byDepth), "byDepth is a depth → nodes map, not an array");
      assert.ok(Array.isArray(sc.affected_processes));
      assert.ok(Array.isArray(sc.affected_modules));
      assert.equal(typeof sc.impactedCount, "number");
      assert.ok(["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(sc.risk));
      assert.deepEqual(sc.cochanges, []);
    },
  );
});

test("impact surfaces cochanges for the target's file as a side section", async () => {
  await withTestHarness(
    {
      nodes: [{ id: "F:foo", name: "foo", kind: "Function", file_path: "src/foo.ts" }],
      relations: [],
      cochanges: [
        {
          sourceFile: "src/foo.ts",
          targetFile: "src/bar.ts",
          cocommitCount: 7,
          totalCommitsSource: 9,
          totalCommitsTarget: 10,
          lastCocommitAt: "2026-04-10T00:00:00.000Z",
          lift: 2.9,
        },
      ],
    },
    async (ctx, server) => {
      registerImpactTool(server, ctx);
      const handler = getHandler(server, "impact");
      const result = await handler({ target: "F:foo", repo: "fakerepo" }, {});
      const sc = result.structuredContent as {
        cochanges: Array<{ file: string; lift: number }>;
        byDepth: Record<string, Array<{ filePath?: string }>>;
      };
      assert.equal(sc.cochanges.length, 1);
      assert.equal(sc.cochanges[0]?.file, "src/bar.ts");
      assert.equal(sc.cochanges[0]?.lift, 2.9);
      // Cochanges are a side section — they must NOT appear in impactedNodes.
      for (const nodes of Object.values(sc.byDepth)) {
        for (const n of nodes) {
          assert.notEqual(n.filePath, "src/bar.ts");
        }
      }
      const first = result.content[0];
      assert.ok(first && first.type === "text");
      assert.match(first.text, /git history, NOT call dependencies/);
    },
  );
});

test("context: confidenceBreakdown tallies LSP-confirmed vs heuristic vs demoted edges", async () => {
  await withTestHarness(
    {
      nodes: [
        { id: "F:foo", name: "foo", kind: "Function", file_path: "src/foo.ts" },
        { id: "F:lsp", name: "lsp", kind: "Function", file_path: "src/lsp.ts" },
        { id: "F:heur", name: "heur", kind: "Function", file_path: "src/heur.ts" },
        { id: "F:demoted", name: "demoted", kind: "Function", file_path: "src/demoted.ts" },
      ],
      relations: [
        {
          id: "E:lsp",
          from_id: "F:lsp",
          to_id: "F:foo",
          type: "CALLS",
          confidence: 1.0,
          reason: "scip:scip-python@0.6.6",
        },
        {
          id: "E:heur",
          from_id: "F:heur",
          to_id: "F:foo",
          type: "CALLS",
          confidence: 0.5,
          reason: "heuristic/tier-2",
        },
        {
          id: "E:demoted",
          from_id: "F:demoted",
          to_id: "F:foo",
          type: "CALLS",
          confidence: 0.2,
          reason: "heuristic/tier-2+scip-unconfirmed",
        },
      ],
    },
    async (ctx, server) => {
      registerContextTool(server, ctx);
      const handler = getHandler(server, "context");
      const result = await handler({ symbol: "foo", repo: "fakerepo" }, {});
      const sc = result.structuredContent as {
        target: { id: string };
        confidenceBreakdown: { confirmed: number; heuristic: number; unknown: number };
      };
      assert.equal(sc.target.id, "F:foo");
      assert.deepEqual(sc.confidenceBreakdown, {
        confirmed: 1,
        heuristic: 1,
        unknown: 1,
      });
      // Confirm the breakdown is surfaced in the rendered text too.
      const first = result.content[0];
      assert.ok(first && first.type === "text");
      assert.match(first.text, /Confidence: 1 confirmed, 1 heuristic, 1 unknown/);
    },
  );
});

test("impact: confidenceBreakdown tallies each traversed edge by provenance tier", async () => {
  await withTestHarness(
    {
      nodes: [
        { id: "F:foo", name: "foo", kind: "Function", file_path: "src/foo.ts" },
        { id: "F:lsp", name: "lsp", kind: "Function", file_path: "src/lsp.ts" },
        { id: "F:heur", name: "heur", kind: "Function", file_path: "src/heur.ts" },
        { id: "F:demoted", name: "demoted", kind: "Function", file_path: "src/demoted.ts" },
      ],
      relations: [
        {
          id: "E:lsp",
          from_id: "F:lsp",
          to_id: "F:foo",
          type: "CALLS",
          confidence: 1.0,
          reason: "scip:scip-typescript@0.4.0",
        },
        {
          id: "E:heur",
          from_id: "F:heur",
          to_id: "F:foo",
          type: "CALLS",
          confidence: 0.5,
          reason: "heuristic/tier-2",
        },
        {
          id: "E:demoted",
          from_id: "F:demoted",
          to_id: "F:foo",
          type: "CALLS",
          // This edge is exactly at the `unknown` ceiling (0.2) — the
          // breakdown tiering logic classifies it alongside the two higher-
          // confidence siblings, which is the whole point of the feature:
          // even when the demoted edge makes it into the blast radius, the
          // agent can see it is unconfirmed and treat the risk band as a
          // lower bound. The fake `traverse()` doesn't filter by
          // minConfidence, so all three edges reach the aggregator.
          confidence: 0.2,
          reason: "heuristic/tier-2+scip-unconfirmed",
        },
      ],
    },
    async (ctx, server) => {
      registerImpactTool(server, ctx);
      const handler = getHandler(server, "impact");
      const result = await handler(
        {
          target: "foo",
          direction: "upstream",
          maxDepth: 2,
          minConfidence: 0.1,
          repo: "fakerepo",
        },
        {},
      );
      const sc = result.structuredContent as {
        risk: string;
        ambiguous: boolean;
        confidenceBreakdown: { confirmed: number; heuristic: number; unknown: number };
      };
      assert.equal(sc.ambiguous, false);
      assert.deepEqual(sc.confidenceBreakdown, {
        confirmed: 1,
        heuristic: 1,
        unknown: 1,
      });
      // Confirm the breakdown is surfaced in the rendered text too.
      const first = result.content[0];
      assert.ok(first && first.type === "text");
      assert.match(first.text, /Confidence: 1 confirmed, 1 heuristic, 1 unknown/);
    },
  );
});

test("sql rejects writes via the guard and returns INVALID_INPUT", async () => {
  await withTestHarness({ nodes: [], relations: [] }, async (ctx, server) => {
    registerSqlTool(server, ctx);
    const handler = getHandler(server, "sql");
    const result = await handler({ sql: "DROP TABLE nodes", repo: "fakerepo" }, {});
    assert.equal(result.isError, true);
    const sc = result.structuredContent as { error: { code: string } };
    assert.equal(sc.error.code, "INVALID_INPUT");
  });
});

test("sql renders markdown table on a SELECT", async () => {
  await withTestHarness(
    {
      nodes: [{ id: "F:foo", name: "foo", kind: "Function", file_path: "src/foo.ts" }],
      relations: [],
    },
    async (ctx, server) => {
      registerSqlTool(server, ctx);
      const handler = getHandler(server, "sql");
      const result = await handler({ sql: "SELECT * FROM nodes LIMIT 5", repo: "fakerepo" }, {});
      const first = result.content[0];
      assert.ok(first && first.type === "text");
      assert.match(first.text, /\|\s*id\s*\|/);
    },
  );
});

test("project_profile returns the stored ProjectProfile arrays", async () => {
  await withTestHarness(
    {
      nodes: [
        {
          id: "ProjectProfile::abc123",
          name: "project-profile",
          kind: "ProjectProfile",
          file_path: "",
          languages_json: JSON.stringify(["typescript", "python"]),
          frameworks_json: JSON.stringify(["django", "nextjs"]),
          iac_types_json: JSON.stringify(["docker", "terraform"]),
          api_contracts_json: JSON.stringify(["openapi"]),
          manifests_json: JSON.stringify(["package.json", "pyproject.toml"]),
          src_dirs_json: JSON.stringify(["backend/src", "src"]),
        },
      ],
      relations: [],
    },
    async (ctx, server) => {
      registerProjectProfileTool(server, ctx);
      const handler = getHandler(server, "project_profile");
      const result = await handler({ repo: "fakerepo" }, {});
      const first = result.content[0];
      assert.ok(first && first.type === "text");
      assert.match(first.text, /Project profile/);
      assert.match(first.text, /typescript/);
      assert.match(first.text, /django/);
      const sc = result.structuredContent as {
        profile: {
          languages: string[];
          frameworks: string[];
          iacTypes: string[];
          apiContracts: string[];
          manifests: string[];
          srcDirs: string[];
        };
        next_steps: string[];
      };
      assert.deepEqual(sc.profile.languages, ["typescript", "python"]);
      assert.deepEqual(sc.profile.frameworks, ["django", "nextjs"]);
      assert.deepEqual(sc.profile.iacTypes, ["docker", "terraform"]);
      assert.deepEqual(sc.profile.apiContracts, ["openapi"]);
      assert.deepEqual(sc.profile.manifests, ["package.json", "pyproject.toml"]);
      assert.deepEqual(sc.profile.srcDirs, ["backend/src", "src"]);
      assert.ok(sc.next_steps.length > 0);
    },
  );
});

test("project_profile reports missing profile with a remediation hint", async () => {
  await withTestHarness({ nodes: [], relations: [] }, async (ctx, server) => {
    registerProjectProfileTool(server, ctx);
    const handler = getHandler(server, "project_profile");
    const result = await handler({ repo: "fakerepo" }, {});
    const first = result.content[0];
    assert.ok(first && first.type === "text");
    assert.match(first.text, /No ProjectProfile/);
    const sc = result.structuredContent as {
      profile: { languages: string[] };
      next_steps: string[];
    };
    assert.deepEqual(sc.profile.languages, []);
    assert.ok(sc.next_steps.some((s) => s.includes("codehub analyze --force")));
  });
});

test("dependencies tool surfaces Dependency nodes with ecosystem filter", async () => {
  await withTestHarness(
    {
      nodes: [
        {
          id: "Dependency:npm:express@4.19.2",
          name: "express",
          kind: "Dependency",
          file_path: "package.json",
          version: "4.19.2",
          license: "UNKNOWN",
          lockfile_source: "package.json",
          ecosystem: "npm",
        },
        {
          id: "Dependency:npm:zod@3.23.0",
          name: "zod",
          kind: "Dependency",
          file_path: "package.json",
          version: "3.23.0",
          license: "UNKNOWN",
          lockfile_source: "package.json",
          ecosystem: "npm",
        },
        {
          id: "Dependency:cargo:serde@1.0.200",
          name: "serde",
          kind: "Dependency",
          file_path: "Cargo.lock",
          version: "1.0.200",
          license: "UNKNOWN",
          lockfile_source: "Cargo.lock",
          ecosystem: "cargo",
        },
      ],
      relations: [],
    },
    async (ctx, server) => {
      registerDependenciesTool(server, ctx);
      const handler = getHandler(server, "dependencies");

      // Full listing.
      const all = await handler({ repo: "fakerepo" }, {});
      const scAll = all.structuredContent as {
        dependencies: Array<{ name: string; ecosystem: string }>;
        total: number;
      };
      assert.equal(scAll.total, 3);
      const names = scAll.dependencies.map((d) => d.name).sort();
      assert.deepEqual(names, ["express", "serde", "zod"]);

      // Ecosystem filter trims to cargo-only.
      const onlyCargo = await handler({ repo: "fakerepo", ecosystem: "cargo" }, {});
      const scCargo = onlyCargo.structuredContent as {
        dependencies: Array<{ name: string }>;
        total: number;
      };
      assert.equal(scCargo.total, 1);
      assert.equal(scCargo.dependencies[0]?.name, "serde");
    },
  );
});

test("owners ranks Contributors linked by OWNED_BY edges", async () => {
  await withTestHarness(
    {
      nodes: [
        { id: "File:src/a.ts:src/a.ts", name: "a.ts", kind: "File", file_path: "src/a.ts" },
        {
          id: "Contributor:<contributors>:hash-alice",
          name: "Alice",
          kind: "Contributor",
          file_path: "<contributors>",
          email_hash: "a".repeat(64),
          email_plain: "",
        },
        {
          id: "Contributor:<contributors>:hash-bob",
          name: "Bob",
          kind: "Contributor",
          file_path: "<contributors>",
          email_hash: "b".repeat(64),
          email_plain: "",
        },
      ],
      relations: [
        {
          id: "E:own-a",
          from_id: "File:src/a.ts:src/a.ts",
          to_id: "Contributor:<contributors>:hash-alice",
          type: "OWNED_BY",
          confidence: 0.75,
        },
        {
          id: "E:own-b",
          from_id: "File:src/a.ts:src/a.ts",
          to_id: "Contributor:<contributors>:hash-bob",
          type: "OWNED_BY",
          confidence: 0.25,
        },
      ],
    },
    async (ctx, server) => {
      registerOwnersTool(server, ctx);
      const handler = getHandler(server, "owners");
      const result = await handler({ target: "File:src/a.ts:src/a.ts", repo: "fakerepo" }, {});
      const sc = result.structuredContent as {
        owners: Array<{ name: string; weight: number }>;
        total: number;
      };
      assert.equal(sc.total, 2);
      assert.equal(sc.owners[0]?.name, "Alice");
      assert.equal(sc.owners[1]?.name, "Bob");
      assert.ok(
        (sc.owners[0]?.weight ?? 0) > (sc.owners[1]?.weight ?? 0),
        "Alice must rank above Bob by weight",
      );
    },
  );
});

test("license_audit returns tier=BLOCK when a GPL dep is present", async () => {
  await withTestHarness(
    {
      nodes: [
        {
          id: "Dependency:npm:[email protected]",
          name: "lodash",
          kind: "Dependency",
          file_path: "package.json",
          version: "4.17.21",
          license: "MIT",
          lockfile_source: "package.json",
          ecosystem: "npm",
        },
        {
          id: "Dependency:npm:[email protected]",
          name: "readline",
          kind: "Dependency",
          file_path: "package.json",
          version: "6.4.0",
          license: "GPL-3.0",
          lockfile_source: "package.json",
          ecosystem: "npm",
        },
      ],
      relations: [],
    },
    async (ctx, server) => {
      registerLicenseAuditTool(server, ctx);
      const handler = getHandler(server, "license_audit");
      const result = await handler({ repo: "fakerepo" }, {});
      const sc = result.structuredContent as {
        tier: "OK" | "WARN" | "BLOCK";
        flagged: {
          copyleft: Array<{ name: string }>;
          unknown: unknown[];
          proprietary: unknown[];
        };
        summary: { total: number; okCount: number; flaggedCount: number };
      };
      assert.equal(sc.tier, "BLOCK");
      assert.equal(sc.flagged.copyleft.length, 1);
      assert.equal(sc.flagged.copyleft[0]?.name, "readline");
      assert.equal(sc.summary.total, 2);
      assert.equal(sc.summary.okCount, 1);
    },
  );
});

test("license_audit returns tier=WARN when only UNKNOWN licenses are flagged", async () => {
  await withTestHarness(
    {
      nodes: [
        {
          id: "Dependency:npm:[email protected]",
          name: "lodash",
          kind: "Dependency",
          file_path: "package.json",
          version: "4.17.21",
          license: "MIT",
          lockfile_source: "package.json",
          ecosystem: "npm",
        },
        {
          id: "Dependency:npm:[email protected]",
          name: "mystery",
          kind: "Dependency",
          file_path: "package.json",
          version: "1.0.0",
          license: "UNKNOWN",
          lockfile_source: "package.json",
          ecosystem: "npm",
        },
      ],
      relations: [],
    },
    async (ctx, server) => {
      registerLicenseAuditTool(server, ctx);
      const handler = getHandler(server, "license_audit");
      const result = await handler({ repo: "fakerepo" }, {});
      const sc = result.structuredContent as {
        tier: "OK" | "WARN" | "BLOCK";
        flagged: { copyleft: unknown[]; unknown: unknown[]; proprietary: unknown[] };
      };
      assert.equal(sc.tier, "WARN");
      assert.equal(sc.flagged.copyleft.length, 0);
      assert.equal(sc.flagged.unknown.length, 1);
    },
  );
});

test("license_audit returns tier=OK when every license is permissive", async () => {
  await withTestHarness(
    {
      nodes: [
        {
          id: "Dependency:npm:[email protected]",
          name: "lodash",
          kind: "Dependency",
          file_path: "package.json",
          version: "4.17.21",
          license: "MIT",
          lockfile_source: "package.json",
          ecosystem: "npm",
        },
      ],
      relations: [],
    },
    async (ctx, server) => {
      registerLicenseAuditTool(server, ctx);
      const handler = getHandler(server, "license_audit");
      const result = await handler({ repo: "fakerepo" }, {});
      const sc = result.structuredContent as {
        tier: "OK" | "WARN" | "BLOCK";
      };
      assert.equal(sc.tier, "OK");
    },
  );
});
