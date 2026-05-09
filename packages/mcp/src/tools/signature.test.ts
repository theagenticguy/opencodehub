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
import { test } from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  type FakeEdgeLike,
  type FakeNodeLike,
  getToolHandler,
  makeFakeGraphStore,
  withMcpHarness,
} from "../test-utils.js";
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

async function withHarness(
  input: FakeStoreInput,
  fn: (
    ctx: ToolContext,
    server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
  ) => Promise<void>,
): Promise<void> {
  const nodes: FakeNodeLike[] = input.nodes.map(
    (n) =>
      ({
        ...n,
        id: String(n["id"]),
        name: typeof n["name"] === "string" ? (n["name"] as string) : "",
        kind: typeof n["kind"] === "string" ? (n["kind"] as string) : "",
      }) as unknown as FakeNodeLike,
  );
  const edges: FakeEdgeLike[] = input.edges.map((e) => ({
    type: e.type,
    from: e.from,
    to: e.to,
  }));
  await withMcpHarness(
    {
      tmpPrefix: "codehub-mcp-sig-",
      storeFactory: () => makeFakeGraphStore({ nodes, edges }),
    },
    async ({ server, pool, home }) => {
      const ctx: ToolContext = { pool, home };
      await fn(ctx, server);
    },
  );
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
      const handler = getToolHandler(server, "signature");
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
      const handler = getToolHandler(server, "signature");
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
      const handler = getToolHandler(server, "signature");
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
      const handler = getToolHandler(server, "signature");
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
