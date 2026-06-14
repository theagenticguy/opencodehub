// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures
/**
 * CLI <-> MCP parity for change-pack — MCP half.
 *
 * Both surfaces delegate to the single `@opencodehub/analysis.runChangePack`
 * core, so they cannot disagree on VALUES. They differ only in serialization:
 *
 *   - CLI (`packages/cli/src/commands/change-pack.ts:67`): emits the raw
 *     camelCase ChangePack via `JSON.stringify(pack, null, 2)` — a PURE
 *     passthrough, no reshaping. The CLI half of parity (that `--json` equals
 *     the raw pack) is asserted in `packages/cli/.../change-pack.test.ts`.
 *   - MCP (this package, `toStructured`): recases the top-level keys plus the
 *     interiors of `impacted_subgraph` and `cost_attribution` to snake_case,
 *     leaving nested array elements and the verdict camelCase.
 *
 * The MCP `toStructured` recasing is the ONLY place the two surfaces can drift
 * in serialization, so this test pins it: `toStructured(pack)` must recase
 * LOSSLESSLY — recasing it back must reproduce the raw pack value-for-value.
 * A field `toStructured` drops or a key it mis-spells cannot round-trip, so
 * this guards every field of the shared contract. Cross-package source import
 * is deliberately avoided (it violates the MCP package `rootDir`); the CLI
 * passthrough is verified in the CLI package's own hermetic test.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ChangePack, CostAttribution, ImpactedSubgraph } from "@opencodehub/analysis";
import { toStructured } from "./change-pack.js";

// One realistic ChangePack — the value contract both surfaces must preserve.
const FIXTURE: ChangePack = {
  changedFiles: ["src/auth/token.ts", "src/auth/session.ts"],
  changedSymbols: [
    {
      id: "Function:src/auth/token.ts:refreshToken#1",
      name: "refreshToken",
      filePath: "src/auth/token.ts",
      kind: "Function",
    },
    {
      id: "Method:src/auth/session.ts:Session.rotate#0",
      name: "Session.rotate",
      filePath: "src/auth/session.ts",
      kind: "Method",
    },
  ],
  impactedSubgraph: {
    nodes: [
      {
        id: "Function:src/api/login.ts:handleLogin#1",
        name: "handleLogin",
        filePath: "src/api/login.ts",
        kind: "Function",
        minDepth: 1,
      },
      {
        id: "Function:src/api/refresh.ts:handleRefresh#1",
        name: "handleRefresh",
        filePath: "src/api/refresh.ts",
        kind: "Function",
        minDepth: 2,
      },
    ],
    edges: [
      {
        fromId: "Function:src/api/login.ts:handleLogin#1",
        toId: "Function:src/auth/token.ts:refreshToken#1",
        type: "CALLS",
        confidence: 1,
      },
    ],
    nodeCount: 2,
    edgeCount: 1,
    truncated: false,
  } satisfies ImpactedSubgraph,
  verdict: {
    verdict: "dual_review",
    confidence: 0.82,
    decisionBoundary: { distancePercent: 40, nextTier: "expert_review" },
    reasoningChain: [{ label: "blastRadius", value: 12, severity: "warn" }],
    recommendedReviewers: [],
    githubLabels: ["review:dual"],
    reviewCommentMarkdown: "## Verdict: dual_review\n",
    exitCode: 1,
    blastRadius: 12,
    communitiesTouched: ["auth"],
    changedFileCount: 2,
    changedFiles: ["src/auth/token.ts", "src/auth/session.ts"],
    affectedSymbolCount: 2,
  },
  affectedTests: [
    {
      id: "Function:src/auth/token.test.ts:refreshToken_expiry#0",
      name: "refreshToken_expiry",
      filePath: "src/auth/token.test.ts",
      reachedFromSymbol: "Function:src/auth/token.ts:refreshToken#1",
      depth: 1,
    },
  ],
  costAttribution: {
    estimate: true,
    tokenizerModel: "char-heuristic-v1",
    changePackTokens: 1280,
    blindBaselineTokens: 9600,
    tokensSaved: 8320,
    tokensSavedPct: 87,
    affectedTestCount: 1,
    totalTestCount: 40,
    ciTestsSkipped: 39,
  } satisfies CostAttribution,
  changePackHash: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
};

/**
 * Recase the MCP snake_case payload back to CLI camelCase using the EXACT
 * partial map `toStructured` applies: top-level keys + the interiors of
 * impacted_subgraph and cost_attribution; nested element objects and the
 * verdict stay camelCase.
 */
function mcpToCamel(mcp: Record<string, unknown>): Record<string, unknown> {
  const sub = mcp["impacted_subgraph"] as Record<string, unknown>;
  const cost = mcp["cost_attribution"] as Record<string, unknown>;
  return {
    changedFiles: mcp["changed_files"],
    changedSymbols: mcp["changed_symbols"],
    impactedSubgraph: {
      nodes: sub["nodes"],
      edges: sub["edges"],
      nodeCount: sub["node_count"],
      edgeCount: sub["edge_count"],
      truncated: sub["truncated"],
    },
    verdict: mcp["verdict"],
    affectedTests: mcp["affected_tests"],
    costAttribution: {
      estimate: cost["estimate"],
      tokenizerModel: cost["tokenizer_model"],
      changePackTokens: cost["change_pack_tokens"],
      blindBaselineTokens: cost["blind_baseline_tokens"],
      tokensSaved: cost["tokens_saved"],
      tokensSavedPct: cost["tokens_saved_pct"],
      affectedTestCount: cost["affected_test_count"],
      totalTestCount: cost["total_test_count"],
      ciTestsSkipped: cost["ci_tests_skipped"],
    },
    changePackHash: mcp["change_pack_hash"],
  };
}

test("MCP toStructured recases losslessly — values match the raw CLI pack", () => {
  // The CLI emits exactly this raw object (JSON round-trip models its
  // JSON.stringify passthrough). The MCP payload, recased back, must equal it.
  const cliRaw = JSON.parse(JSON.stringify(FIXTURE)) as Record<string, unknown>;
  const mcpCamel = mcpToCamel(toStructured(FIXTURE));
  assert.deepEqual(
    mcpCamel,
    cliRaw,
    "MCP structuredContent must carry identical values to the CLI's raw ChangePack",
  );
});

test("content hash is preserved verbatim through the MCP recasing", () => {
  assert.equal(toStructured(FIXTURE)["change_pack_hash"], FIXTURE.changePackHash);
});

test("cost attribution stays an estimate with values intact through MCP", () => {
  const cost = toStructured(FIXTURE)["cost_attribution"] as Record<string, unknown>;
  assert.equal(cost["estimate"], true);
  assert.equal(cost["tokenizer_model"], "char-heuristic-v1");
  assert.equal(cost["tokens_saved"], FIXTURE.costAttribution.tokensSaved);
  assert.equal(cost["ci_tests_skipped"], FIXTURE.costAttribution.ciTestsSkipped);
});

test("no ChangePack field is dropped by toStructured", () => {
  // Every top-level ChangePack key must be represented in the recased payload.
  const recased = mcpToCamel(toStructured(FIXTURE));
  for (const key of Object.keys(FIXTURE)) {
    assert.ok(key in recased, `toStructured dropped top-level field: ${key}`);
    assert.notEqual(
      (recased as Record<string, unknown>)[key],
      undefined,
      `toStructured produced undefined for: ${key}`,
    );
  }
});
