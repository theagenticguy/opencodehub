/**
 * signature tool behaviour tests.
 *
 * Covered cases:
 *   1. Class with 3 methods → emits a 4-line stub header + `;`-terminated
 *      member signatures (and 5th closing brace line in brace languages).
 *   2. Standalone function → emits a single-line signature stub.
 *   3. Unknown name → returns candidate-list disambiguation arm.
 */
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
import { ConnectionPool } from "../connection-pool.js";
import type { ToolContext } from "./shared.js";
import { registerSignatureTool } from "./signature.js";

interface FakeNodeRow {
  [k: string]: unknown;
}

interface HasMethodEdge {
  readonly from: string;
  readonly to: string;
  readonly type: "HAS_METHOD" | "HAS_PROPERTY";
}

interface FakeStoreInput {
  readonly nodes: readonly FakeNodeRow[];
  readonly edges: readonly HasMethodEdge[];
}

function makeFakeStore(input: FakeStoreInput): DuckDbStore {
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

      // Member fetch: relations JOIN nodes WHERE from_id = ?
      if (text.startsWith("SELECT n.id, n.name, n.kind, n.file_path, n.start_line")) {
        const ownerId = String(params[0] ?? "");
        const childIds = new Set(input.edges.filter((e) => e.from === ownerId).map((e) => e.to));
        const matching = input.nodes.filter((n) => childIds.has(String(n["id"])));
        return matching.slice().sort((a, b) => {
          const sa = typeof a["start_line"] === "number" ? (a["start_line"] as number) : 0;
          const sb = typeof b["start_line"] === "number" ? (b["start_line"] as number) : 0;
          if (sa !== sb) return sa - sb;
          return String(a["name"]).localeCompare(String(b["name"]));
        });
      }

      // Target resolve: SELECT id, name, kind, file_path ... WHERE name = ? / id = ?
      if (text.startsWith("SELECT id, name, kind, file_path, start_line")) {
        const byUid = text.includes("WHERE id = ?");
        let out = input.nodes.slice();
        if (byUid) {
          const uid = String(params[0] ?? "");
          out = out.filter((n) => String(n["id"]) === uid);
        } else {
          const name = String(params[0] ?? "");
          out = out.filter((n) => String(n["name"]) === name);
          let pi = 1;
          if (text.includes("AND kind = ?")) {
            const kind = String(params[pi++] ?? "");
            out = out.filter((n) => String(n["kind"]) === kind);
          }
          if (text.includes("AND file_path LIKE ?")) {
            const needle = String(params[pi++] ?? "").replace(/%/g, "");
            out = out.filter((n) => String(n["file_path"] ?? "").includes(needle));
          }
        }
        return out
          .slice()
          .sort((a, b) => String(a["file_path"]).localeCompare(String(b["file_path"])));
      }

      throw new Error(`unsupported sql in fake store: ${text}`);
    },
    search: async (_q: SearchQuery): Promise<readonly SearchResult[]> => [],
    vectorSearch: async (_q: VectorQuery): Promise<readonly VectorResult[]> => [],
    traverse: async (_q: TraverseQuery): Promise<readonly TraverseResult[]> => [],
    getMeta: async (): Promise<StoreMeta | undefined> => undefined,
    setMeta: async (_m: StoreMeta): Promise<void> => {},
    healthCheck: async () => ({ ok: true }),
  } as unknown as DuckDbStore;
  return api;
}

async function withHarness(
  input: FakeStoreInput,
  fn: (ctx: ToolContext, server: McpServer) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(resolve(tmpdir(), "codehub-mcp-sig-"));
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
          nodeCount: input.nodes.length,
          edgeCount: input.edges.length,
          lastCommit: "abc123",
        },
      }),
    );
    const pool = new ConnectionPool({ max: 2, ttlMs: 60_000 }, async () => makeFakeStore(input));
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

type RegisteredTool = { handler: (args: unknown, extra: unknown) => Promise<CallToolResult> };

function getHandler(server: McpServer, name: string): RegisteredTool["handler"] {
  // biome-ignore lint/suspicious/noExplicitAny: SDK internal field for test-only access
  const map = (server as any)._registeredTools as Record<string, RegisteredTool>;
  const entry = map[name];
  assert.ok(entry, `tool not registered: ${name}`);
  return entry.handler.bind(entry);
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  if (first === undefined || first.type !== "text") return "";
  return first.text;
}

