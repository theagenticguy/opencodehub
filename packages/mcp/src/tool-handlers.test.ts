// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  AncestorTraversalOptions,
  DescendantTraversalOptions,
  SearchQuery,
  SearchResult,
  TraverseQuery,
  TraverseResult,
} from "@opencodehub/storage";
import { assertReadOnlySql } from "@opencodehub/storage";
import {
  type FakeDependency,
  type FakeEdgeLike,
  type FakeNodeLike,
  type FakeRoute,
  getToolHandler,
  makeFakeGraphStore,
  withMcpHarness,
} from "./test-utils.js";
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

/**
 * Project the legacy snake_case test seed shape onto the typed-finder
 * data the production code reads.
 *
 * Routes / Dependencies are surfaced via dedicated finders (`listRoutes`,
 * `listDependencies`); ProjectProfile rows have JSON-string columns we
 * pre-parse into typed arrays. Cochange rows go through the temporal
 * `lookupCochangesForFile` finder.
 */
function buildFake(data: FakeStoreData) {
  const nodes: FakeNodeLike[] = data.nodes.map(
    (n) =>
      ({
        ...n,
        id: String(n["id"]),
        name: typeof n["name"] === "string" ? (n["name"] as string) : "",
        kind: typeof n["kind"] === "string" ? (n["kind"] as string) : "",
      }) as unknown as FakeNodeLike,
  );

  // Project ProjectProfile JSON-string columns into typed arrays so the
  // typed `listNodesByKind("ProjectProfile")` finder returns rows the
  // production code can read.
  for (const n of nodes) {
    if (n.kind !== "ProjectProfile") continue;
    const p = n as unknown as Record<string, unknown>;
    const parseArr = (key: string): string[] => {
      const raw = p[key];
      if (typeof raw !== "string") return [];
      try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? (v as string[]) : [];
      } catch {
        return [];
      }
    };
    p["languages"] = parseArr("languages_json");
    p["frameworks"] = parseArr("frameworks_json");
    p["iacTypes"] = parseArr("iac_types_json");
    p["apiContracts"] = parseArr("api_contracts_json");
    p["manifests"] = parseArr("manifests_json");
    p["srcDirs"] = parseArr("src_dirs_json");
  }

  const edges: FakeEdgeLike[] = data.relations.map(
    (r) =>
      ({
        ...r,
        type: String(r["type"]),
      }) as unknown as FakeEdgeLike,
  );

  // Project Route nodes for `listRoutes()` (api-impact, route-map, etc.)
  const routes: FakeRoute[] = nodes
    .filter((n) => n.kind === "Route")
    .map((n) => {
      const p = n as unknown as Record<string, unknown>;
      return {
        id: n.id,
        kind: "Route" as const,
        name: typeof n.name === "string" ? n.name : "",
        filePath: typeof p["filePath"] === "string" ? (p["filePath"] as string) : "",
        ...(typeof p["url"] === "string" ? { url: p["url"] as string } : {}),
        ...(typeof p["method"] === "string" ? { method: p["method"] as string } : {}),
        ...(Array.isArray(p["responseKeys"])
          ? { responseKeys: p["responseKeys"] as string[] }
          : {}),
      };
    });

  // Project Dependency nodes for `listDependencies()`.
  const dependencies: FakeDependency[] = nodes
    .filter((n) => n.kind === "Dependency")
    .map((n) => {
      const p = n as unknown as Record<string, unknown>;
      return {
        id: n.id,
        kind: "Dependency" as const,
        name: typeof n.name === "string" ? n.name : "",
        ...(typeof p["filePath"] === "string"
          ? { filePath: p["filePath"] as string }
          : typeof p["file_path"] === "string"
            ? { filePath: p["file_path"] as string }
            : {}),
        ...(typeof p["ecosystem"] === "string" ? { ecosystem: p["ecosystem"] as string } : {}),
        ...(typeof p["version"] === "string" ? { version: p["version"] as string } : {}),
        ...(typeof p["license"] === "string" ? { license: p["license"] as string } : {}),
      };
    });

  const cochangeRows = data.cochanges ?? [];

  return makeFakeGraphStore(
    { nodes, edges, routes, dependencies },
    {
      // Per-test BM25 — search over node names by substring.
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
      // BFS over the in-memory relations table — the impact tool reads
      // analysis/impact.ts which uses `traverseAncestors` / `traverse`.
      traverse: async (q: TraverseQuery): Promise<readonly TraverseResult[]> => {
        const out: TraverseResult[] = [];
        const visited = new Set<string>([q.startId]);
        let frontier: string[] = [q.startId];
        for (let depth = 1; depth <= q.maxDepth; depth += 1) {
          const next: string[] = [];
          for (const id of frontier) {
            const matched = data.relations.filter((r) => {
              if (q.direction === "up") return r["to_id"] === id;
              if (q.direction === "down") return r["from_id"] === id;
              return r["from_id"] === id || r["to_id"] === id;
            });
            for (const edge of matched) {
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
      traverseAncestors: async (
        opts: AncestorTraversalOptions,
      ): Promise<readonly TraverseResult[]> => {
        const out: TraverseResult[] = [];
        const visited = new Set<string>([opts.fromId]);
        const allowedTypes = new Set<string>(opts.edgeTypes);
        let frontier: string[] = [opts.fromId];
        for (let depth = 1; depth <= opts.maxDepth; depth += 1) {
          const next: string[] = [];
          for (const id of frontier) {
            const matched = data.relations.filter((r) => {
              if (!allowedTypes.has(String(r["type"]))) return false;
              if (
                opts.minConfidence !== undefined &&
                Number(r["confidence"] ?? 0) < opts.minConfidence
              ) {
                return false;
              }
              return r["to_id"] === id;
            });
            for (const edge of matched) {
              const otherId = String(edge["from_id"]);
              if (visited.has(otherId)) continue;
              visited.add(otherId);
              out.push({ nodeId: otherId, depth, path: [opts.fromId, otherId] });
              next.push(otherId);
            }
          }
          frontier = next;
        }
        return out;
      },
      traverseDescendants: async (
        opts: DescendantTraversalOptions,
      ): Promise<readonly TraverseResult[]> => {
        const out: TraverseResult[] = [];
        const visited = new Set<string>([opts.fromId]);
        const allowedTypes = new Set<string>(opts.edgeTypes);
        let frontier: string[] = [opts.fromId];
        for (let depth = 1; depth <= opts.maxDepth; depth += 1) {
          const next: string[] = [];
          for (const id of frontier) {
            const matched = data.relations.filter((r) => {
              if (!allowedTypes.has(String(r["type"]))) return false;
              if (
                opts.minConfidence !== undefined &&
                Number(r["confidence"] ?? 0) < opts.minConfidence
              ) {
                return false;
              }
              return r["from_id"] === id;
            });
            for (const edge of matched) {
              const otherId = String(edge["to_id"]);
              if (visited.has(otherId)) continue;
              visited.add(otherId);
              out.push({ nodeId: otherId, depth, path: [opts.fromId, otherId] });
              next.push(otherId);
            }
          }
          frontier = next;
        }
        return out;
      },
      lookupCochangesForFile: async (
        file: string,
        opts: { limit?: number; minLift?: number } = {},
      ) => {
        const minLift = opts.minLift ?? 1.0;
        const limit = opts.limit ?? 10;
        return cochangeRows
          .filter((r) => (r.sourceFile === file || r.targetFile === file) && r.lift >= minLift)
          .slice()
          .sort((a, b) => b.lift - a.lift)
          .slice(0, limit);
      },
      lookupCochangesBetween: async (fileA: string, fileB: string) =>
        cochangeRows.find(
          (r) =>
            (r.sourceFile === fileA && r.targetFile === fileB) ||
            (r.sourceFile === fileB && r.targetFile === fileA),
        ),
      // SQL escape hatch (sql tool tests). Apply the read-only guard so
      // write-verb rejections propagate through the tool's INVALID_INPUT
      // path, then echo back the seeded nodes for the SELECT path.
      exec: async (sql: string) => {
        assertReadOnlySql(sql);
        const text = sql.replace(/\s+/g, " ").trim();
        if (/^SELECT \* FROM NODES LIMIT/i.test(text)) {
          return data.nodes.slice(0, 5).map((n) => ({
            id: n["id"],
            name: n["name"],
            kind: n["kind"],
            file_path: n["file_path"],
          }));
        }
        return [];
      },
    },
  );
}

async function withTestHarness(
  data: FakeStoreData,
  fn: (
    ctx: ToolContext,
    server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
  ) => Promise<void>,
): Promise<void> {
  await withMcpHarness(
    {
      tmpPrefix: "codehub-mcp-harness-",
      storeFactory: () => buildFake(data),
    },
    async ({ server, pool, home }) => {
      const ctx: ToolContext = { pool, home };
      await fn(ctx, server);
    },
  );
}

function getHandler(
  server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
  name: string,
): (args: unknown, extra: unknown) => Promise<CallToolResult> {
  return getToolHandler(server, name);
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
          // lower bound.
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
