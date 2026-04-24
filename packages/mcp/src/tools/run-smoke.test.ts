// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures
/**
 * Smoke tests for the pure `run<Tool>` functions extracted from the MCP
 * registrations. Every tool that now exports `run<Tool>` gets one call
 * directly (bypassing the MCP SDK handler adapter) and we assert the
 * returned `ToolResult` shape: `structuredContent` is set, `text` is a
 * non-empty string, `isError` is a boolean when present.
 *
 * The goal is not behaviour parity — the existing `tool-handlers.test.ts`
 * already covers that via the registered MCP handlers. This file simply
 * proves the extraction didn't break the pure-function contract so the
 * upcoming eval-server HTTP adapter can rely on it.
 */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
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
import { assertReadOnlySql } from "@opencodehub/storage";
import { ConnectionPool } from "../connection-pool.js";
import { runApiImpact } from "./api-impact.js";
import { runContext } from "./context.js";
import { runDependencies } from "./dependencies.js";
import { runDetectChanges } from "./detect-changes.js";
import { runGroupContracts } from "./group-contracts.js";
import { runGroupList } from "./group-list.js";
import { runGroupQuery } from "./group-query.js";
import { runGroupStatus } from "./group-status.js";
import { runImpact } from "./impact.js";
import { runLicenseAudit } from "./license-audit.js";
import { runListDeadCode } from "./list-dead-code.js";
import { runListFindings } from "./list-findings.js";
import { runListFindingsDelta } from "./list-findings-delta.js";
import { runListRepos } from "./list-repos.js";
import { runOwners } from "./owners.js";
import { runProjectProfile } from "./project-profile.js";
import { runQuery } from "./query.js";
import { runRemoveDeadCode } from "./remove-dead-code.js";
import { runRename } from "./rename.js";
import { runRiskTrends } from "./risk-trends.js";
import { runRouteMap } from "./route-map.js";
import { runScan } from "./scan.js";
import { runShapeCheck } from "./shape-check.js";
import type { ToolContext, ToolResult } from "./shared.js";
import { runSignature } from "./signature.js";
import { runSql } from "./sql.js";
import { runToolMap } from "./tool-map.js";
import { runVerdict } from "./verdict.js";

/**
 * Minimal DuckDB-compatible fake — every `store.query` that a tool runs
 * against it returns an empty row set. That is enough to exercise the
 * `run<Tool>` call path through `withStore` without a real index. Tools
 * handle empty results gracefully and return a "nothing matched" message
 * with the expected structured-content fields, so the smoke tests only
 * assert the `ToolResult` shape.
 */
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
      sql: string,
      _params: readonly SqlParam[] = [],
    ): Promise<readonly Record<string, unknown>[]> => {
      assertReadOnlySql(sql);
      return [];
    },
    search: async (_q: SearchQuery): Promise<readonly SearchResult[]> => [],
    vectorSearch: async (_q: VectorQuery): Promise<readonly VectorResult[]> => [],
    traverse: async (_q: TraverseQuery): Promise<readonly TraverseResult[]> => [],
    getMeta: async (): Promise<StoreMeta | undefined> => undefined,
    setMeta: async (_m: StoreMeta): Promise<void> => {},
    healthCheck: async () => ({ ok: true }),
    bulkLoadCochanges: async (_rows: readonly unknown[]): Promise<void> => {},
    lookupCochangesForFile: async () => [],
    lookupCochangesBetween: async () => undefined,
  } as unknown as DuckDbStore;
  return api;
}

/**
 * Spin up a fake `~/.codehub` with one registered repo so `withStore` can
 * resolve it. The connection pool is wired to return our fake DuckDB.
 */
