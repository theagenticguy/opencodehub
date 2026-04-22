/**
 * `codehub list` — print one row per registered repo.
 *
 * Output is a plain-text table on stdout so users can pipe it through `awk`
 * or similar. No JSON mode in MVP.
 */

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

function printTable(entries: readonly RepoEntry[]): void {
  const rows = entries.map((e) => ({
    name: e.name,
    path: e.path,
    lastCommit: e.lastCommit ? e.lastCommit.slice(0, 8) : "-",
    indexedAt: e.indexedAt.slice(0, 19),
    nodes: String(e.nodeCount),
  }));
  const headers = ["NAME", "PATH", "COMMIT", "INDEXED_AT", "NODES"];
  const widths = headers.map((h) => h.length);
  for (const r of rows) {
    widths[0] = Math.max(widths[0] ?? 0, r.name.length);
    widths[1] = Math.max(widths[1] ?? 0, r.path.length);
    widths[2] = Math.max(widths[2] ?? 0, r.lastCommit.length);
    widths[3] = Math.max(widths[3] ?? 0, r.indexedAt.length);
    widths[4] = Math.max(widths[4] ?? 0, r.nodes.length);
  }
  const line = (cols: readonly string[]): string =>
    cols.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
  console.log(line(headers));
  for (const r of rows) {
    console.log(line([r.name, r.path, r.lastCommit, r.indexedAt, r.nodes]));
  }
}
