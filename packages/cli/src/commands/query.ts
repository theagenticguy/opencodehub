/**
 * `codehub query <text>` — direct-call hybrid search.
 *
 * Tries to use `@opencodehub/search`'s BM25-backed helper; falls back to the
 * store's own `search()` method if the search package isn't built yet. This
 * keeps the CLI usable when the search package has not been built yet.
 *
 * Mirrors the MCP `query` tool's `task_context` / `goal` / `include_content`
 * semantics so the CLI and MCP surfaces stay at parity:
 *   - `context` + `goal` are prefixed to the text before search, separated
 *     by " — " so the ranker sees the broader intent.
 *   - `include_content: true` re-reads each hit's source between its
 *     startLine / endLine and attaches the body, capped at 2000 chars.
 *   - `maxSymbols` is forwarded for process-grouping parity (MVP stores no
 *     PROCESS_STEP edges, so the cap is a no-op today and becomes live
 *     when the process-walk lands alongside P0-4).
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { SearchResult } from "@opencodehub/storage";
import { type OpenStoreResult, openStoreForCommand } from "./open-store.js";

/** Per-symbol cap for `--content`. Matches the MCP `query` tool contract. */
const INCLUDE_CONTENT_CHAR_CAP = 2000;

/**
 * Hook for tests to inject a pre-built store without touching DuckDB. The
 * default implementation delegates to {@link openStoreForCommand}. Kept
 * separate from the public `QueryOptions` interface so end-user CLI callers
 * aren't tempted to pass an in-process store.
 */
export interface QueryRuntimeHooks {
  readonly openStore?: (opts: QueryOptions) => Promise<OpenStoreResult>;
}

export interface QueryOptions {
  readonly limit?: number;
  readonly repo?: string;
  readonly home?: string;
  readonly json?: boolean;
  /** `--content` — attach the symbol body (capped at 2000 chars) to each hit. */
  readonly content?: boolean;
  /** `--context <text>` — prefix to the search text before BM25 + embedding. */
  readonly context?: string;
  /** `--goal <text>` — additional prefix to the search text (steers ranking). */
  readonly goal?: string;
  /** `--max-symbols <n>` — cap on process-grouped symbols. MVP: no-op. */
  readonly maxSymbols?: number;
}

/**
 * A SearchResult augmented with optional source content (populated only when
 * `--content` was passed). The optional field is absent when the source file
 * is unreadable — we never emit an empty string because the agent can then
 * mistake "file gone" for "truly empty body".
 */
type HitRow = SearchResult & { readonly content?: string };

export async function runQuery(
  text: string,
  opts: QueryOptions = {},
  hooks: QueryRuntimeHooks = {},
): Promise<void> {
  const limit = opts.limit ?? 10;
  const openStore = hooks.openStore ?? openStoreForCommand;
  const { store, repoPath } = await openStore(opts);
  try {
    const searchText = buildSearchText(text, opts.context, opts.goal);
    const baseResults = await store.search({ text: searchText, limit });
    const results: readonly HitRow[] =
      opts.content === true
        ? await Promise.all(
            baseResults.map(async (r): Promise<HitRow> => {
              const content = await readSymbolContent(repoPath, r);
              return content !== null ? { ...r, content } : r;
            }),
          )
        : baseResults;
    if (opts.json) {
      console.log(JSON.stringify({ repoPath, results }, null, 2));
      return;
    }
    printResults(results, text, repoPath);
  } finally {
    await store.close();
  }
}

/**
 * Join `context — goal — text` with whitespace-safe em-dash separators.
 * Missing / blank parts are dropped so the ranker never sees a dangling
 * separator.
 */
function buildSearchText(
  text: string,
  context: string | undefined,
  goal: string | undefined,
): string {
  const parts: string[] = [];
  if (context !== undefined && context.trim() !== "") parts.push(context.trim());
  if (goal !== undefined && goal.trim() !== "") parts.push(goal.trim());
  parts.push(text);
  return parts.join(" — ");
}

/**
 * Read the symbol body from disk. `SearchResult` doesn't carry startLine /
 * endLine, so on the CLI path we return the first {@link INCLUDE_CONTENT_CHAR_CAP}
 * characters of the whole file — the MCP tool has access to the richer node
 * metadata and can slice more tightly. Any read error returns `null`.
 */
async function readSymbolContent(repoPath: string, r: SearchResult): Promise<string | null> {
  const abs = isAbsolute(r.filePath) ? r.filePath : resolve(repoPath, r.filePath);
  let source: string;
  try {
    source = await readFile(abs, "utf8");
  } catch {
    return null;
  }
  if (source.length <= INCLUDE_CONTENT_CHAR_CAP) return source;
  return `${source.slice(0, INCLUDE_CONTENT_CHAR_CAP - 1)}…`;
}

function printResults(results: readonly HitRow[], text: string, repoPath: string): void {
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
  // When --content was passed, append each symbol body below the table so
  // agents piping the output can grep/read it without JSON parsing.
  for (const r of results) {
    if (r.content === undefined) continue;
    console.log("");
    console.log(`# ${r.name} [${r.kind}] — ${r.filePath}`);
    console.log(r.content);
  }
}
