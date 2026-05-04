/**
 * Unit tests for the LLM module-overview renderer.
 *
 * Every test substitutes an in-memory `summarize` function so Bedrock is
 * never contacted. The production Bedrock client path is covered by the
 * summarizer package's own tests.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { SummarizeInput, SummarizerResult } from "@opencodehub/summarizer";
import { buildSummarizerInput, type LlmModuleInput, renderLlmOverviews } from "./llm-overview.js";

function fakeSummary(
  overrides: { purpose?: string; sideEffects?: string[]; invariants?: string[] | null } = {},
): SummarizerResult {
  return {
    summary: {
      purpose:
        overrides.purpose ??
        "Aggregate authentication flows and session bookkeeping for the request lifecycle.",
      inputs: [],
      returns: {
        type: "module",
        type_summary: "aggregated module surface",
        details:
          "A cohesive bundle of login, logout, and session refresh handlers that share token state.",
      },
      side_effects: overrides.sideEffects ?? [
        "writes session state to the Redis cache after successful login",
      ],
      invariants: overrides.invariants === undefined ? null : overrides.invariants,
      citations: [{ field_name: "purpose", line_start: 1, line_end: 5 }],
    },
    attempts: 1,
    usageByAttempt: [{ inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 }],
    wallClockMs: 1,
    validationFailures: [],
  };
}

function makeModule(overrides: Partial<LlmModuleInput> = {}): LlmModuleInput {
  return {
    communityId: overrides.communityId ?? "Community:repo:auth",
    label: overrides.label ?? "Auth Subsystem",
    symbolCount: overrides.symbolCount ?? 12,
    topFiles: overrides.topFiles ?? ["src/auth/login.ts", "src/auth/session.ts"],
    topSymbols: overrides.topSymbols ?? ["loginHandler", "sessionStore"],
  };
}

test("renderLlmOverviews: disabled returns empty map", async () => {
  const out = await renderLlmOverviews([makeModule()], { enabled: false, maxCalls: 5 });
  assert.equal(out.size, 0);
});

test("renderLlmOverviews: happy path produces narrative markdown with purpose + side_effects", async () => {
  let callCount = 0;
  const out = await renderLlmOverviews([makeModule()], {
    enabled: true,
    maxCalls: 1,
    summarize: async (_input: SummarizeInput) => {
      callCount += 1;
      return fakeSummary();
    },
  });
  assert.equal(callCount, 1);
  const entry = out.get("Community:repo:auth");
  assert.ok(entry, "overview should be present");
  assert.equal(entry?.source, "llm");
  assert.match(entry?.markdown ?? "", /### Auth Subsystem/);
  assert.match(entry?.markdown ?? "", /Aggregate authentication flows/);
  assert.match(entry?.markdown ?? "", /Key behaviors:/);
  assert.match(entry?.markdown ?? "", /writes session state/);
});

test("renderLlmOverviews: max_calls=0 is dry-run with zero summarize calls", async () => {
  let called = false;
  const out = await renderLlmOverviews(
    [
      makeModule(),
      makeModule({ communityId: "Community:repo:billing", label: "Billing", symbolCount: 8 }),
    ],
    {
      enabled: true,
      maxCalls: 0,
      summarize: async () => {
        called = true;
        return fakeSummary();
      },
    },
  );
  assert.equal(called, false, "summarize must not be invoked when maxCalls is 0");
  assert.equal(out.size, 2);
  for (const [, overview] of out) {
    assert.equal(overview.source, "dry-run");
    assert.match(overview.markdown, /dry-run/);
  }
});

test("renderLlmOverviews: ranks top-N by symbolCount, overflow modules get capacity placeholder", async () => {
  const summarizeCalls: string[] = [];
  const modules = [
    makeModule({ communityId: "c:a", label: "Small", symbolCount: 2 }),
    makeModule({ communityId: "c:b", label: "Large", symbolCount: 50 }),
    makeModule({ communityId: "c:c", label: "Medium", symbolCount: 20 }),
  ];
  const out = await renderLlmOverviews(modules, {
    enabled: true,
    maxCalls: 2,
    summarize: async (input: SummarizeInput) => {
      summarizeCalls.push(input.filePath);
      return fakeSummary({ purpose: `Summary for ${input.filePath}` });
    },
  });

  assert.equal(summarizeCalls.length, 2, "should call summarizer exactly maxCalls times");
  assert.ok(
    summarizeCalls.some((p) => p.endsWith("/c:b")),
    "Large (50) should be summarized",
  );
  assert.ok(
    summarizeCalls.some((p) => p.endsWith("/c:c")),
    "Medium (20) should be summarized",
  );
  assert.equal(out.get("c:a")?.source, "dry-run", "Small should be capacity-skipped");
  assert.match(out.get("c:a")?.markdown ?? "", /capacity exhausted/);
  assert.equal(out.get("c:b")?.source, "llm");
  assert.equal(out.get("c:c")?.source, "llm");
});

test("renderLlmOverviews: summarizer failure yields deterministic fallback entry, continues", async () => {
  const modules = [
    makeModule({ communityId: "c:ok", label: "Ok", symbolCount: 10 }),
    makeModule({ communityId: "c:bad", label: "Bad", symbolCount: 5 }),
  ];
  const out = await renderLlmOverviews(modules, {
    enabled: true,
    maxCalls: 2,
    summarize: async (input: SummarizeInput) => {
      if (input.filePath.endsWith("/c:bad")) {
        throw new Error("bedrock transport failed");
      }
      return fakeSummary();
    },
  });
  assert.equal(out.size, 2);
  assert.equal(out.get("c:ok")?.source, "llm");
  assert.equal(out.get("c:bad")?.source, "fallback");
  assert.match(out.get("c:bad")?.markdown ?? "", /summarizer failed/);
  assert.match(out.get("c:bad")?.markdown ?? "", /bedrock transport failed/);
});

test("renderLlmOverviews: ordering is stable (symbolCount desc, label asc, id asc)", async () => {
  const modules: LlmModuleInput[] = [
    makeModule({ communityId: "c:z", label: "Zed", symbolCount: 10 }),
    makeModule({ communityId: "c:a", label: "Alpha", symbolCount: 10 }),
    makeModule({ communityId: "c:x", label: "Mid", symbolCount: 20 }),
  ];
  const order: string[] = [];
  await renderLlmOverviews(modules, {
    enabled: true,
    maxCalls: 3,
    summarize: async (input: SummarizeInput) => {
      order.push(input.filePath);
      return fakeSummary();
    },
  });
  assert.deepEqual(order, [
    "<synthetic>/module/c:x", // 20
    "<synthetic>/module/c:a", // 10, Alpha < Zed
    "<synthetic>/module/c:z", // 10, Zed
  ]);
});

test("buildSummarizerInput: encodes module structure in a line-addressable block", () => {
  const input = buildSummarizerInput(
    makeModule({
      topFiles: ["a.ts", "b.ts"],
      topSymbols: ["fnA", "fnB", "ClassC"],
    }),
  );
  assert.match(input.source, /module: Auth Subsystem/);
  assert.match(input.source, /symbol_count: 12/);
  assert.match(input.source, /key_files:/);
  assert.match(input.source, /- a\.ts/);
  assert.match(input.source, /- fnA/);
  assert.equal(input.lineStart, 1);
  assert.ok(input.lineEnd > 1);
  assert.equal(input.enclosingClass, null);
  assert.match(input.filePath, /^<synthetic>\/module\//);
});

test("buildSummarizerInput: tolerates empty top lists", () => {
  const input = buildSummarizerInput(makeModule({ topFiles: [], topSymbols: [] }));
  assert.match(input.source, /key_files:\n {2}\(none\)/);
  assert.match(input.source, /key_symbols:\n {2}\(none\)/);
});
