/**
 * `codehub query <text>` — hybrid BM25 + vector search.
 *
 * Mirrors the MCP `query` tool's smart path: probe the `embeddings` table,
 * try to open an embedder, run `hybridSearch` when both succeed, and
 * collapse to BM25 with a single stderr warning on any failure. Shares the
 * probe + open helpers (`embeddingsPopulated`, `tryOpenEmbedder`) via
 * `@opencodehub/search` so CLI and MCP surfaces cannot drift.
 *
 * Flags:
 *   - `--bm25-only` — skip the embedder probe entirely.
 *   - `--rerank-top-k <n>` — number of fused hits RRF returns (default
 *     `DEFAULT_RRF_TOP_K = 50`); clamped by `--limit` at print time.
 *   - `--context <text>` + `--goal <text>` — prefixed to the search text.
 *   - `--content` — attach capped symbol source to each hit.
 *   - `--json` — emit machine-readable output.
 *
 * Hybrid ranking priority matches the MCP tool:
 *   1. `CODEHUB_EMBEDDING_URL` + `CODEHUB_EMBEDDING_MODEL` → HTTP embedder.
 *   2. Otherwise local ONNX Arctic Embed XS weights.
 *   3. On failure to open (missing weights, unreachable HTTP) → warn + BM25.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { Embedder } from "@opencodehub/embedder";
import {
  bm25Search,
  DEFAULT_RRF_TOP_K,
  embeddingsPopulated,
  type FusedHit,
  hybridSearch,
  type SymbolHit,
  tryOpenEmbedder,
} from "@opencodehub/search";
import type { DuckDbStore, SymbolSummaryRow } from "@opencodehub/storage";
import { type OpenStoreResult, openStoreForCommand } from "./open-store.js";

/** Per-symbol cap for `--content`. Matches the MCP `query` tool contract. */
const INCLUDE_CONTENT_CHAR_CAP = 2000;
/** Truncation cap for the text-mode SUMMARY column. Matches the MCP snippet cap. */
const SUMMARY_COLUMN_CHAR_CAP = 120;

/**
 * Hook for tests to inject a pre-built store without touching DuckDB. The
 * default implementation delegates to {@link openStoreForCommand}. Kept
 * separate from the public `QueryOptions` interface so end-user CLI callers
 * aren't tempted to pass an in-process store.
 */
export interface QueryRuntimeHooks {
  readonly openStore?: (opts: QueryOptions) => Promise<OpenStoreResult>;
  /**
   * Embedder factory — production uses the default lazy-import path; tests
   * inject a fake so they don't need Arctic Embed XS weights on disk. Any
   * throw is caught by {@link tryOpenEmbedder} and collapses to BM25.
   */
  readonly openEmbedder?: () => Promise<Embedder>;
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
  /** `--max-symbols <n>` — cap on process-grouped symbols. Today: no-op. */
  readonly maxSymbols?: number;
  /** `--bm25-only` — skip the embedder probe, go straight to BM25. */
  readonly bm25Only?: boolean;
  /** `--rerank-top-k <n>` — number of fused hits RRF should return. */
  readonly rerankTopK?: number;
}

/**
 * Unified row shape printed by the CLI. Carries `sources` so agents parsing
 * JSON output can tell which ranker(s) contributed to each hit.
 */
interface QueryRow {
  readonly nodeId: string;
  readonly name: string;
  readonly kind: string;
  readonly filePath: string;
  readonly score: number;
  readonly sources: readonly ("bm25" | "vector")[];
  readonly content?: string;
  /** Present iff a `symbol_summaries` row exists for this node (P04). */
  readonly summary?: string;
  /** Compact one-line signature summary from the same row. */
  readonly signatureSummary?: string;
}

/**
 * Default production factory — lazy-imports `@opencodehub/embedder` so the
 * ONNX runtime native binding only loads when the command actually needs
 * it. Priority mirrors the MCP tool: HTTP env vars first, ONNX weights
 * second, graceful `tryOpenEmbedder` fallback on any failure.
 */
async function defaultOpenEmbedder(): Promise<Embedder> {
  const mod = await import("@opencodehub/embedder");
  const httpEmbedder = mod.tryOpenHttpEmbedder();
  if (httpEmbedder !== null) return httpEmbedder;
  return mod.openOnnxEmbedder();
}

