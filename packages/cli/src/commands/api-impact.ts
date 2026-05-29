/**
 * `codehub api-impact` — score the blast radius of changing a Route's
 * contract.
 *
 * CLI sibling of the MCP `api_impact` tool. Both surfaces call the shared
 * `listApiImpact` fn from `@opencodehub/analysis`, which scores each matching
 * Route (LOW / MEDIUM / HIGH / CRITICAL) by consumer count + shape
 * mismatches and surfaces the affected Process flows.
 *
 * Mirrors `packages/mcp/src/tools/api-impact.ts`. Does NOT emit the MCP
 * next_steps / staleness envelope.
 */

import { listApiImpact, type RiskLevel, worseRisk } from "@opencodehub/analysis";
import type { Store } from "@opencodehub/storage";
import { openStoreForCommand } from "./open-store.js";

export interface ApiImpactOptions {
  readonly repo?: string;
  readonly home?: string;
  readonly json?: boolean;
  readonly route?: string;
  readonly file?: string;
  /** Test seam — inject a fake store. Production leaves this unset. */
  readonly storeFactory?: () => Promise<{ store: Store; repoPath: string }>;
}

export async function runApiImpact(opts: ApiImpactOptions = {}): Promise<void> {
  const factory = opts.storeFactory ?? (() => openStoreForCommand({ ...opts, readOnly: true }));
  const { store } = await factory();
  try {
    const rows = await listApiImpact(store.graph, {
      ...(opts.route !== undefined ? { route: opts.route } : {}),
      ...(opts.file !== undefined ? { file: opts.file } : {}),
    });

    const highest = rows.reduce<RiskLevel>((acc, r) => worseRisk(acc, r.risk), "LOW");

    if (opts.json) {
      console.log(JSON.stringify({ routes: rows, highestRisk: highest }, null, 2));
      return;
    }

    console.warn(
      `api-impact: ${rows.length} route(s)${opts.route ? ` · url~${opts.route}` : ""}${
        opts.file ? ` · filePath~${opts.file}` : ""
      } · highest=${highest}:`,
    );
    if (rows.length === 0) {
      console.log("(no routes matched — check the filter or re-index with `codehub analyze`)");
      return;
    }
    for (const r of rows) {
      console.log(
        `[${r.risk}] ${r.route.method} ${r.route.url} consumers=${r.consumers.length} mismatches=${r.mismatches.length} processes=${r.affectedProcesses.length}`,
      );
    }
  } finally {
    await store.close();
  }
}
