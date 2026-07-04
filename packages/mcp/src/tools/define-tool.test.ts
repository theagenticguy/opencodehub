/**
 * Unit tests for the `defineTool` factory — the register + `withStore` +
 * try/catch + `withNextSteps` envelope + `toToolResult` boilerplate the reader
 * tools share. Exercises one fake capability through the real MCP harness so
 * the register wiring, the success envelope, and the error path are all covered
 * in one place (a table-driven test beats N per-tool copies).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Capability } from "@opencodehub/core-ops";
import { getToolHandler, makeFakeGraphStore, withMcpHarness } from "../test-utils.js";
import { defineTool } from "./define-tool.js";
import { repoArgShape, type ToolContext } from "./shared.js";

interface EchoInput {
  readonly repo?: string;
  readonly repo_uri?: string;
  readonly label?: string;
}
interface EchoOutput {
  readonly repoName: string;
  readonly label: string;
}

/** A fake capability that echoes the resolved repo name + a label. */
const echoCapability: Capability<EchoInput, EchoOutput> = {
  id: "echo",
  async execute(input, ctx) {
    return { repoName: ctx.repoName, label: input.label ?? "(none)" };
  },
};

/** A fake capability that always throws, to drive the error path. */
const boomCapability: Capability<EchoInput, EchoOutput> = {
  id: "boom",
  async execute() {
    throw new Error("kaboom");
  },
};

const echoTool = defineTool<EchoInput, EchoInput, EchoOutput>({
  name: "echo",
  title: "Echo",
  description: "Echo a label back with the resolved repo name.",
  inputSchema: { ...repoArgShape },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
  capability: echoCapability,
  toInput: (args) => ({ ...(args.label !== undefined ? { label: args.label } : {}) }),
  present: (out) => ({
    text: `echo ${out.repoName}: ${out.label}`,
    structured: { repoName: out.repoName, label: out.label },
    nextSteps: ["call `echo` again"],
  }),
});

const boomTool = defineTool<EchoInput, EchoInput, EchoOutput>({
  name: "boom",
  title: "Boom",
  description: "Always throws.",
  inputSchema: { ...repoArgShape },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
  capability: boomCapability,
  toInput: () => ({}),
  present: (out) => ({ text: "unreachable", structured: { out }, nextSteps: [] }),
});

async function withHarness(
  fn: (
    ctx: ToolContext,
    server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
  ) => Promise<void>,
): Promise<void> {
  await withMcpHarness(
    { tmpPrefix: "codehub-define-tool-", storeFactory: () => makeFakeGraphStore({}) },
    async ({ server, pool, home }) => {
      await fn({ pool, home }, server);
    },
  );
}

test("defineTool: register + run wires the SDK handler under the wire name", async () => {
  await withHarness(async (ctx, server) => {
    echoTool.register(server, ctx);
    // A handler must exist under the exact wire name.
    const handler = getToolHandler(server, "echo");
    assert.ok(handler, "handler registered under wire name 'echo'");
  });
});

test("defineTool: success path renders present() into the withNextSteps envelope", async () => {
  await withHarness(async (ctx, server) => {
    echoTool.register(server, ctx);
    const handler = getToolHandler(server, "echo");
    const result = await handler({ repo: "fakerepo", label: "hello" }, {});
    const first = result.content[0];
    assert.ok(first && first.type === "text");
    // Presenter body + the withNextSteps "Suggested next tools" block.
    assert.match(first.text, /echo fakerepo: hello/);
    assert.match(first.text, /Suggested next tools:/);
    assert.match(first.text, /call `echo` again/);
    const sc = result.structuredContent as {
      repoName: string;
      label: string;
      next_steps: string[];
      _meta?: Record<string, unknown>;
    };
    assert.equal(sc.repoName, "fakerepo");
    assert.equal(sc.label, "hello");
    assert.deepEqual(sc.next_steps, ["call `echo` again"]);
    assert.notEqual(result.isError, true);
  });
});

test("defineTool: run() returns the same structuredContent as the SDK handler", async () => {
  await withHarness(async (ctx) => {
    const viaRun = await echoTool.run(ctx, { repo: "fakerepo", label: "x" });
    const sc = viaRun.structuredContent as { repoName: string; label: string };
    assert.equal(sc.repoName, "fakerepo");
    assert.equal(sc.label, "x");
    assert.match(viaRun.text, /echo fakerepo: x/);
  });
});

test("defineTool: a throwing capability is mapped to an INTERNAL error envelope", async () => {
  await withHarness(async (ctx, server) => {
    boomTool.register(server, ctx);
    const handler = getToolHandler(server, "boom");
    const result = await handler({ repo: "fakerepo" }, {});
    assert.equal(result.isError, true);
    const sc = result.structuredContent as { error: { code: string; message: string } };
    assert.equal(sc.error.code, "INTERNAL");
    assert.match(sc.error.message, /kaboom/);
  });
});