export async function runQuery(
  text: string,
  opts: QueryOptions = {},
  hooks: QueryRuntimeHooks = {},
): Promise<void> {
  const limit = opts.limit ?? 10;
  const rerankTopK = opts.rerankTopK ?? DEFAULT_RRF_TOP_K;
  const openStore = hooks.openStore ?? openStoreForCommand;
  const openEmbedder = hooks.openEmbedder ?? defaultOpenEmbedder;
  const { store, repoPath } = await openStore(opts);
  try {
    const searchText = buildSearchText(text, opts.context, opts.goal);

    let ranked: readonly QueryRow[];
    let mode: "bm25" | "hybrid";

    if (opts.bm25Only === true) {
      // Explicit opt-out: never touch the embedder probe.
      ranked = await runBm25(store, searchText, limit);
      mode = "bm25";
    } else if (await embeddingsPopulated(store)) {
      const embedder = await tryOpenEmbedder<Embedder>(openEmbedder, "[cli:query]");
      if (embedder !== null) {
        try {
          const fused = await hybridSearch(
            store,
            { text: searchText, limit: rerankTopK },
            embedder,
          );
          ranked = await hydrateFused(store, fused, limit);
          mode = "hybrid";
        } finally {
          // Always release the native session — even on error — so the ONNX
          // runtime resources aren't leaked between CLI invocations.
          await embedder.close();
        }
      } else {
        ranked = await runBm25(store, searchText, limit);
        mode = "bm25";
      }
    } else {
      ranked = await runBm25(store, searchText, limit);
      mode = "bm25";
    }

    // Merge P04 summary-hydration onto the P02 hybrid/BM25 rows. Single
    // round trip via `IN (...)`; missing table / missing rows / lookup
    // failures all degrade silently — summaries are enrichment, not
    // load-bearing.
    const summaryMap = await joinSummaries(
      store,
      ranked.map((r) => r.nodeId),
    );
    const rows: readonly QueryRow[] =
      summaryMap.size === 0
        ? ranked
        : ranked.map((r) => {
            const row = summaryMap.get(r.nodeId);
            if (row === undefined) return r;
            return {
              ...r,
              summary: row.summaryText,
              ...(row.signatureSummary !== undefined
                ? { signatureSummary: row.signatureSummary }
                : {}),
            };
          });

    // Best-effort `--content` attachment runs the same way for BM25 and
    // hybrid; the store-native BM25 path already surfaces filePath but not
    // line ranges, so the CLI reads the whole file (capped) — matching the
    // previous CLI contract.
    const withContent: readonly QueryRow[] =
      opts.content === true
        ? await Promise.all(
            rows.map(async (r): Promise<QueryRow> => {
              const content = await readSymbolContent(repoPath, r);
              return content !== null ? { ...r, content } : r;
            }),
          )
        : rows;

    if (opts.json === true) {
      console.log(JSON.stringify({ repoPath, mode, results: withContent }, null, 2));
      return;
    }
    printResults(withContent, text, repoPath, mode);
  } finally {
    await store.close();
  }
}

/**
 * Run the BM25-only leg directly through `@opencodehub/search`. Same
 * parameters the MCP tool passes, so ranking parity is automatic.
 */
async function runBm25(
  store: OpenStoreResult["store"],
  searchText: string,
  limit: number,
): Promise<readonly QueryRow[]> {
  const hits = await bm25Search(store, { text: searchText, limit });
  return hits.map((h: SymbolHit) => ({
    nodeId: h.nodeId,
    name: h.name,
    kind: h.kind,
    filePath: h.filePath,
    score: h.score,
    sources: ["bm25" as const],
  }));
}

/**
 * Hybrid ranking returns `FusedHit`s which carry only `{ nodeId, score,
 * sources }` — the CLI needs name/kind/filePath for each hit too. Re-read
 * them from the `nodes` table in one round trip. Missing ids (stale
 * embeddings) are silently dropped. Input order is preserved.
 */
