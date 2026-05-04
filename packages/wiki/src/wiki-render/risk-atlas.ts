/**
 * Risk-atlas renderer — dead code + orphan files + risk-trends summary.
 *
 * Dead-code rows come from the `deadness` column. Orphan files come
 * from the File `orphan_grade` column. The risk-trends summary is
 * supplied by the caller via `options.loadTrends` — a callback that receives
 * the repo path and returns a `RiskTrendsResult`-shaped object (typed
 * structurally so this module can live in `@opencodehub/wiki` without a
 * direct dependency on `@opencodehub/analysis`).
 */

import type { IGraphStore } from "@opencodehub/storage";
import type { RenderedWikiPage } from "./architecture.js";
import {
  type DeadFunctionRow,
  escapePipe,
  loadDeadFunctions,
  loadOrphanFiles,
  type OrphanFileRow,
} from "./shared.js";

/**
 * Structural shape of the trends payload. Mirrors
 * `@opencodehub/analysis`'s `RiskTrendsResult` so callers can pass either
 * the analysis type directly or any compatible structure.
 */
export interface RiskTrendsLike {
  readonly communities: Readonly<
    Record<
      string,
      { readonly trend: string; readonly currentRisk: number; readonly projectedRisk30d: number }
    >
  >;
  readonly overallTrend: string;
  readonly snapshotCount: number;
}

export interface RiskAtlasOptions {
  /**
   * Repo root used to locate `.codehub/history/`. If absent the trends section
   * is rendered with an empty-history notice instead of failing.
   */
  readonly repoPath?: string;
  /**
   * Callback injected by the caller (typically `generateWiki`) that loads
   * the trends payload for `repoPath`. When omitted or when `repoPath` is
   * absent, the trends section is rendered with a zero-snapshot notice.
   */
  readonly loadTrends?: (repoPath: string) => Promise<RiskTrendsLike>;
}

export async function renderRiskAtlasPages(
  store: IGraphStore,
  options: RiskAtlasOptions = {},
): Promise<readonly RenderedWikiPage[]> {
  const [dead, orphans] = await Promise.all([loadDeadFunctions(store), loadOrphanFiles(store)]);
  const trends: RiskTrendsLike =
    options.repoPath !== undefined && options.loadTrends !== undefined
      ? await safeLoadTrends(options.loadTrends, options.repoPath)
      : { communities: {}, overallTrend: "stable", snapshotCount: 0 };

  return [
    {
      filename: "risk-atlas/index.md",
      content: renderPage({ dead, orphans, trends }),
    },
  ];
}

async function safeLoadTrends(
  load: (repoPath: string) => Promise<RiskTrendsLike>,
  repoPath: string,
): Promise<RiskTrendsLike> {
  try {
    return await load(repoPath);
  } catch {
    return { communities: {}, overallTrend: "stable", snapshotCount: 0 };
  }
}

function renderPage(args: {
  readonly dead: readonly DeadFunctionRow[];
  readonly orphans: readonly OrphanFileRow[];
  readonly trends: RiskTrendsLike;
}): string {
  const lines: string[] = [];
  lines.push("# Risk atlas");
  lines.push("");
  lines.push(`- **Dead or unreachable symbols:** ${args.dead.length}`);
  lines.push(`- **Orphan files:** ${args.orphans.length}`);
  lines.push(
    `- **Risk trend snapshots:** ${args.trends.snapshotCount} (overall ${args.trends.overallTrend})`,
  );
  lines.push("");

  lines.push("## Dead code");
  lines.push("");
  if (args.dead.length === 0) {
    lines.push("(no dead or unreachable-export symbols — the dead-code phase found nothing)");
  } else {
    lines.push("| Symbol | File | Lines | Deadness |");
    lines.push("| --- | --- | --- | --- |");
    for (const d of args.dead) {
      const name = d.name.length > 0 ? d.name : d.id;
      const file = d.filePath.length > 0 ? `\`${escapePipe(d.filePath)}\`` : "-";
      const linesRange =
        d.startLine !== undefined && d.endLine !== undefined ? `${d.startLine}-${d.endLine}` : "-";
      lines.push(`| ${escapePipe(name)} | ${file} | ${linesRange} | ${escapePipe(d.deadness)} |`);
    }
  }
  lines.push("");

  lines.push("## Orphan files");
  lines.push("");
  if (args.orphans.length === 0) {
    lines.push("(no orphan files — every indexed file has recent top-contributor activity)");
  } else {
    lines.push("| File | Grade |");
    lines.push("| --- | --- |");
    for (const o of args.orphans) {
      lines.push(`| \`${escapePipe(o.filePath)}\` | ${escapePipe(o.orphanGrade)} |`);
    }
  }
  lines.push("");

  lines.push("## Risk trends");
  lines.push("");
  if (args.trends.snapshotCount === 0) {
    lines.push(
      "(no snapshots yet — run `codehub analyze` a few times to populate `.codehub/history/`)",
    );
    lines.push("");
    return lines.join("\n");
  }

  lines.push(
    `Overall trend: **${args.trends.overallTrend}** across ${args.trends.snapshotCount} snapshots.`,
  );
  lines.push("");
  const communityIds = Object.keys(args.trends.communities).sort();
  if (communityIds.length === 0) {
    lines.push("(no per-community trends)");
  } else {
    lines.push("| Community | Trend | Current risk | 30d projection |");
    lines.push("| --- | --- | ---: | ---: |");
    for (const id of communityIds) {
      const entry = args.trends.communities[id];
      if (entry === undefined) continue;
      lines.push(
        `| \`${escapePipe(id)}\` | ${entry.trend} | ${entry.currentRisk.toFixed(3)} | ${entry.projectedRisk30d.toFixed(3)} |`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}