async function withHarness(fn: (ctx: ToolContext) => Promise<void>): Promise<void> {
  const home = await mkdtemp(resolve(tmpdir(), "codehub-runsmoke-"));
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
          nodeCount: 0,
          edgeCount: 0,
          lastCommit: "abc123",
        },
      }),
    );
    const pool = new ConnectionPool({ max: 2, ttlMs: 60_000 }, async () => makeFakeStore());
    const ctx: ToolContext = { pool, home };
    try {
      await fn(ctx);
    } finally {
      await pool.shutdown();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** Assert the `ToolResult` shape: required fields present and well-typed. */
function assertToolResultShape(result: ToolResult): void {
  assert.equal(typeof result.text, "string", "text must be a string");
  assert.ok(result.text.length > 0, "text must be non-empty");
  assert.notEqual(result.structuredContent, undefined, "structuredContent must be set");
  if (result.isError !== undefined) {
    assert.equal(typeof result.isError, "boolean", "isError must be a boolean when present");
  }
}

test("runListRepos returns a ToolResult shape", async () => {
  await withHarness(async (ctx) => {
    const result = await runListRepos(ctx);
    assertToolResultShape(result);
  });
});

test("runQuery returns a ToolResult shape", async () => {
  await withHarness(async (ctx) => {
    const result = await runQuery(ctx, { query: "foo", repo: "fakerepo" });
    assertToolResultShape(result);
  });
});

test("runContext returns a ToolResult shape", async () => {
  await withHarness(async (ctx) => {
    const result = await runContext(ctx, { symbol: "foo", repo: "fakerepo" });
    assertToolResultShape(result);
  });
});

test("runImpact returns a ToolResult shape", async () => {
  await withHarness(async (ctx) => {
    const result = await runImpact(ctx, { target: "foo", repo: "fakerepo" });
    assertToolResultShape(result);
  });
});

test("runDetectChanges returns a ToolResult shape", async () => {
  await withHarness(async (ctx) => {
    // `detect_changes` shells out to git; we only assert the ToolResult shape.
    const result = await runDetectChanges(ctx, { scope: "unstaged", repo: "fakerepo" });
    assertToolResultShape(result);
  });
});

test("runSql returns a ToolResult shape", async () => {
  await withHarness(async (ctx) => {
    const result = await runSql(ctx, { sql: "SELECT 1", repo: "fakerepo" });
    assertToolResultShape(result);
  });
});

test("runVerdict returns a ToolResult shape", async () => {
  await withHarness(async (ctx) => {
    const result = await runVerdict(ctx, { repo: "fakerepo" });
    assertToolResultShape(result);
  });
});

test("runListFindings returns a ToolResult shape", async () => {
  await withHarness(async (ctx) => {
    const result = await runListFindings(ctx, { repo: "fakerepo" });
    assertToolResultShape(result);
  });
});

test("runListFindingsDelta returns a ToolResult shape", async () => {
  await withHarness(async (ctx) => {
    const result = await runListFindingsDelta(ctx, { repo: "fakerepo" });
    assertToolResultShape(result);
  });
});

test("runScan returns a ToolResult shape", async () => {
  await withHarness(async (ctx) => {
    const result = await runScan(ctx, { repo: "fakerepo", scanners: [] });
    assertToolResultShape(result);
  });
});

test("runRename returns a ToolResult shape", async () => {
  await withHarness(async (ctx) => {
    const result = await runRename(ctx, {
      symbol_name: "foo",
      new_name: "bar",
      repo: "fakerepo",
    });
    assertToolResultShape(result);
  });
});

test("runApiImpact returns a ToolResult shape", async () => {
  await withHarness(async (ctx) => {
    const result = await runApiImpact(ctx, { repo: "fakerepo" });
    assertToolResultShape(result);
  });
});

test("runShapeCheck returns a ToolResult shape", async () => {
  await withHarness(async (ctx) => {
    const result = await runShapeCheck(ctx, { repo: "fakerepo" });
    assertToolResultShape(result);
  });
});

test("runRouteMap returns a ToolResult shape", async () => {
  await withHarness(async (ctx) => {
    const result = await runRouteMap(ctx, { repo: "fakerepo" });
    assertToolResultShape(result);
  });
});

test("runToolMap returns a ToolResult shape", async () => {
  await withHarness(async (ctx) => {
    const result = await runToolMap(ctx, { repo: "fakerepo" });
    assertToolResultShape(result);
  });
});

test("runGroupList returns a ToolResult shape", async () => {
  await withHarness(async (ctx) => {
    const result = await runGroupList(ctx);
    assertToolResultShape(result);
  });
});

test("runGroupQuery returns a ToolResult shape", async () => {
  await withHarness(async (ctx) => {
    const result = await runGroupQuery(ctx, { groupName: "none", query: "foo" });
    assertToolResultShape(result);
  });
});

test("runGroupStatus returns a ToolResult shape", async () => {
  await withHarness(async (ctx) => {
    const result = await runGroupStatus(ctx, { groupName: "none" });
    assertToolResultShape(result);
  });
});

test("runGroupContracts returns a ToolResult shape", async () => {
  await withHarness(async (ctx) => {
    const result = await runGroupContracts(ctx, { groupName: "none" });
    assertToolResultShape(result);
  });
});

test("runDependencies returns a ToolResult shape", async () => {
  await withHarness(async (ctx) => {
    const result = await runDependencies(ctx, { repo: "fakerepo" });
    assertToolResultShape(result);
  });
});

test("runLicenseAudit returns a ToolResult shape", async () => {
  await withHarness(async (ctx) => {
    const result = await runLicenseAudit(ctx, { repo: "fakerepo" });
    assertToolResultShape(result);
  });
});

test("runOwners returns a ToolResult shape", async () => {
  await withHarness(async (ctx) => {
    const result = await runOwners(ctx, { target: "F:foo", repo: "fakerepo" });
    assertToolResultShape(result);
  });
});

test("runProjectProfile returns a ToolResult shape", async () => {
  await withHarness(async (ctx) => {
    const result = await runProjectProfile(ctx, { repo: "fakerepo" });
    assertToolResultShape(result);
  });
});

test("runRiskTrends returns a ToolResult shape", async () => {
  await withHarness(async (ctx) => {
    const result = await runRiskTrends(ctx, { repo: "fakerepo" });
    assertToolResultShape(result);
  });
});

test("runSignature returns a ToolResult shape", async () => {
  await withHarness(async (ctx) => {
    const result = await runSignature(ctx, { name: "foo", repo: "fakerepo" });
    assertToolResultShape(result);
  });
});

test("runListDeadCode returns a ToolResult shape", async () => {
  await withHarness(async (ctx) => {
    const result = await runListDeadCode(ctx, { repo: "fakerepo" });
    assertToolResultShape(result);
  });
});

test("runRemoveDeadCode returns a ToolResult shape", async () => {
  await withHarness(async (ctx) => {
    const result = await runRemoveDeadCode(ctx, { repo: "fakerepo" });
    assertToolResultShape(result);
  });
});