async function hydrateFused(
  store: OpenStoreResult["store"],
  fused: readonly FusedHit[],
  limit: number,
): Promise<readonly QueryRow[]> {
  if (fused.length === 0) return [];
  const capped = fused.slice(0, limit);
  const ids = Array.from(new Set(capped.map((f) => f.nodeId)));
  const placeholders = ids.map(() => "?").join(",");
  const meta = new Map<
    string,
    { readonly name: string; readonly kind: string; readonly filePath: string }
  >();
  try {
    const rows = await store.query(
      `SELECT id, name, kind, file_path FROM nodes WHERE id IN (${placeholders})`,
      ids,
    );
    for (const r of rows) {
      const id = String(r["id"] ?? "");
      if (id === "") continue;
      meta.set(id, {
        name: String(r["name"] ?? ""),
        kind: String(r["kind"] ?? ""),
        filePath: String(r["file_path"] ?? ""),
      });
    }
  } catch {
    // Any metadata-hydration failure collapses to "hit with blank fields"
    // rather than aborting the whole query — we still have valid nodeIds
    // + scores + sources. The agent can call `context` on the nodeId to
    // recover the details.
  }
  const out: QueryRow[] = [];
  for (const f of capped) {
    const m = meta.get(f.nodeId);
    if (m === undefined) continue;
    out.push({
      nodeId: f.nodeId,
      name: m.name,
      kind: m.kind,
      filePath: m.filePath,
      score: f.score,
      sources: f.sources,
    });
  }
  return out;
}

/**
 * Fetch `symbol_summaries` rows for every hit nodeId in a single query.
 * Collapses multiple prompt-version rows per node by keeping the last
 * row in the storage layer's documented `(node_id ASC, prompt_version
 * ASC, content_hash ASC)` order, which deterministically selects the
 * newest prompt version. Returns an empty map on any failure so a
 * missing `symbol_summaries` table never blocks a query. Test fakes
 * without `lookupSymbolSummariesByNode` get an empty join transparently.
 */
async function joinSummaries(
  store: DuckDbStore | { readonly lookupSymbolSummariesByNode?: unknown },
  nodeIds: readonly string[],
): Promise<Map<string, SymbolSummaryRow>> {
  const out = new Map<string, SymbolSummaryRow>();
  if (nodeIds.length === 0) return out;
  const lookup = (store as { readonly lookupSymbolSummariesByNode?: unknown })
    .lookupSymbolSummariesByNode;
  if (typeof lookup !== "function") return out;
  const uniqIds = Array.from(new Set(nodeIds));
  try {
    const rows = (await (lookup as (ids: readonly string[]) => Promise<readonly SymbolSummaryRow[]>).call(
      store,
      uniqIds,
    )) as readonly SymbolSummaryRow[];
    for (const row of rows) {
      // Overwriting per node id keeps the newest prompt version because of
      // the storage layer's ORDER BY contract on `lookupSymbolSummariesByNode`.
      out.set(row.nodeId, row);
    }
  } catch {
    // Degrade silently — summaries are enrichment, not load-bearing.
  }
  return out;
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
 * Read the symbol body from disk. The CLI `QueryRow` doesn't carry
 * startLine / endLine, so on the CLI path we return the first
 * {@link INCLUDE_CONTENT_CHAR_CAP} characters of the whole file — the MCP
 * tool has access to the richer node metadata and can slice more tightly.
 * Any read error returns `null`.
 */
async function readSymbolContent(
  repoPath: string,
  r: QueryRow,
): Promise<string | null> {
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

function printResults(
  results: readonly QueryRow[],
  text: string,
  repoPath: string,
  mode: "bm25" | "hybrid",
): void {
  const label = mode === "hybrid" ? "hybrid" : "BM25";
  console.warn(`query: "${text}" in ${repoPath} (${results.length} ${label} results)`);
  if (results.length === 0) return;
  // Only render the SUMMARY column when at least one hit carries one —
  // skip the extra whitespace on indexes that haven't run the summarize
  // phase yet. SOURCES stays on every row so agents can tell which ranker
  // contributed to each hit.
  const anySummary = results.some((r) => typeof r.summary === "string" && r.summary.length > 0);
  const header = anySummary
    ? ["SCORE", "KIND", "NAME", "FILE", "SOURCES", "SUMMARY"]
    : ["SCORE", "KIND", "NAME", "FILE", "SOURCES"];
  const rows = results.map((r) => {
    const base = [r.score.toFixed(3), r.kind, r.name, r.filePath, r.sources.join("+")];
    if (!anySummary) return base;
    return [...base, truncateSummary(r.summary)];
  });
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

/**
 * Render a summary string to fit the single-line SUMMARY column. Newlines
 * collapse to spaces so the column width survives; anything past the cap
 * is trimmed and closed with an ellipsis. Absent summaries render as an
 * empty string so the column aligns.
 */
function truncateSummary(summary: string | undefined): string {
  if (summary === undefined || summary.length === 0) return "";
  const flattened = summary.replace(/\s+/g, " ").trim();
  if (flattened.length <= SUMMARY_COLUMN_CHAR_CAP) return flattened;
  return `${flattened.slice(0, SUMMARY_COLUMN_CHAR_CAP - 1)}…`;
}
