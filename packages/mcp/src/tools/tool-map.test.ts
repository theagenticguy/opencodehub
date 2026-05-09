// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  type FakeNodeLike,
  getToolHandler,
  makeFakeGraphStore,
  withMcpHarness,
} from "../test-utils.js";
import type { ToolContext } from "./shared.js";
import { registerToolMapTool } from "./tool-map.js";

interface ToolFx {
  readonly id: string;
  readonly name: string;
  readonly filePath: string;
  readonly description: string;
  readonly propertiesBag: string | null;
}

/**
 * Project the test seed shape onto Tool-kind GraphNodes. Production reads
 * `description` and `inputSchemaJson`; the snake_case `properties_bag`
 * column carries `inputSchemaJson` in the seed but is never read directly
 * by the tool — instead we surface `inputSchemaJson` as a typed field.
 */
function toolNodes(tools: readonly ToolFx[]): FakeNodeLike[] {
  return tools.map((t) => {
    const props = t.propertiesBag ? (JSON.parse(t.propertiesBag) as Record<string, unknown>) : {};
    const inputSchemaJson =
      typeof props["inputSchemaJson"] === "string"
        ? (props["inputSchemaJson"] as string)
        : undefined;
    return {
      id: t.id,
      kind: "Tool",
      name: t.name,
      filePath: t.filePath,
      description: t.description,
      ...(inputSchemaJson !== undefined ? { inputSchemaJson } : {}),
    };
  });
}

async function withHarness(
  tools: readonly ToolFx[],
  fn: (
    ctx: ToolContext,
    server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
  ) => Promise<void>,
): Promise<void> {
  await withMcpHarness(
    {
      tmpPrefix: "codehub-mcp-tool-map-",
      storeFactory: () => makeFakeGraphStore({ nodes: toolNodes(tools) }),
    },
    async ({ server, pool, home }) => {
      const ctx: ToolContext = { pool, home };
      await fn(ctx, server);
    },
  );
}

test("tool_map returns every Tool by default and parses inputSchema JSON", async () => {
  const schema = { type: "object", properties: { name: { type: "string" } } };
  const tools: readonly ToolFx[] = [
    {
      id: "Tool:a.ts:hello",
      name: "hello",
      filePath: "a.ts",
      description: "Say hello",
      propertiesBag: JSON.stringify({ inputSchemaJson: JSON.stringify(schema) }),
    },
    {
      id: "Tool:b.ts:raw",
      name: "raw",
      filePath: "b.ts",
      description: "",
      propertiesBag: null,
    },
  ];
  await withHarness(tools, async (ctx, server) => {
    registerToolMapTool(server, ctx);
    const handler = getToolHandler(server, "tool_map");
    const result = await handler({ repo: "fakerepo" }, {});
    const sc = result.structuredContent as {
      tools: Array<{
        name: string;
        filePath: string;
        description: string;
        inputSchema: unknown | null;
      }>;
      total: number;
    };
    assert.equal(sc.total, 2);
    const hello = sc.tools.find((t) => t.name === "hello");
    assert.ok(hello);
    assert.deepEqual(hello?.inputSchema, schema);
    const raw = sc.tools.find((t) => t.name === "raw");
    assert.equal(raw?.inputSchema, null);
  });
});

test("tool_map filters by name substring", async () => {
  const tools: readonly ToolFx[] = [
    {
      id: "Tool:a.ts:alpha",
      name: "alpha",
      filePath: "a.ts",
      description: "",
      propertiesBag: null,
    },
    {
      id: "Tool:b.ts:beta",
      name: "beta",
      filePath: "b.ts",
      description: "",
      propertiesBag: null,
    },
  ];
  await withHarness(tools, async (ctx, server) => {
    registerToolMapTool(server, ctx);
    const handler = getToolHandler(server, "tool_map");
    const result = await handler({ repo: "fakerepo", tool: "alph" }, {});
    const sc = result.structuredContent as {
      tools: Array<{ name: string }>;
      total: number;
    };
    assert.equal(sc.total, 1);
    assert.equal(sc.tools[0]?.name, "alpha");
  });
});

test("tool_map falls back to raw string when inputSchemaJson is unparseable", async () => {
  const tools: readonly ToolFx[] = [
    {
      id: "Tool:x:t",
      name: "t",
      filePath: "x.ts",
      description: "",
      propertiesBag: JSON.stringify({ inputSchemaJson: "not valid json" }),
    },
  ];
  await withHarness(tools, async (ctx, server) => {
    registerToolMapTool(server, ctx);
    const handler = getToolHandler(server, "tool_map");
    const result = await handler({ repo: "fakerepo" }, {});
    const sc = result.structuredContent as {
      tools: Array<{ inputSchema: unknown }>;
    };
    assert.equal(sc.tools[0]?.inputSchema, "not valid json");
  });
});
