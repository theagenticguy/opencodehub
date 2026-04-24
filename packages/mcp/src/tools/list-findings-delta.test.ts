/**
 * Tests for `list_findings_delta`. Each test writes `.codehub/scan.sarif`
 * (and optionally `.codehub/baseline.sarif`) into a tmpdir repo, registers
 * that repo, invokes the tool's registered handler, and asserts the
 * bucketing reported in `structuredContent.findings.*`.
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
import type { SarifLog } from "@opencodehub/sarif";
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
import { registerListFindingsDeltaTool } from "./list-findings-delta.js";
import type { ToolContext } from "./shared.js";

function makeFakeStore(): DuckDbStore {
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
      _sql: string,
      _params: readonly SqlParam[] = [],
    ): Promise<readonly Record<string, unknown>[]> => [],
    search: async (_q: SearchQuery): Promise<readonly SearchResult[]> => [],
    vectorSearch: async (_q: VectorQuery): Promise<readonly VectorResult[]> => [],
    traverse: async (_q: TraverseQuery): Promise<readonly TraverseResult[]> => [],
    getMeta: async (): Promise<StoreMeta | undefined> => undefined,
    setMeta: async (_m: StoreMeta): Promise<void> => {},
    healthCheck: async () => ({ ok: true }),
  } as unknown as DuckDbStore;
  return api;
}

interface ResultInit {
  readonly ruleId: string;
  readonly uri: string;
  readonly startLine: number;
  readonly messageText?: string;
  readonly level?: "none" | "note" | "warning" | "error";
  readonly fingerprint?: string;
}

function makeResult(init: ResultInit): Record<string, unknown> {
  const partialFingerprints: Record<string, string> = {};
  if (init.fingerprint !== undefined) partialFingerprints["opencodehub/v1"] = init.fingerprint;
  return {
    ruleId: init.ruleId,
    level: init.level ?? "warning",
    message: { text: init.messageText ?? "finding" },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: init.uri },
          region: { startLine: init.startLine },
        },
      },
    ],
    ...(Object.keys(partialFingerprints).length > 0 ? { partialFingerprints } : {}),
  };
}

function makeLog(results: readonly ResultInit[], toolName = "semgrep"): SarifLog {
  return {
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: toolName, version: "1.0.0" } },
        results: results.map(makeResult),
      },
    ],
  };
}

interface HarnessFiles {
  readonly scan?: SarifLog;
  readonly baseline?: SarifLog;
}

async function withHarness(
  files: HarnessFiles,
  fn: (ctx: ToolContext, server: McpServer, repoName: string) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(resolve(tmpdir(), "codehub-mcp-findings-delta-"));
  try {
    const repoPath = resolve(home, "fakerepo");
    const codehubDir = resolve(repoPath, ".codehub");
    await mkdir(codehubDir, { recursive: true });
    if (files.scan !== undefined) {
      await writeFile(
        resolve(codehubDir, "scan.sarif"),
        `${JSON.stringify(files.scan, null, 2)}\n`,
        "utf8",
      );
    }
    if (files.baseline !== undefined) {
      await writeFile(
        resolve(codehubDir, "baseline.sarif"),
        `${JSON.stringify(files.baseline, null, 2)}\n`,
        "utf8",
      );
    }
    const regDir = resolve(home, ".codehub");
    await mkdir(regDir, { recursive: true });
    await writeFile(
      resolve(regDir, "registry.json"),
      JSON.stringify({
        fakerepo: {
          name: "fakerepo",
          path: repoPath,
          indexedAt: "2026-04-18T00:00:00Z",
          nodeCount: 0,
          edgeCount: 0,
          lastCommit: "abc123",
        },
      }),
    );
    const pool = new ConnectionPool({ max: 2, ttlMs: 60_000 }, async () => makeFakeStore());
    const ctx: ToolContext = { pool, home };
    const server = new McpServer(
      { name: "test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    try {
      await fn(ctx, server, "fakerepo");
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

interface DeltaStructured {
  readonly summary: { new: number; fixed: number; unchanged: number; updated: number };
  readonly findings: {
    readonly new: Array<{ ruleId: string; baselineState: string; filePath: string }>;
    readonly fixed: unknown[];
    readonly unchanged: unknown[];
    readonly updated: unknown[];
  };
  readonly warnings: string[];
}

test("list_findings_delta: baseline identical to current → all unchanged", async () => {
  const log = makeLog([
    { ruleId: "r.xss", uri: "web/a.ts", startLine: 10, fingerprint: "a".repeat(32) },
    { ruleId: "r.sqli", uri: "api/b.ts", startLine: 20, fingerprint: "b".repeat(32) },
  ]);
  await withHarness({ scan: log, baseline: log }, async (ctx, server, repoName) => {
    registerListFindingsDeltaTool(server, ctx);
    const handler = getHandler(server, "list_findings_delta");
    const result = await handler({ repo: repoName }, {});
    const sc = result.structuredContent as unknown as DeltaStructured;
    assert.equal(sc.summary.new, 0);
    assert.equal(sc.summary.fixed, 0);
    assert.equal(sc.summary.updated, 0);
    assert.equal(sc.summary.unchanged, 2);
    assert.equal(sc.warnings.length, 0);
  });
});

test("list_findings_delta: one new finding in current is bucketed as new", async () => {
  const baseline = makeLog([
    { ruleId: "r.xss", uri: "web/a.ts", startLine: 10, fingerprint: "a".repeat(32) },
  ]);
  const current = makeLog([
    { ruleId: "r.xss", uri: "web/a.ts", startLine: 10, fingerprint: "a".repeat(32) },
    {
      ruleId: "r.sqli",
      uri: "api/b.ts",
      startLine: 20,
      fingerprint: "b".repeat(32),
      level: "error",
      messageText: "SQL injection",
    },
  ]);
  await withHarness({ scan: current, baseline }, async (ctx, server, repoName) => {
    registerListFindingsDeltaTool(server, ctx);
    const handler = getHandler(server, "list_findings_delta");
    const result = await handler({ repo: repoName }, {});
    const sc = result.structuredContent as unknown as DeltaStructured;
    assert.equal(sc.summary.new, 1);
    assert.equal(sc.summary.unchanged, 1);
    assert.equal(sc.summary.fixed, 0);
    assert.equal(sc.summary.updated, 0);
    assert.equal(sc.findings.new[0]?.ruleId, "r.sqli");
    assert.equal(sc.findings.new[0]?.baselineState, "new");
    assert.equal(sc.findings.new[0]?.filePath, "api/b.ts");
  });
});

test("list_findings_delta: same fingerprint at a new file path is bucketed as unchanged (rename preserved by fingerprint)", async () => {
  // `diffSarif` matches primarily on the `opencodehub/v1` fingerprint; two
  // results that share the fingerprint but differ in nothing beyond the
  // primary-location URI bucket as `updated` (URI is part of the
  // equality signature). We assert the cross-rename payload survives: the
  // baseline fingerprint is NOT reported as `fixed`, and the current-side
  // result is present (either unchanged or updated, never new).
  const baseline = makeLog([
    { ruleId: "r.xss", uri: "src/old.ts", startLine: 10, fingerprint: "a".repeat(32) },
  ]);
  const current = makeLog([
    { ruleId: "r.xss", uri: "src/old.ts", startLine: 10, fingerprint: "a".repeat(32) },
  ]);
  // Mutate the current log's uri in-place to simulate `git mv` — same
  // fingerprint, different path. Without rename-chain hints the finding
  // serialization differs on the URI, so we expect it in `updated`, NOT
  // `new` and NOT `fixed`.
  const run = current.runs[0];
  assert.ok(run);
  const r = run.results?.[0] as Record<string, unknown> | undefined;
  assert.ok(r);
  const loc = (r["locations"] as Array<Record<string, unknown>>)[0];
  assert.ok(loc);
  const physical = loc["physicalLocation"] as Record<string, unknown>;
  (physical["artifactLocation"] as { uri: string }).uri = "src/new.ts";

  await withHarness({ scan: current, baseline }, async (ctx, server, repoName) => {
    registerListFindingsDeltaTool(server, ctx);
    const handler = getHandler(server, "list_findings_delta");
    const result = await handler({ repo: repoName }, {});
    const sc = result.structuredContent as unknown as DeltaStructured;
    assert.equal(sc.summary.new, 0, "same fingerprint → not new");
    assert.equal(sc.summary.fixed, 0, "same fingerprint → baseline not fixed");
    assert.equal(
      sc.summary.updated + sc.summary.unchanged,
      1,
      "current result is bucketed as updated (or unchanged if rename-chain hints present)",
    );
  });
});

test("list_findings_delta: missing baseline → every finding becomes new + warning surfaced", async () => {
  const current = makeLog([
    { ruleId: "r.xss", uri: "web/a.ts", startLine: 10, fingerprint: "a".repeat(32) },
  ]);
  await withHarness({ scan: current }, async (ctx, server, repoName) => {
    registerListFindingsDeltaTool(server, ctx);
    const handler = getHandler(server, "list_findings_delta");
    const result = await handler({ repo: repoName }, {});
    const sc = result.structuredContent as unknown as DeltaStructured;
    assert.equal(sc.summary.new, 1);
    assert.equal(sc.summary.unchanged, 0);
    assert.ok(
      sc.warnings.some((w) => w.includes("No baseline")),
      "warning should surface the missing baseline",
    );
  });
});

test("list_findings_delta: missing scan.sarif → NOT_FOUND error with remediation hint", async () => {
  await withHarness({}, async (ctx, server, repoName) => {
    registerListFindingsDeltaTool(server, ctx);
    const handler = getHandler(server, "list_findings_delta");
    const result = await handler({ repo: repoName }, {});
    assert.equal(result.isError, true);
    const sc = result.structuredContent as unknown as { error: { code: string; hint?: string } };
    assert.equal(sc.error.code, "NOT_FOUND");
    assert.ok(sc.error.hint?.includes("codehub scan"));
  });
});
