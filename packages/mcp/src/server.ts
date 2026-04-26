/**
 * stdio MCP server for OpenCodeHub.
 *
 * Wires together the tool and resource registrations against a single
 * shared `ConnectionPool`. The stdio transport reads JSON-RPC from stdin
 * and writes responses to stdout; anything else the process emits (the
 * connection pool, tool handlers) should go to stderr so it does not
 * corrupt the transport.
 *
 * The `instructions` field is prose the model sees at session start. We
 * use it to nudge agents toward `list_repos` first, and we advertise the
 * staleness envelope so clients are primed to surface it.
 */

import { access } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getDefaultModelRoot, modelFileName, resolveModelDir } from "@opencodehub/embedder";
import { ConnectionPool } from "./connection-pool.js";
import { registerAuditDependenciesPrompt } from "./prompts/audit-dependencies.js";
import { registerDetectImpactPrompt } from "./prompts/detect-impact.js";
import { registerExploreAreaPrompt } from "./prompts/explore-area.js";
import { registerGenerateMapPrompt } from "./prompts/generate-map.js";
import { registerReviewPrPrompt } from "./prompts/review-pr.js";
import { registerRepoClusterResource } from "./resources/repo-cluster.js";
import { registerRepoClustersResource } from "./resources/repo-clusters.js";
import { registerRepoContextResource } from "./resources/repo-context.js";
import { registerRepoProcessResource } from "./resources/repo-process.js";
import { registerRepoProcessesResource } from "./resources/repo-processes.js";
import { registerRepoSchemaResource } from "./resources/repo-schema.js";
import { registerReposResource } from "./resources/repos.js";
import { registerApiImpactTool } from "./tools/api-impact.js";
import { registerContextTool } from "./tools/context.js";
import { registerDependenciesTool } from "./tools/dependencies.js";
import { registerDetectChangesTool } from "./tools/detect-changes.js";
import { registerGroupContractsTool } from "./tools/group-contracts.js";
import { registerGroupListTool } from "./tools/group-list.js";
import { registerGroupQueryTool } from "./tools/group-query.js";
import { registerGroupStatusTool } from "./tools/group-status.js";
import { registerGroupSyncTool } from "./tools/group-sync.js";
import { registerImpactTool } from "./tools/impact.js";
import { registerLicenseAuditTool } from "./tools/license-audit.js";
import { registerListDeadCodeTool } from "./tools/list-dead-code.js";
import { registerListFindingsTool } from "./tools/list-findings.js";
import { registerListFindingsDeltaTool } from "./tools/list-findings-delta.js";
import { registerListReposTool } from "./tools/list-repos.js";
import { registerOwnersTool } from "./tools/owners.js";
import { registerProjectProfileTool } from "./tools/project-profile.js";
import { registerQueryTool } from "./tools/query.js";
import { registerRemoveDeadCodeTool } from "./tools/remove-dead-code.js";
import { registerRenameTool } from "./tools/rename.js";
import { registerRiskTrendsTool } from "./tools/risk-trends.js";
import { registerRouteMapTool } from "./tools/route-map.js";
import { registerScanTool } from "./tools/scan.js";
import { registerShapeCheckTool } from "./tools/shape-check.js";
import type { ToolContext } from "./tools/shared.js";
import { registerSqlTool } from "./tools/sql.js";
import { registerToolMapTool } from "./tools/tool-map.js";
import { registerVerdictTool } from "./tools/verdict.js";

const SERVER_NAME = "opencodehub";
const SERVER_VERSION = "0.0.0";

const INSTRUCTIONS = [
  "OpenCodeHub exposes indexed code graphs for MCP agents.",
  "Typical flow: call `list_repos` first to discover indexed repos, then route subsequent calls through one of those repo names.",
  "Every per-repo tool (`query`, `context`, `impact`, `detect_changes`, `rename`, `sql`, `scan`, `list_findings`, `list_findings_delta`, `list_dead_code`, `remove_dead_code`, `license_audit`, `project_profile`, `dependencies`, `owners`, `risk_trends`, `verdict`) accepts an optional `repo` argument (registry name). When exactly one repo is registered, `repo` is optional and defaults to that repo. When ≥ 2 repos are registered and `repo` is omitted, the tool returns `AMBIGUOUS_REPO` — pass `repo` explicitly to disambiguate.",
  "Every tool response includes a `next_steps` array under structuredContent and a `_meta.codehub/staleness` entry when the index may be behind HEAD.",
  "Use `query` to locate symbols, `context` for a 360-degree view, `impact` for blast radius, `detect_changes` to map a diff to flows, `rename` for coordinated renames (dry-run by default), `dependencies` for the external package list, `license_audit` for a copyleft/unknown/proprietary tier check of dependencies, `list_findings` to browse SARIF findings, `list_findings_delta` to diff the latest scan against a frozen baseline (new/fixed/unchanged/updated buckets), `scan` to run Priority-1 scanners (openWorld — spawns processes), `verdict` for a 5-tier PR decision (exit codes 0/1/2), `risk_trends` for per-community trend lines and 30-day projections, and `sql` for bespoke queries.",
  "For cross-repo work, call `group_list` to discover named repo groups, then `group_query`/`group_status` to fan out BM25 search and staleness across the group. `group_query` returns `{ group, query, results: [{ _repo, _rrf_score, ... }], per_repo, warnings }`; results are tagged with the source repo and per-repo errors surface in `per_repo[].error` + `warnings[]` (the fan-out never aborts on a single-repo failure). Use `group_sync` to materialize a cross-repo contract registry (HTTP / gRPC / topic) under `~/.codehub/groups/<name>/contracts.json`, then `group_contracts` to list the DuckDB-backed FETCHES↔Route edges together with the registry's signature-matched cross-links.",
].join(" ");

