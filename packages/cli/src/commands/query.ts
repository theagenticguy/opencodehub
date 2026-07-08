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
 *   - `--zoom` — P03 coarse-to-fine retrieval (file tier → symbol tier).
 *   - `--fanout <n>` — files to shortlist at the coarse step for `--zoom`.
 *   - `--granularity <tier>` — restrict ANN to one hierarchical tier
 *     (symbol/file/community). Defaults to "symbol".
 *
 * Hybrid ranking priority matches the MCP tool:
 *   1. `CODEHUB_EMBEDDING_URL` + `CODEHUB_EMBEDDING_MODEL` → HTTP embedder.
 *   2. Otherwise local ONNX F2LLM-v2-80M weights.
 *   3. On failure to open (missing weights, unreachable HTTP) → warn + BM25.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  assertEmbedderCompatible,
  type Embedder,
  openDefaultEmbedder,
} from "@opencodehub/embedder";
import {
  bm25Search,
  DEFAULT_RRF_TOP_K,
  embeddingsPopulated,
  type FusedHit,
  hybridSearch,
  type SymbolHit,
  tryOpenEmbedder,
} from "@opencodehub/search";
import type { Store } from "@opencodehub/storage";
import { type OpenStoreResult, openStoreForCommand } from "./open-store.js";

/** Per-symbol cap for `--content`. Matches the MCP `query` tool contract. */
const INCLUDE_CONTENT_CHAR_CAP = 2000;

/**
 * Hook for tests to inject a pre-built store without touching SQLite. The
 * default implementation delegates to {@link openStoreForCommand}. Kept
 * separate from the public `QueryOptions` interface so end-user CLI callers
 * aren't tempted to pass an in-process store.
 */
export interface QueryRuntimeHooks {
  readonly openStore?: (opts: QueryOptions) => Promise<OpenStoreResult>;
  /**
   * Embedder factory — production uses the default lazy-import path; tests
   * inject a fake so they don't need F2LLM-v2-80M weights on disk. Any
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
  /**
   * `--zoom` — enable P03 coarse-to-fine retrieval. Requires the index to
   * have been built with `--granularity symbol,file,community` AND an
   * embedder to be available (weights on disk or `CODEHUB_EMBEDDING_URL`
   * set). Falls back to BM25 when no embedder is available.
   */
  readonly zoom?: boolean;
  /** `--fanout <n>` — files to shortlist at the coarse step when `--zoom` is on. */
  readonly fanout?: number;
  /**
   * `--granularity <tier>` — restrict the ANN leg to this hierarchical
   * tier. Defaults to "symbol". Pass "community" for architectural
   * queries that should land on Community nodes.
   */
  readonly granularity?: "symbol" | "file" | "community";
  /**
   * `--force-backend-mismatch` — bypass the embedder fingerprint refusal.
   * Lets a query proceed against an `embeddings` table that was populated
   * by a different embedder than the one currently active. The vectors
   * may be stale; results may misrank. Default `false`.
   */
  readonly forceBackendMismatch?: boolean;
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
}

