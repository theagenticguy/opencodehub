// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { getToolHandler, makeFakeGraphStore, withMcpHarness } from "../test-utils.js";
import { registerChangePackTool } from "./change-pack.js";
import type { ToolContext } from "./shared.js";

/**
 * The analysis `runChangePack` never throws — it fails open to an empty diff
 * when git is unavailable (which it is in the temp harness repo). That gives
 * the MCP tool a coherent, deterministic ChangePack to wrap without needing a
 * real graph store or a git checkout. These tests assert the snake_case
 * `structuredContent` shape the CLI parity test keys against.
 */
async function withHarness(
  fn: (
    ctx: ToolContext,
    server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
  ) => Promise<void>,
): Promise<void> {
  await withMcpHarness(
    {
      tmpPrefix: "codehub-mcp-change-pack-",
      storeFactory: () => makeFakeGraphStore(),
    },
    async ({ server, pool, home }) => {
      const ctx: ToolContext = { pool, home };
      await fn(ctx, server);
    },
  );
}

interface StructuredChangePack {
  changed_files: unknown[];
  changed_symbols: unknown[];
  impacted_subgraph: {
    nodes: unknown[];
    edges: unknown[];
    node_count: number;
    edge_count: number;
    truncated: boolean;
  };
  verdict: { verdict: string; exitCode: number };
  affected_tests: unknown[];
  cost_attribution: {
    estimate: boolean;
    tokenizer_model: string;
    change_pack_tokens: number;
    blind_baseline_tokens: number;
    tokens_saved: number;
    tokens_saved_pct: number;
    affected_test_count: number;
    total_test_count: number;
    ci_tests_skipped: number;
  };
  change_pack_hash: string;
  next_steps: string[];
}

test("change_pack returns the snake_case structuredContent envelope", async () => {
  await withHarness(async (ctx, server) => {
    registerChangePackTool(server, ctx);
    const handler = getToolHandler(server, "change_pack");
    const result = await handler({ repo: "fakerepo" }, {});
    assert.equal(result.isError, undefined);
    const sc = result.structuredContent as unknown as StructuredChangePack;

    // Top-level snake_case keys present.
    assert.ok(Array.isArray(sc.changed_files));
    assert.ok(Array.isArray(sc.changed_symbols));
    assert.ok(Array.isArray(sc.affected_tests));
    assert.ok(sc.impacted_subgraph);
    assert.ok(sc.verdict);
    assert.ok(sc.cost_attribution);

    // Impacted subgraph counts are snake_cased and numeric.
    assert.equal(typeof sc.impacted_subgraph.node_count, "number");
    assert.equal(typeof sc.impacted_subgraph.edge_count, "number");
    assert.equal(typeof sc.impacted_subgraph.truncated, "boolean");
  });
});

test("change_pack cost attribution reports real o200k_base token counts", async () => {
  await withHarness(async (ctx, server) => {
    registerChangePackTool(server, ctx);
    const handler = getToolHandler(server, "change_pack");
    const result = await handler({ repo: "fakerepo" }, {});
    const sc = result.structuredContent as unknown as StructuredChangePack;

    assert.equal(sc.cost_attribution.estimate, false);
    assert.equal(sc.cost_attribution.tokenizer_model, "openai/o200k_base");
    assert.equal(typeof sc.cost_attribution.change_pack_tokens, "number");
    assert.equal(typeof sc.cost_attribution.blind_baseline_tokens, "number");
    assert.equal(typeof sc.cost_attribution.tokens_saved, "number");
    assert.equal(typeof sc.cost_attribution.tokens_saved_pct, "number");
    assert.equal(typeof sc.cost_attribution.affected_test_count, "number");
    assert.equal(typeof sc.cost_attribution.total_test_count, "number");
    assert.equal(typeof sc.cost_attribution.ci_tests_skipped, "number");
  });
});

test("change_pack hash is a deterministic hex string", async () => {
  await withHarness(async (ctx, server) => {
    registerChangePackTool(server, ctx);
    const handler = getToolHandler(server, "change_pack");
    const first = await handler({ repo: "fakerepo" }, {});
    const second = await handler({ repo: "fakerepo" }, {});
    const a = (first.structuredContent as unknown as StructuredChangePack).change_pack_hash;
    const b = (second.structuredContent as unknown as StructuredChangePack).change_pack_hash;

    assert.equal(typeof a, "string");
    assert.ok(/^[0-9a-f]+$/.test(a), `expected hex hash, got ${a}`);
    // Identical inputs hash alike — the envelope folds the query into the hash.
    assert.equal(a, b);
  });
});

test("change_pack carries next_steps toward verdict and impact", async () => {
  await withHarness(async (ctx, server) => {
    registerChangePackTool(server, ctx);
    const handler = getToolHandler(server, "change_pack");
    const result = await handler({ repo: "fakerepo" }, {});
    const sc = result.structuredContent as unknown as StructuredChangePack;

    assert.ok(Array.isArray(sc.next_steps));
    assert.ok(sc.next_steps.some((s) => s.includes("verdict")));
    assert.ok(sc.next_steps.some((s) => s.includes("impact")));
  });
});

test("change_pack threads optional knobs through without error", async () => {
  await withHarness(async (ctx, server) => {
    registerChangePackTool(server, ctx);
    const handler = getToolHandler(server, "change_pack");
    const result = await handler(
      {
        repo: "fakerepo",
        base: "main",
        head: "HEAD",
        depth: 2,
        minConfidence: 1,
        budget: 50_000,
        includeTestsInSubgraph: true,
      },
      {},
    );
    assert.equal(result.isError, undefined);
    const sc = result.structuredContent as unknown as StructuredChangePack;
    assert.equal(sc.cost_attribution.estimate, false);
  });
});
