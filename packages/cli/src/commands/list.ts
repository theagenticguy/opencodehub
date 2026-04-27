/**
 * `codehub list` — print one row per registered repo.
 *
 * Output is a plain-text table on stdout so users can pipe it through `awk`
 * or similar. No JSON mode in MVP.
 *
 * Health check: each row gets an annotation column that flags dangling
 * registry entries (path missing on disk) and missing graph DBs. A dangling
 * entry happens when a repo is moved/deleted without running `codehub clean`
 * — the registry keeps the stale pointer and every subsequent group / MCP
 * lookup silently half-works. Surface it.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { type RepoEntry, readRegistry } from "../registry.js";

export interface ListOptions {
  readonly home?: string;
}

export async function runList(opts: ListOptions = {}): Promise<void> {
  const registryOpts = opts.home !== undefined ? { home: opts.home } : {};
  const registry = await readRegistry(registryOpts);
  const entries = Object.values(registry);
  if (entries.length === 0) {
    console.warn("No repos indexed yet. Run `codehub analyze` in a git repo.");
    return;
  }
  printTable(entries);
}

type Health = "ok" | "path-missing" | "graph-missing";

function classifyHealth(entry: RepoEntry): Health {
  if (!existsSync(entry.path)) return "path-missing";
  if (!existsSync(join(entry.path, ".codehub", "graph.duckdb"))) return "graph-missing";
  return "ok";
}

function healthLabel(h: Health): string {
  switch (h) {
    case "ok":
      return "ok";
    case "path-missing":
      return "⚠ missing path";
    case "graph-missing":
      return "⚠ no graph.duckdb";
  }
}

function printTable(entries: readonly RepoEntry[]): void {
  const rows = entries.map((e) => {
    const health = classifyHealth(e);
    return {
      name: e.name,
      path: e.path,
      lastCommit: e.lastCommit ? e.lastCommit.slice(0, 8) : "-",
      indexedAt: e.indexedAt.slice(0, 19),
      nodes: String(e.nodeCount),
      health: healthLabel(health),
    };
  });
  const headers = ["NAME", "PATH", "COMMIT", "INDEXED_AT", "NODES", "HEALTH"];
  const widths = headers.map((h) => h.length);
  for (const r of rows) {
    widths[0] = Math.max(widths[0] ?? 0, r.name.length);
    widths[1] = Math.max(widths[1] ?? 0, r.path.length);
    widths[2] = Math.max(widths[2] ?? 0, r.lastCommit.length);
    widths[3] = Math.max(widths[3] ?? 0, r.indexedAt.length);
    widths[4] = Math.max(widths[4] ?? 0, r.nodes.length);
    widths[5] = Math.max(widths[5] ?? 0, r.health.length);
  }
  const line = (cols: readonly string[]): string =>
    cols.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
  console.log(line(headers));
  for (const r of rows) {
    console.log(
      line([r.name, r.path, r.lastCommit, r.indexedAt, r.nodes, r.health]),
    );
  }
  const unhealthy = rows.filter((r) => r.health !== "ok");
  if (unhealthy.length > 0) {
    console.warn(
      `\n${unhealthy.length} of ${rows.length} entries need attention. Run \`codehub clean <path>\` to remove a dangling entry, or re-analyze a missing graph.`,
    );
  }
}
