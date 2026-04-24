/**
 * `codehub verdict` CLI surface tests.
 *
 * Covers:
 *   1. Default flags → summary renderer, exit 0.
 *   2. `--json` alias → JSON output with no markdown blocks.
 *   3. `--output-format markdown` → markdown header present.
 *   4. `--pr-comment` on a block-tier fixture → markdown only, exit 3.
 *   5. `--exit-code` on auto_merge tier → exit 0.
 *
 * Each test injects a stub `computeVerdictFn` + a fake store so nothing
 * hits DuckDB or git. The CLI's real exit-code ladder (0/1/2/3) is what
 * the assertions target, so the test pinsbehavior — not the
 * analysis module's 0/1/2 mapping.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  VerdictConfig,
  VerdictQuery,
  VerdictResponse,
  VerdictTier,
} from "@opencodehub/analysis";
import type { IGraphStore } from "@opencodehub/storage";
import { resolveVerdictMode, runVerdict } from "./verdict.js";
import { cliExitCodeForTier } from "./verdict-render.js";

// --- fixtures --------------------------------------------------------------

function fakeStore(): IGraphStore {
  const unreachable = () => {
    throw new Error("fakeStore used for a real query — test is mis-wired");
  };
  return {
    open: async () => undefined,
    close: async () => undefined,
    createSchema: unreachable,
    bulkLoad: unreachable,
    upsertEmbeddings: unreachable,
    query: async () => [],
    search: async () => [],
    vectorSearch: async () => [],
    traverse: async () => [],
    getMeta: async () => undefined,
    setMeta: async () => undefined,
    healthCheck: async () => ({ ok: true }),
  } as unknown as IGraphStore;
}

function stubStoreFactory(): () => Promise<{ store: IGraphStore; repoPath: string }> {
  return async () => ({ store: fakeStore(), repoPath: "/tmp/fake-repo" });
}

function verdictFixture(
  tier: VerdictTier,
  overrides: Partial<VerdictResponse> = {},
): VerdictResponse {
  const base: VerdictResponse = {
    verdict: tier,
    confidence: 0.87,
    decisionBoundary: { distancePercent: 42, nextTier: "expert_review" },
    reasoningChain: [
      { label: "blast_radius", value: 42, severity: "error" },
      { label: "tier", value: tier, severity: tier === "auto_merge" ? "info" : "error" },
    ],
    recommendedReviewers: [
      { email: "alice@example.com", emailHash: "abc", name: "Alice", weight: 0.82 },
    ],
    githubLabels: ["review:expert"],
    reviewCommentMarkdown: `## OpenCodeHub Verdict: \`${tier}\`\n\nBlast radius: 42`,
    exitCode: 2,
    blastRadius: 42,
    communitiesTouched: ["c1", "c2", "c3"],
    changedFileCount: 7,
    affectedSymbolCount: 19,
  };
  return { ...base, ...overrides };
}

function stubCompute(
  tier: VerdictTier,
  overrides: Partial<VerdictResponse> = {},
): (store: IGraphStore, query: VerdictQuery) => Promise<VerdictResponse> {
  return async () => verdictFixture(tier, overrides);
}

interface StdoutCapture {
  readonly chunks: string[];
  restore(): void;
}

function captureStdout(): StdoutCapture {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    if (typeof encodingOrCb === "function") encodingOrCb();
    else if (typeof cb === "function") cb();
    return true;
  }) as typeof process.stdout.write;
  return {
    chunks,
    restore: () => {
      process.stdout.write = orig;
    },
  };
}

async function withExitCode<T>(fn: () => Promise<T>): Promise<{ result: T; exitCode: number }> {
  const prev = process.exitCode;
  process.exitCode = 0;
  try {
    const result = await fn();
    const exitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
    return { result, exitCode };
  } finally {
    process.exitCode = prev;
  }
}

// --- tests -----------------------------------------------------------------

test("resolveVerdictMode: default → summary with exit-code on", () => {
  const mode = resolveVerdictMode({});
  assert.equal(mode.format, "summary");
  assert.equal(mode.exitCode, true);
});

test("resolveVerdictMode: --json defaults to exit-code off (backward compat)", () => {
  const mode = resolveVerdictMode({ outputFormat: "json" });
  assert.equal(mode.format, "json");
  assert.equal(mode.exitCode, false);
});

test("resolveVerdictMode: --pr-comment forces markdown + exit-code on", () => {
  const mode = resolveVerdictMode({ prComment: true });
  assert.equal(mode.format, "markdown");
  assert.equal(mode.exitCode, true);
});

test("cliExitCodeForTier maps the 0/1/2/3 ladder", () => {
  assert.equal(cliExitCodeForTier("auto_merge"), 0);
  assert.equal(cliExitCodeForTier("single_review"), 1);
  assert.equal(cliExitCodeForTier("dual_review"), 1);
  assert.equal(cliExitCodeForTier("expert_review"), 2);
  assert.equal(cliExitCodeForTier("block"), 3);
});

test("runVerdict default (no flags) → summary render, exit 0 on auto_merge", async () => {
  const cap = captureStdout();
  const { exitCode } = await withExitCode(async () => {
    try {
      await runVerdict({
        storeFactory: stubStoreFactory(),
        computeVerdictFn: stubCompute("auto_merge", {
          reasoningChain: [
            { label: "blast_radius", value: 0, severity: "info" },
            { label: "tier", value: "auto_merge", severity: "info" },
          ],
          verdict: "auto_merge",
        }),
      });
    } finally {
      cap.restore();
    }
  });
  const output = cap.chunks.join("");
  assert.match(output, /Verdict:/);
  assert.match(output, /Blast radius:/);
  assert.match(output, /Reasoning:/);
  assert.doesNotMatch(output, /^## OpenCodeHub Verdict/m);
  assert.equal(exitCode, 0);
});

test("runVerdict --json emits JSON, no markdown header", async () => {
  const cap = captureStdout();
  const { exitCode } = await withExitCode(async () => {
    try {
      await runVerdict({
        outputFormat: "json",
        storeFactory: stubStoreFactory(),
        computeVerdictFn: stubCompute("expert_review"),
      });
    } finally {
      cap.restore();
    }
  });
  const output = cap.chunks.join("");
  // Should parse as JSON.
  const parsed = JSON.parse(output) as Record<string, unknown>;
  assert.equal(parsed["verdict"], "expert_review");
  assert.ok("reviewCommentMarkdown" in parsed);
  // JSON mode never invokes the markdown renderer as the outer format.
  assert.doesNotMatch(output, /^## OpenCodeHub Verdict/m);
  // JSON mode defaults to exit-code off (backward compat with old --json).
  assert.equal(exitCode, 0);
});

test("runVerdict --output-format markdown → markdown, exit 0 without --exit-code", async () => {
  const cap = captureStdout();
  const { exitCode } = await withExitCode(async () => {
    try {
      await runVerdict({
        outputFormat: "markdown",
        exitCode: false,
        storeFactory: stubStoreFactory(),
        computeVerdictFn: stubCompute("expert_review"),
      });
    } finally {
      cap.restore();
    }
  });
  const output = cap.chunks.join("");
  assert.match(output, /## OpenCodeHub Verdict: `expert_review`/);
  assert.equal(exitCode, 0);
});

test("runVerdict --pr-comment on block tier → markdown-only, exit 3", async () => {
  const cap = captureStdout();
  const { exitCode } = await withExitCode(async () => {
    try {
      await runVerdict({
        prComment: true,
        storeFactory: stubStoreFactory(),
        computeVerdictFn: stubCompute("block", {
          reviewCommentMarkdown: "## OpenCodeHub Verdict: `block` — BLOCK\n\n**Blast radius:** 80",
        }),
      });
    } finally {
      cap.restore();
    }
  });
  const output = cap.chunks.join("");
  assert.match(output, /^## OpenCodeHub Verdict: `block`/m);
  assert.match(output, /\*\*Blast radius:\*\* 80/);
  // No ANSI escapes — pr-comment must be shell-safe.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: testing for ANSI absence
  assert.doesNotMatch(output, /\x1b\[/);
  assert.equal(exitCode, 3);
});

test("runVerdict --exit-code on auto_merge → exit 0", async () => {
  const cap = captureStdout();
  const { exitCode } = await withExitCode(async () => {
    try {
      await runVerdict({
        outputFormat: "summary",
        exitCode: true,
        storeFactory: stubStoreFactory(),
        computeVerdictFn: stubCompute("auto_merge"),
      });
    } finally {
      cap.restore();
    }
  });
  assert.equal(exitCode, 0);
});

test("runVerdict --exit-code on single_review → exit 1 (ladder distinguishes from auto_merge)", async () => {
  const cap = captureStdout();
  const { exitCode } = await withExitCode(async () => {
    try {
      await runVerdict({
        outputFormat: "summary",
        exitCode: true,
        storeFactory: stubStoreFactory(),
        computeVerdictFn: stubCompute("single_review"),
      });
    } finally {
      cap.restore();
    }
  });
  assert.equal(exitCode, 1);
});

test("runVerdict propagates base/head/config to the compute fn", async () => {
  const cap = captureStdout();
  let seen: VerdictQuery | undefined;
  try {
    await runVerdict({
      base: "release",
      head: "feature/x",
      configOverrides: { blockThreshold: 99 },
      outputFormat: "json",
      storeFactory: stubStoreFactory(),
      computeVerdictFn: async (_store, query) => {
        seen = query;
        return verdictFixture("auto_merge");
      },
    });
  } finally {
    cap.restore();
  }
  assert.ok(seen);
  assert.equal(seen?.base, "release");
  assert.equal(seen?.head, "feature/x");
  const config: Partial<VerdictConfig> | undefined = seen?.config;
  assert.equal(config?.blockThreshold, 99);
});