export interface StartServerOptions {
  /** Override the home directory used to locate ~/.codehub/registry.json. */
  readonly home?: string;
  /** Override the connection-pool cap (default 8). */
  readonly poolMax?: number;
  /** Override the connection-pool idle TTL (default 15 minutes). */
  readonly poolTtlMs?: number;
  /**
   * Suppress the one-time "embeddings weights not found" startup warning.
   * Tests set this so stderr stays quiet; production callers should leave
   * it unset.
   */
  readonly silentEmbedderProbe?: boolean;
}

/**
 * Probe for gte-modernbert-base weights on disk. Runs once at server startup
 * and logs a single structured warning when the weights are absent so
 * agents see the BM25-only fallback reason. Never throws: a missing or
 * unreadable model directory is a supported deployment mode.
 */
async function probeEmbedderWeights(silent: boolean): Promise<void> {
  if (silent) return;
  try {
    for (const variant of ["fp32", "int8"] as const) {
      const modelDir = resolveModelDir(undefined, variant);
      const modelPath = join(modelDir, modelFileName(variant));
      try {
        await access(modelPath);
        // At least one variant is installed — stay silent.
        return;
      } catch {
        // try the next variant
      }
    }
    const root = getDefaultModelRoot();
    console.warn(
      `[mcp] hybrid: embeddings weights not found at ${root}/models/gte-modernbert-base/; run \`codehub setup --embeddings\`. Falling back to BM25-only.`,
    );
  } catch (err) {
    // Probe failure is non-fatal; surface the reason but keep going.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[mcp] hybrid: embedder probe failed: ${message}. Falling back to BM25-only.`);
  }
}

export interface RunningServer {
  readonly server: McpServer;
  readonly pool: ConnectionPool;
  shutdown(): Promise<void>;
}

/**
 * Build a fully-wired `McpServer` (without connecting a transport). The
 * CLI wrapper uses this to embed the server in-process; the stdio entry
 * point in `index.ts` connects a stdio transport on top.
 */
export function buildServer(opts: StartServerOptions = {}): RunningServer {
  const poolOpts: { max?: number; ttlMs?: number } = {};
  if (opts.poolMax !== undefined) poolOpts.max = opts.poolMax;
  if (opts.poolTtlMs !== undefined) poolOpts.ttlMs = opts.poolTtlMs;
  const pool = new ConnectionPool(poolOpts);
  const ctx: ToolContext = opts.home !== undefined ? { pool, home: opts.home } : { pool };

  // Fire-and-forget embedder availability probe so the one-time warning is
  // emitted before the first `query` call. Never blocks startup; never
  // affects tool registration.
  void probeEmbedderWeights(opts.silentEmbedderProbe === true);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false },
        prompts: { listChanged: false },
      },
      instructions: INSTRUCTIONS,
    },
  );

  registerListReposTool(server, ctx);
  registerQueryTool(server, ctx);
  registerContextTool(server, ctx);
  registerImpactTool(server, ctx);
  registerDetectChangesTool(server, ctx);
  registerRenameTool(server, ctx);
  registerSqlTool(server, ctx);
  registerGroupListTool(server, ctx);
  registerGroupQueryTool(server, ctx);
  registerGroupStatusTool(server, ctx);
  registerGroupContractsTool(server, ctx);
  registerGroupSyncTool(server, ctx);
  registerProjectProfileTool(server, ctx);
  registerDependenciesTool(server, ctx);
  registerLicenseAuditTool(server, ctx);
  registerOwnersTool(server, ctx);
  registerListFindingsTool(server, ctx);
  registerListFindingsDeltaTool(server, ctx);
  registerListDeadCodeTool(server, ctx);
  registerRemoveDeadCodeTool(server, ctx);
  registerScanTool(server, ctx);
  registerVerdictTool(server, ctx);
  registerRiskTrendsTool(server, ctx);
  registerRouteMapTool(server, ctx);
  registerApiImpactTool(server, ctx);
  registerShapeCheckTool(server, ctx);
  registerToolMapTool(server, ctx);

  const resCtx: { home?: string; pool: ConnectionPool } =
    opts.home !== undefined ? { home: opts.home, pool } : { pool };
  registerReposResource(server, resCtx);
  registerRepoContextResource(server, resCtx);
  registerRepoSchemaResource(server, resCtx);
  registerRepoClustersResource(server, resCtx);
  registerRepoClusterResource(server, resCtx);
  registerRepoProcessesResource(server, resCtx);
  registerRepoProcessResource(server, resCtx);

  // Prompts — static templates that chain the tools above. They take no
  // ToolContext because they do not invoke tools themselves; the agent is
  // responsible for carrying out the steps described in each template.
  registerDetectImpactPrompt(server);
  registerReviewPrPrompt(server);
  registerExploreAreaPrompt(server);
  registerAuditDependenciesPrompt(server);
  registerGenerateMapPrompt(server);

  return {
    server,
    pool,
    shutdown: async () => {
      await server.close();
      await pool.shutdown();
    },
  };
}

/**
 * Entry point: build the server, connect stdio, and install a SIGINT /
 * SIGTERM / stdin-close handler that drains the pool before exiting.
 */
export async function startStdioServer(opts: StartServerOptions = {}): Promise<void> {
  const running = buildServer(opts);
  const transport = new StdioServerTransport();
  await running.server.connect(transport);

  const bail = async (code: number) => {
    try {
      await running.shutdown();
    } finally {
      process.exit(code);
    }
  };
  process.on("SIGINT", () => {
    void bail(130);
  });
  process.on("SIGTERM", () => {
    void bail(143);
  });
  // Some clients signal disconnect via stdin close rather than a signal.
  process.stdin.on("close", () => {
    void bail(0);
  });
}
