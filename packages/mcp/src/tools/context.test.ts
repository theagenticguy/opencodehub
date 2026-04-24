// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures
/**
 * `context` MCP tool — parameter + categorisation parity tests.
 *
 * Exercised surfaces:
 *   - `uid` direct lookup skips name-based disambiguation.
 *   - `file_path` + `kind` narrow a common name from ambiguous → resolved.
 *   - `include_content` attaches the target's indexed source (capped).
 *   - Categorised `incoming` / `outgoing` buckets cover every edge type.
 *   - HAS_METHOD edges from class ownership surface under `incoming.has_method`.
 *   - Ambiguous name returns ranked candidates with no partial traversal.
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
import { ConnectionPool } from "../connection-pool.js";
import { registerContextTool } from "./context.js";
import type { ToolContext } from "./shared.js";

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
}

function makeFakeStore(data: FakeStoreData): DuckDbStore {
  const projectContextNode = (n: Record<string, unknown>) => ({
    id: n["id"],
    name: n["name"],
    kind: n["kind"],
    file_path: n["file_path"],
    start_line: n["start_line"] ?? null,
    end_line: n["end_line"] ?? null,
    content: n["content"] ?? null,
  });
  const projectNeighbour = (n: Record<string, unknown>) => ({
    id: n["id"],
    name: n["name"],
    kind: n["kind"],
    file_path: n["file_path"],
  });

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
      const text = sql.replace(/\s+/g, " ").trim();

      // uid-based direct lookup
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
      // name-based lookup (optional kind / file_path LIKE)
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
      // categorised edges (incoming or outgoing)
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
      // owner lookup (HAS_METHOD / HAS_PROPERTY / CONTAINS pointing at target)
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
            return projectNeighbour(src);
          });
      }
      // Route → Operation HANDLES_ROUTE lookup — return empty for non-Route
      // tests; the targeted test populates a custom path.
      if (text.includes("r.type = 'HANDLES_ROUTE'") && text.includes("n.kind = 'Operation'")) {
        return [];
      }
      // Process participation — return empty for these tests.
      if (text.includes("PROCESS_STEP") && text.includes("kind = 'Process'")) {
        return [];
      }
      // Confidence breakdown tally.
      if (
        text.startsWith("SELECT confidence, reason FROM relations") &&
        text.includes("from_id = ? OR to_id = ?") &&
        text.includes("type IN")
      ) {
        const targetId = params[0];
        const allowed = new Set((params as string[]).slice(2));
        return data.relations
          .filter(
            (r) =>
              (r["from_id"] === targetId || r["to_id"] === targetId) &&
              allowed.has(String(r["type"])),
          )
          .map((r) => ({ confidence: r["confidence"], reason: r["reason"] }));
      }
      if (/^SELECT/i.test(text)) return [];
      throw new Error(`unsupported sql in fake store: ${text}`);
    },
    search: async (_q: SearchQuery): Promise<readonly SearchResult[]> => [],
    vectorSearch: async (_q: VectorQuery): Promise<readonly VectorResult[]> => [],
    traverse: async (_q: TraverseQuery): Promise<readonly TraverseResult[]> => [],
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

async function withHarness(
  data: FakeStoreData,
  fn: (ctx: ToolContext, server: McpServer) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(resolve(tmpdir(), "codehub-context-test-"));
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

interface CategoryBuckets {
  calls: Array<{ id: string }>;
  imports: Array<{ id: string }>;
  accesses: Array<{ id: string }>;
  has_method: Array<{ id: string }>;
  has_property: Array<{ id: string }>;
  extends: Array<{ id: string }>;
  implements: Array<{ id: string }>;
  method_overrides: Array<{ id: string }>;
  method_implements: Array<{ id: string }>;
}

test("context: uid param performs a direct lookup and skips name disambiguation", async () => {
  await withHarness(
    {
      nodes: [
        // Two symbols share the name "auth"; without uid this is ambiguous.
        { id: "F:auth:A", name: "auth", kind: "Function", file_path: "src/a.ts" },
        { id: "F:auth:B", name: "auth", kind: "Function", file_path: "src/b.ts" },
      ],
      relations: [],
    },
    async (ctx, server) => {
      registerContextTool(server, ctx);
      const handler = getHandler(server, "context");
      const result = await handler({ uid: "F:auth:B", repo: "fakerepo" }, {});
      const sc = result.structuredContent as {
        target: { id: string; name: string; kind: string; filePath: string };
        location: { filePath: string };
      };
      assert.equal(sc.target.id, "F:auth:B", "uid must resolve to the exact node");
      assert.equal(sc.target.name, "auth");
      assert.equal(sc.target.kind, "Function");
      assert.equal(sc.location.filePath, "src/b.ts");
    },
  );
});

test("context: file_path narrows an ambiguous name to a single match", async () => {
  await withHarness(
    {
      nodes: [
        { id: "F:login:auth", name: "login", kind: "Function", file_path: "src/auth/login.ts" },
        { id: "F:login:ui", name: "login", kind: "Function", file_path: "src/ui/login.ts" },
      ],
      relations: [],
    },
    async (ctx, server) => {
      registerContextTool(server, ctx);
      const handler = getHandler(server, "context");
      const result = await handler({ symbol: "login", file_path: "auth", repo: "fakerepo" }, {});
      const sc = result.structuredContent as {
        target: { id: string } | null;
        candidates?: unknown[];
      };
      assert.ok(sc.target);
      assert.equal(sc.target?.id, "F:login:auth");
      // When the name narrows to a single match the resolved branch still
      // carries a `candidates` field but it is empty — the ranked-candidate
      // arm is reserved for the ambiguous outcome.
      assert.deepEqual(sc.candidates ?? [], []);
    },
  );
});

test("context: kind narrows same-named Function vs Method", async () => {
  await withHarness(
    {
      nodes: [
        { id: "F:run:fn", name: "run", kind: "Function", file_path: "src/cli.ts" },
        { id: "M:run:mth", name: "run", kind: "Method", file_path: "src/Worker.ts" },
      ],
      relations: [],
    },
    async (ctx, server) => {
      registerContextTool(server, ctx);
      const handler = getHandler(server, "context");
      const result = await handler({ symbol: "run", kind: "Method", repo: "fakerepo" }, {});
      const sc = result.structuredContent as { target: { id: string; kind: string } | null };
      assert.equal(sc.target?.id, "M:run:mth");
      assert.equal(sc.target?.kind, "Method");
    },
  );
});

test("context: include_content attaches source (capped at 2000 chars)", async () => {
  const smallSource = "def foo():\n    return 42\n";
  const longSource = "x".repeat(3000);
  await withHarness(
    {
      nodes: [
        {
          id: "F:foo",
          name: "foo",
          kind: "Function",
          file_path: "src/foo.ts",
          start_line: 10,
          end_line: 12,
          content: smallSource,
        },
        {
          id: "F:big",
          name: "big",
          kind: "Function",
          file_path: "src/big.ts",
          start_line: 1,
          end_line: 500,
          content: longSource,
        },
      ],
      relations: [],
    },
    async (ctx, server) => {
      registerContextTool(server, ctx);
      const handler = getHandler(server, "context");

      // Without include_content, no `content` field is emitted.
      const noContent = await handler({ uid: "F:foo", repo: "fakerepo" }, {});
      const nc = noContent.structuredContent as {
        content?: string;
        location: { startLine: number | null; endLine: number | null };
      };
      assert.equal(nc.content, undefined);
      assert.equal(nc.location.startLine, 10);
      assert.equal(nc.location.endLine, 12);

      // With include_content, small source is emitted verbatim.
      const withSmall = await handler(
        { uid: "F:foo", include_content: true, repo: "fakerepo" },
        {},
      );
      const ws = withSmall.structuredContent as { content?: string };
      assert.equal(ws.content, smallSource);

      // Long source is truncated to 2000 chars with an ellipsis marker.
      const withLong = await handler({ uid: "F:big", include_content: true, repo: "fakerepo" }, {});
      const wl = withLong.structuredContent as { content?: string };
      assert.ok(wl.content, "content must be present when include_content is true");
      assert.ok((wl.content ?? "").length <= 2000, "content must be capped at 2000 chars");
      assert.ok((wl.content ?? "").endsWith("…"), "truncation marker expected");
    },
  );
});

test("context: categorises incoming + outgoing edges by edge type", async () => {
  await withHarness(
    {
      nodes: [
        { id: "T:target", name: "target", kind: "Function", file_path: "src/t.ts" },
        { id: "F:caller", name: "caller", kind: "Function", file_path: "src/c.ts" },
        { id: "F:mod", name: "mod", kind: "File", file_path: "src/mod.ts" },
        { id: "P:prop", name: "prop", kind: "Property", file_path: "src/t.ts" },
        { id: "F:callee", name: "callee", kind: "Function", file_path: "src/cal.ts" },
        { id: "C:base", name: "Base", kind: "Class", file_path: "src/base.ts" },
      ],
      relations: [
        { id: "E:c1", from_id: "F:caller", to_id: "T:target", type: "CALLS", confidence: 0.9 },
        { id: "E:i1", from_id: "F:mod", to_id: "T:target", type: "IMPORTS", confidence: 0.9 },
        { id: "E:a1", from_id: "F:caller", to_id: "T:target", type: "ACCESSES", confidence: 0.9 },
        { id: "E:o1", from_id: "T:target", to_id: "F:callee", type: "CALLS", confidence: 0.9 },
        { id: "E:hp", from_id: "T:target", to_id: "P:prop", type: "HAS_PROPERTY", confidence: 0.9 },
        { id: "E:ex", from_id: "T:target", to_id: "C:base", type: "EXTENDS", confidence: 0.9 },
      ],
    },
    async (ctx, server) => {
      registerContextTool(server, ctx);
      const handler = getHandler(server, "context");
      const result = await handler({ uid: "T:target", repo: "fakerepo" }, {});
      const sc = result.structuredContent as {
        incoming: CategoryBuckets;
        outgoing: CategoryBuckets;
      };
      assert.deepEqual(
        sc.incoming.calls.map((n) => n.id),
        ["F:caller"],
        "CALLS → target populates incoming.calls",
      );
      assert.deepEqual(
        sc.incoming.imports.map((n) => n.id),
        ["F:mod"],
        "IMPORTS → target populates incoming.imports",
      );
      assert.deepEqual(
        sc.incoming.accesses.map((n) => n.id),
        ["F:caller"],
        "ACCESSES → target populates incoming.accesses",
      );
      assert.deepEqual(
        sc.outgoing.calls.map((n) => n.id),
        ["F:callee"],
        "target CALLS → populates outgoing.calls",
      );
      assert.deepEqual(
        sc.outgoing.has_property.map((n) => n.id),
        ["P:prop"],
        "target HAS_PROPERTY → populates outgoing.has_property",
      );
      assert.deepEqual(
        sc.outgoing.extends.map((n) => n.id),
        ["C:base"],
        "target EXTENDS → populates outgoing.extends",
      );
      // Unpopulated buckets stay empty.
      assert.equal(sc.outgoing.imports.length, 0);
      assert.equal(sc.incoming.has_method.length, 0);
    },
  );
});

test("context: HAS_METHOD edges from a parent class surface under incoming.has_method", async () => {
  await withHarness(
    {
      nodes: [
        { id: "M:handle", name: "handle", kind: "Method", file_path: "src/Worker.ts" },
        { id: "C:Worker", name: "Worker", kind: "Class", file_path: "src/Worker.ts" },
      ],
      relations: [
        {
          id: "E:hm",
          from_id: "C:Worker",
          to_id: "M:handle",
          type: "HAS_METHOD",
          confidence: 1.0,
          reason: "tsserver@4.3.3",
        },
      ],
    },
    async (ctx, server) => {
      registerContextTool(server, ctx);
      const handler = getHandler(server, "context");
      const result = await handler({ uid: "M:handle", repo: "fakerepo" }, {});
      const sc = result.structuredContent as {
        incoming: CategoryBuckets;
        owner: Array<{ id: string }>;
      };
      assert.equal(sc.incoming.has_method.length, 1, "class HAS_METHOD → method surfaces incoming");
      assert.equal(sc.incoming.has_method[0]?.id, "C:Worker");
      // Owner is derived from HAS_METHOD / HAS_PROPERTY / CONTAINS pointing at
      // the target — it should resolve the parent class too.
      assert.equal(sc.owner[0]?.id, "C:Worker");
    },
  );
});

test("context: ambiguous name returns ranked candidates and skips traversal", async () => {
  await withHarness(
    {
      nodes: [
        { id: "F:process:a", name: "process", kind: "Function", file_path: "src/a.ts" },
        { id: "F:process:b", name: "process", kind: "Function", file_path: "src/b.ts" },
        { id: "F:process:c", name: "process", kind: "Function", file_path: "src/c.ts" },
      ],
      relations: [
        // Edges pointing at ONE of the candidates — they must NOT appear in
        // the output because the resolver stops at the candidate list.
        { id: "E:x", from_id: "F:process:a", to_id: "F:process:a", type: "CALLS", confidence: 1 },
      ],
    },
    async (ctx, server) => {
      registerContextTool(server, ctx);
      const handler = getHandler(server, "context");
      const result = await handler({ symbol: "process", repo: "fakerepo" }, {});
      const sc = result.structuredContent as {
        target: unknown;
        candidates: Array<{ id: string; kind: string; filePath: string }>;
        incoming?: unknown;
        outgoing?: unknown;
      };
      assert.equal(sc.target, null);
      assert.equal(sc.candidates.length, 3);
      const ids = sc.candidates.map((c) => c.id).sort();
      assert.deepEqual(ids, ["F:process:a", "F:process:b", "F:process:c"]);
      // The ambiguous branch must short-circuit: no categorised buckets land
      // on the response envelope.
      assert.equal(sc.incoming, undefined, "no incoming bucket on ambiguous resolution");
      assert.equal(sc.outgoing, undefined, "no outgoing bucket on ambiguous resolution");
      const first = result.content[0];
      assert.ok(first && first.type === "text");
      assert.match(first.text, /ambiguous/);
    },
  );
});
