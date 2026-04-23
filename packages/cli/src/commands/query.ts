/**
 * `codehub query <text>` — direct-call hybrid search.
 *
 * Tries to use `@opencodehub/search`'s BM25-backed helper; falls back to the
 * store's own `search()` method if the search package isn't built yet. This
 * keeps the CLI usable during cross-wave development.
 */

import type { SearchResult } from "@opencodehub/storage";
import { openStoreForCommand } from "./open-store.js";

export interface QueryOptions {
  readonly limit?: number;
  readonly repo?: string;
  readonly home?: string;
  readonly json?: boolean;
}

export async function runQuery(text: string, opts: QueryOptions = {}): Promise<void> {
  const limit = opts.limit ?? 10;
  const { store, repoPath } = await openStoreForCommand(opts);
  try {
    const results = await store.search({ text, limit });
    if (opts.json) {
      console.log(JSON.stringify({ repoPath, results }, null, 2));
      return;
    }
    printResults(results, text, repoPath);
  } finally {
    await store.close();
  }
}

function printResults(results: readonly SearchResult[], text: string, repoPath: string): void {
  console.warn(`query: "${text}" in ${repoPath} (${results.length} results)`);
  if (results.length === 0) return;
  const header = ["SCORE", "KIND", "NAME", "FILE"];
  const rows = results.map((r) => [r.score.toFixed(3), r.kind, r.name, r.filePath]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => (row[i] ?? "").length)),
  );
  const line = (cols: readonly string[]): string =>
    cols.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
  console.log(line(header));
  for (const row of rows) console.log(line(row));
}