test("signature: class with 3 methods → 4-line (or 5-line) stub with member signatures", async () => {
  const classId = "Class:src/foo.ts:Foo";
  const m1 = "Method:src/foo.ts:Foo.greet";
  const m2 = "Method:src/foo.ts:Foo.count";
  const m3 = "Method:src/foo.ts:Foo.reset";
  await withHarness(
    {
      nodes: [
        {
          id: classId,
          name: "Foo",
          kind: "Class",
          file_path: "src/foo.ts",
          start_line: 1,
          end_line: 20,
          signature: null,
          parameter_count: null,
          return_type: null,
        },
        {
          id: m1,
          name: "greet",
          kind: "Method",
          file_path: "src/foo.ts",
          start_line: 2,
          end_line: 4,
          signature: "greet(name: string): string",
          parameter_count: 1,
          return_type: "string",
        },
        {
          id: m2,
          name: "count",
          kind: "Method",
          file_path: "src/foo.ts",
          start_line: 6,
          end_line: 8,
          signature: "count(): number",
          parameter_count: 0,
          return_type: "number",
        },
        {
          id: m3,
          name: "reset",
          kind: "Method",
          file_path: "src/foo.ts",
          start_line: 10,
          end_line: 12,
          signature: "reset(): void",
          parameter_count: 0,
          return_type: "void",
        },
      ],
      edges: [
        { from: classId, to: m1, type: "HAS_METHOD" },
        { from: classId, to: m2, type: "HAS_METHOD" },
        { from: classId, to: m3, type: "HAS_METHOD" },
      ],
    },
    async (ctx, server) => {
      registerSignatureTool(server, ctx);
      const handler = getHandler(server, "signature");
      const result = await handler({ repo: "fakerepo", name: "Foo" }, {});
      const sc = result.structuredContent as {
        target: { name: string; kind: string };
        memberCount: number;
        stub: string;
      };
      assert.equal(sc.target.kind, "Class");
      assert.equal(sc.memberCount, 3);
      const lines = sc.stub.split("\n");
      // header + 3 members + closing brace = 5 lines in brace languages.
      assert.equal(lines.length, 5, `expected 5-line stub, got:\n${sc.stub}`);
      assert.equal(lines[0], "class Foo {");
      assert.equal(lines[1], "  greet(name: string): string;");
      assert.equal(lines[2], "  count(): number;");
      assert.equal(lines[3], "  reset(): void;");
      assert.equal(lines[4], "}");
      // sanity: text block mirrors the stub.
      const text = textOf(result);
      assert.ok(text.startsWith("class Foo {"), `text block: ${text}`);
    },
  );
});

test("signature: standalone function → single signature stub", async () => {
  await withHarness(
    {
      nodes: [
        {
          id: "Function:src/bar.ts:add",
          name: "add",
          kind: "Function",
          file_path: "src/bar.ts",
          start_line: 1,
          end_line: 3,
          signature: "add(a: number, b: number): number",
          parameter_count: 2,
          return_type: "number",
        },
      ],
      edges: [],
    },
    async (ctx, server) => {
      registerSignatureTool(server, ctx);
      const handler = getHandler(server, "signature");
      const result = await handler({ repo: "fakerepo", name: "add" }, {});
      const sc = result.structuredContent as {
        target: { name: string; kind: string };
        memberCount: number;
        stub: string;
      };
      assert.equal(sc.target.kind, "Function");
      assert.equal(sc.memberCount, 0);
      assert.equal(sc.stub, "add(a: number, b: number): number;");
    },
  );
});

test("signature: unknown name → empty result with next-step hint", async () => {
  await withHarness(
    {
      nodes: [
        {
          id: "Function:src/bar.ts:add",
          name: "add",
          kind: "Function",
          file_path: "src/bar.ts",
          start_line: 1,
          end_line: 3,
          signature: "add(a: number, b: number): number",
          parameter_count: 2,
          return_type: "number",
        },
      ],
      edges: [],
    },
    async (ctx, server) => {
      registerSignatureTool(server, ctx);
      const handler = getHandler(server, "signature");
      const result = await handler({ repo: "fakerepo", name: "doesNotExist" }, {});
      const sc = result.structuredContent as {
        target: unknown;
        candidates: readonly unknown[];
      };
      assert.equal(sc.target, null);
      assert.deepEqual(sc.candidates, []);
      const text = textOf(result);
      assert.ok(text.includes("No symbol matched"), `expected empty-arm text, got: ${text}`);
    },
  );
});

test("signature: ambiguous name → candidate-list disambiguation arm", async () => {
  await withHarness(
    {
      nodes: [
        {
          id: "Class:src/a.ts:Foo",
          name: "Foo",
          kind: "Class",
          file_path: "src/a.ts",
          start_line: 1,
          end_line: 5,
          signature: null,
          parameter_count: null,
          return_type: null,
        },
        {
          id: "Class:src/b.ts:Foo",
          name: "Foo",
          kind: "Class",
          file_path: "src/b.ts",
          start_line: 1,
          end_line: 5,
          signature: null,
          parameter_count: null,
          return_type: null,
        },
      ],
      edges: [],
    },
    async (ctx, server) => {
      registerSignatureTool(server, ctx);
      const handler = getHandler(server, "signature");
      const result = await handler({ repo: "fakerepo", name: "Foo" }, {});
      const sc = result.structuredContent as {
        target: unknown;
        candidates: readonly { filePath: string }[];
      };
      assert.equal(sc.target, null);
      assert.equal(sc.candidates.length, 2);
      const text = textOf(result);
      assert.ok(text.includes("is ambiguous"), `expected ambiguous text, got: ${text}`);
    },
  );
});