export async function runQuery(
  text: string,
  opts: QueryOptions = {},
  hooks: QueryRuntimeHooks = {},
): Promise<void> {
  const limit = opts.limit ?? 10;
  const rerankTopK = opts.rerankTopK ?? DEFAULT_RRF_TOP_K;
  const openStore = hooks.openStore ?? openStoreForCommand;
  // Shared HTTP-priority + ONNX-fallback factory. ONNX binding only loads
  // on the fallback branch, so plain (non-dynamic) import is fine here.
  const openEmbedder = hooks.openEmbedder ?? (() => openDefaultEmbedder());
  const { store, repoPath } = await openStore(opts);
  const graph = store.graph;
  try {
    const searchText = buildSearchText(text, opts.context, opts.goal);

    let ranked: readonly QueryRow[];
    let mode: "bm25" | "hybrid";

    if (opts.bm25Only === true) {
      // Explicit opt-out: never touch the embedder probe.
      ranked = await runBm25(graph, searchText, limit);
      mode = "bm25";
    } else if (await embeddingsPopulated(graph)) {
      const embedder = await tryOpenEmbedder<Embedder>(openEmbedder, "[cli:query]");
      if (embedder !== null) {
        try {
          // Refuse the hybrid path when the persisted embedder modelId
          // differs from the current one. Same-dim vectors from different
          // embedders silently corrupt ranking. `--force-backend-mismatch`
          // lets the operator override; legacy stores have
          // `embedderModelId === undefined` and the check passes.
          const meta = await store.graph.getMeta();
          const compat = assertEmbedderCompatible(
            meta?.embedderModelId,
            embedder.modelId,
            opts.forceBackendMismatch === true,
          );
          if (!compat.ok) {
            process.stderr.write(
              `Embedder mismatch: store was indexed with '${compat.persistedModelId}', ` +
                `current embedder is '${compat.currentModelId}'.\n${compat.hint}\n`,
            );
            // Set the distinct exit code and return rather than calling
            // process.exit(2): an immediate process.exit() terminates the
            // event loop before either the inner `embedder.close()` finally
            // (line ~186) or the outer `store.close()` finally (line ~241)
            // runs, leaking the native ONNX session and the composed store's
            // graph + temporal handles on this abort path. `return` unwinds
            // through both finally blocks first, honoring this file's own
            // "always release the native session" contract.
            process.exitCode = 2;
            return;
          }
          const fused = await hybridSearch(
            graph,
            {
              text: searchText,
              limit: rerankTopK,
              ...(opts.zoom === true ? { mode: "zoom" as const } : {}),
              ...(opts.fanout !== undefined ? { zoomFanout: opts.fanout } : {}),
              ...(opts.granularity !== undefined ? { granularity: opts.granularity } : {}),
            },
            embedder,
          );
          ranked = await hydrateFused(graph, fused, limit);
          mode = "hybrid";
        } finally {
          // Always release the native session — even on error — so the ONNX
          // runtime resources aren't leaked between CLI invocations.
          await embedder.close();
        }
      } else {
        ranked = await runBm25(graph, searchText, limit);
        mode = "bm25";
      }
    } else {
      ranked = await runBm25(graph, searchText, limit);
      mode = "bm25";
    }

    // Best-effort `--content` attachment runs the same way for BM25 and
    // hybrid; the store-native BM25 path already surfaces filePath but not
    // line ranges, so the CLI reads the whole file (capped) — matching the
    // previous CLI contract.
    const withContent: readonly QueryRow[] =
      opts.content === true
        ? await Promise.all(
            ranked.map(async (r): Promise<QueryRow> => {
              const content = await readSymbolContent(repoPath, r);
              return content !== null ? { ...r, content } : r;
            }),
          )
        : ranked;

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
  graph: Store["graph"],
  searchText: string,
  limit: number,
): Promise<readonly QueryRow[]> {
  const hits = await bm25Search(graph, { text: searchText, limit });
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
  graph: Store["graph"],
  fused: readonly FusedHit[],
  limit: number,
): Promise<readonly QueryRow[]> {
  if (fused.length === 0) return [];
  const capped = fused.slice(0, limit);
  const ids = Array.from(new Set(capped.map((f) => f.nodeId)));
  const meta = new Map<
    string,
    { readonly name: string; readonly kind: string; readonly filePath: string }
  >();
  try {
    // Typed-finder hydration replaces the legacy `SELECT id, name, kind,
    // file_path FROM nodes WHERE id IN (...)`. `listNodes({ids})`
    // already returns the rehydrated `GraphNode` shape with name + kind
    // + filePath populated.
    const nodes = await graph.listNodes({ ids });
    for (const n of nodes) {
      meta.set(n.id, { name: n.name, kind: n.kind, filePath: n.filePath });
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
async function readSymbolContent(repoPath: string, r: QueryRow): Promise<string | null> {
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
  // SOURCES stays on every row so agents can tell which ranker contributed
  // to each hit.
  const header = ["SCORE", "KIND", "NAME", "FILE", "SOURCES"];
  const rows = results.map((r) => [
    r.score.toFixed(3),
    r.kind,
    r.name,
    r.filePath,
    r.sources.join("+"),
  ]);
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
