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
import { test } from "node:test";
import {
  type FakeEdgeLike,
  type FakeNodeLike,
  getToolHandler,
  makeFakeGraphStore,
  withMcpHarness,
} from "../test-utils.js";
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

async function withHarness(
  data: FakeStoreData,
  fn: (
    ctx: ToolContext,
    server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
  ) => Promise<void>,
): Promise<void> {
  const nodes: FakeNodeLike[] = data.nodes.map(
    (n) =>
      ({
        ...n,
        id: String(n["id"]),
        name: typeof n["name"] === "string" ? (n["name"] as string) : "",
        kind: typeof n["kind"] === "string" ? (n["kind"] as string) : "",
        // Both the snake_case `file_path` field (present in seeds) and the
        // camelCase `filePath` field (read by production) are populated by
        // the helper's projector.
      }) as unknown as FakeNodeLike,
  );
  const edges: FakeEdgeLike[] = data.relations.map(
    (r) =>
      ({
        ...r,
        type: String(r["type"]),
      }) as unknown as FakeEdgeLike,
  );
  const cochangeRows = data.cochanges ?? [];
  await withMcpHarness(
    {
      tmpPrefix: "codehub-context-test-",
      storeFactory: () =>
        makeFakeGraphStore(
          { nodes, edges },
          {
            lookupCochangesForFile: async (
              file: string,
              opts: { limit?: number; minLift?: number } = {},
            ) => {
              const minLift = opts.minLift ?? 1.0;
              const limit = opts.limit ?? 10;
              return cochangeRows
                .filter(
                  (r) => (r.sourceFile === file || r.targetFile === file) && r.lift >= minLift,
                )
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
          },
        ),
    },
    async ({ server, pool, home }) => {
      const ctx: ToolContext = { pool, home };
      await fn(ctx, server);
    },
  );
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
      const handler = getToolHandler(server, "context");
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
      const handler = getToolHandler(server, "context");
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
      const handler = getToolHandler(server, "context");
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
      const handler = getToolHandler(server, "context");

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
      const handler = getToolHandler(server, "context");
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
          reason: "scip:scip-typescript@4.3.3",
        },
      ],
    },
    async (ctx, server) => {
      registerContextTool(server, ctx);
      const handler = getToolHandler(server, "context");
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
      const handler = getToolHandler(server, "context");
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
