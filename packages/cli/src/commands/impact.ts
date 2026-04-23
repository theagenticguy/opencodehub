/**
 * `codehub impact <symbol>` — dependent graph traversal for blast-radius.
 *
 * Delegates to `@opencodehub/analysis`'s `runImpact()` which owns the
 * risk-tier scoring and PROCESS_STEP fan-out logic. The CLI layer only
 * maps the user-facing `--direction` flag into the analysis query shape
 * and formats the result.
 */

import { runImpact as runImpactAnalysis } from "@opencodehub/analysis";
import { openStoreForCommand } from "./open-store.js";

export interface ImpactOptions {
  readonly depth?: number;
  readonly direction?: "up" | "down" | "both";
  readonly repo?: string;
  readonly home?: string;
  readonly json?: boolean;
}

function mapDirection(dir: "up" | "down" | "both"): "upstream" | "downstream" | "both" {
  if (dir === "up") return "upstream";
  if (dir === "down") return "downstream";
  return "both";
}

export async function runImpact(symbol: string, opts: ImpactOptions = {}): Promise<void> {
  const depth = opts.depth ?? 3;
  const direction = opts.direction ?? "both";
  const { store, repoPath } = await openStoreForCommand(opts);
  try {
    const result = await runImpactAnalysis(store, {
      target: symbol,
      direction: mapDirection(direction),
      maxDepth: depth,
    });

    if (result.ambiguous) {
      console.warn(
        `impact: "${symbol}" matched ${result.targetCandidates.length} symbols in ${repoPath} — narrow the query with a node id or --repo.`,
      );
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      }
      return;
    }

    if (!result.chosenTarget) {
      console.warn(`impact: no symbol matching "${symbol}" in ${repoPath}`);
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      }
      return;
    }

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.warn(
      `impact: ${result.chosenTarget.name} — risk=${result.risk}, ${result.totalAffected} reachable nodes at depth ≤ ${depth} (${direction}), ${result.affectedProcesses.length} affected process(es)`,
    );
    const header = ["DEPTH", "NODE", "VIA"];
    const widths = header.map((h) => h.length);
    const rows: string[][] = [];
    for (const bucket of result.byDepth) {
      for (const node of bucket.nodes) {
        rows.push([String(bucket.depth), node.id, node.viaRelation]);
      }
    }
    for (const row of rows) {
      widths[0] = Math.max(widths[0] ?? 0, (row[0] ?? "").length);
      widths[1] = Math.max(widths[1] ?? 0, (row[1] ?? "").length);
      widths[2] = Math.max(widths[2] ?? 0, (row[2] ?? "").length);
    }
    const line = (cols: readonly string[]): string =>
      cols.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
    console.log(line(header));
    for (const row of rows) console.log(line(row));
  } finally {
    await store.close();
  }
}
