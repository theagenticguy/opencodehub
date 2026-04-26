/**
 * `query` — true hybrid retrieval over the indexed graph.
 *
 * Two ranked runs, fused with Reciprocal Rank Fusion (k=60):
 *   1. BM25 (DuckDB FTS) over `nodes.name` + `nodes.signature` +
 *      `nodes.description`. If a `symbol_summaries` table is present the
 *      corpus extends transparently (see {@link bm25CorpusHasSummaries}) so
 *      summarized prose participates as soon as the ingestion phase lands.
 *   2. HNSW vector search over the `embeddings` table. The query text is
 *      embedded with the same gte-modernbert-base ONNX model the ingestion
 *      pipeline uses, so the vectors live in the same space.
 *
 * Graceful fallback:
 *   - If the `embeddings` table is empty, skip the vector leg entirely.
 *   - If the embedder weights are missing (EMBEDDER_NOT_SETUP) or any other
 *     failure blocks the embedder from opening, warn once to stderr and fall
 *     back to BM25-only. We never abort the query — the invariant is that a
 *     fresh-cloned repo still answers `query` before `codehub setup
 *     --embeddings` has been run.
 *
 * The response shape is stable across BM25-only and hybrid paths:
 *   `{ results, definitions, processes, process_symbols, mode }`.
 * `results` is the primary ranked list; `definitions` mirrors it one-to-one
 * (preserved for agents that learned the legacy shape). `processes` +
 * `process_symbols` hold the process-grouped view: after fusion we walk
 * PROCESS_STEP edges backwards from each top-K hit to locate the containing
 * Process nodes, then walk PROCESS_STEP edges forward from each matched
 * Process's entry point to enumerate its ordered member steps. Both walks
 * happen in ONE consolidated SQL query (two CTEs + a join) so the enrichment
 * pass is a single round-trip. When no Process touches a top-K hit, or the
 * repo has no PROCESS_STEP edges yet, the arrays stay empty — the flat
 * `results` ranking still covers the query.
 */

import { isAbsolute, resolve as resolvePath } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createNodeFs, type FsAbstraction } from "@opencodehub/analysis";
import type { Embedder } from "@opencodehub/embedder";
import type { FusedHit, SymbolHit } from "@opencodehub/search";
import {
  bm25Search,
  embeddingsPopulated,
  hybridSearch,
  tryOpenEmbedder,
} from "@opencodehub/search";
import type { DuckDbStore, SqlParam, SymbolSummaryRow } from "@opencodehub/storage";
import { z } from "zod";
import { toolErrorFromUnknown } from "../error-envelope.js";
import { withNextSteps } from "../next-step-hints.js";
import { stalenessFromMeta } from "../staleness.js";
import {
  fromToolResult,
  type ToolContext,
  type ToolResult,
  toToolResult,
  withStore,
} from "./shared.js";

const SNIPPET_CHAR_CAP = 200;
/**
 * Per-symbol cap for `content` when `include_content: true`. Keeps large
 * symbol bodies from bloating the MCP response envelope while leaving
 * room for the agent to see enough of the definition to reason about it.
 */
const INCLUDE_CONTENT_CHAR_CAP = 2000;
/** Default cap for `process_symbols` after grouping (see `max_symbols`). */
const DEFAULT_MAX_SYMBOLS = 50;

const QueryInput = {
  query: z
    .string()
    .min(1)
    .describe("Free-text search phrase; embedded + BM25-searched, then fused via RRF."),
  repo: z
    .string()
    .optional()
    .describe("Registered repo name. Omit to use the only registered repo."),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe("Maximum number of ranked hits to return (default 10, max 100)."),
  kinds: z
    .array(z.string())
    .optional()
    .describe("Restrict to these NodeKind values (e.g. ['Function','Method'])."),
  task_context: z
    .string()
    .optional()
    .describe(
      "What you are working on (e.g., 'adding OAuth support'). Prefixed to the query text before embedding + BM25 so the ranker sees the broader intent.",
    ),
  goal: z
    .string()
    .optional()
    .describe(
      "What you want to find (e.g., 'existing auth validation logic'). Prefixed to the query text alongside task_context to steer the ranker.",
    ),
  include_content: z
    .boolean()
    .optional()
    .describe(
      "When true, re-read each result's source file between startLine/endLine and attach the body as `content` (capped at 2000 chars). Default false.",
    ),
  max_symbols: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe(
      "Maximum number of symbols to return in `process_symbols` after process grouping (default 50). `results[]` remains capped by `limit`.",
    ),
  granularity: z
    .enum(["symbol", "file", "community"])
    .optional()
    .describe(
      "Hierarchical embedding tier to search. Defaults to 'symbol' (v1.0 behaviour). Set to 'community' to retrieve architectural clusters; set to 'file' to score files. Requires the index to have been built with `--granularity symbol,file,community`.",
    ),
  mode: z
    .enum(["flat", "zoom"])
    .optional()
    .describe(
      "Retrieval strategy. 'flat' (default) runs one symbol-tier ANN pass fused with BM25. 'zoom' runs a coarse file-tier pass first, then restricts the symbol-tier pass to symbols inside the top file shortlist (`zoom_fanout` files by default).",
    ),
  zoom_fanout: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe("How many files to shortlist at the coarse step when `mode=zoom`. Default 10."),
};

/** Row shape returned to the MCP client. Stable across BM25-only + hybrid. */
interface QueryRow {
  readonly rank: number;
  readonly nodeId: string;
  readonly name: string;
  readonly kind: string;
  readonly filePath: string;
  readonly startLine: number | null;
  readonly endLine: number | null;
  readonly snippet: string | null;
  readonly score: number;
  readonly sources: readonly ("bm25" | "vector")[];
  /** Present iff `include_content: true` was requested and the file was readable. */
  readonly content?: string;
  /** Present iff a `symbol_summaries` row exists for this node (P04). */
  readonly summary?: string;
  /** Compact one-line signature summary from the same row. */
  readonly signatureSummary?: string;
}

/** Node metadata hydrated from the `nodes` table after fusion. */
interface NodeMeta {
  readonly name: string;
  readonly kind: string;
  readonly filePath: string;
  readonly startLine: number | null;
  readonly endLine: number | null;
}

/**
 * Process-grouped enrichment emitted alongside the flat `results` list.
 * `score` is the maximum fused-hit score among top-K hits that belong to
 * the process (via the PROCESS_STEP walk). `processType` distinguishes the
 * entry-point flavour today OCH only emits BFS-derived flows, so the value
 * is always "flow"; keeping the field shape-stable lets future process
 * kinds (route flows, tool flows) light up without a schema rev.
 */
interface ProcessGroup {
  readonly id: string;
  readonly label: string;
  readonly processType: string;
  readonly stepCount: number;
  readonly score: number;
}

/**
 * One member symbol of a Process, paired with its BFS depth (`step`).
 * `step: 0` is the entry point itself; deeper numbers come from the
 * PROCESS_STEP edges emitted by the ingestion phase.
 */
interface ProcessSymbol {
  readonly process_id: string;
  readonly nodeId: string;
  readonly name: string;
  readonly kind: string;
  readonly filePath: string;
  readonly step: number;
}

/**
 * Batched summary join for the top-K ranked hits. Short-circuits to an
 * empty map when either `symbol_summaries` does not exist / is empty (the
 * `summariesJoined` probe already ran) or the input list is empty. Any
 * lookup failure is swallowed — summary enrichment is never load-bearing.
 *
 * We collapse multiple prompt-version rows per node by keeping the last
 * one in `(node_id ASC, prompt_version ASC, content_hash ASC)` order,
 * which is the storage layer's documented ordering contract — that
 * deterministically selects the newest prompt version.
 */
async function lookupSummariesForHits(
  store: DuckDbStore,
  summariesJoined: boolean,
  nodeIds: readonly string[],
): Promise<Map<string, SymbolSummaryRow>> {
  const out = new Map<string, SymbolSummaryRow>();
  if (!summariesJoined) return out;
  const uniqIds = Array.from(new Set(nodeIds));
  if (uniqIds.length === 0) return out;
  try {
    const rows = await store.lookupSymbolSummariesByNode(uniqIds);
    for (const row of rows) {
      // Overwriting per node id keeps the newest prompt version because of
      // the ORDER BY contract in `lookupSymbolSummariesByNode`.
      out.set(row.nodeId, row);
    }
  } catch {
    // Table missing / schema drift / I/O failure: return an empty map so
    // the query surfaces degrade silently to "no summaries attached".
  }
  return out;
}

/**
 * Extensibility hook: return true iff the `symbol_summaries` table exists
 * and is non-empty. When it does, future BM25 upgrades can JOIN it into
 * the FTS corpus. Today this is informational — the DuckDB FTS index is
 * built at ingestion time against `nodes` columns only — but the probe
 * lives here so the sibling summarizer work can light up a corpus
 * extension without re-threading the tool.
 */
async function bm25CorpusHasSummaries(store: DuckDbStore): Promise<boolean> {
  try {
    const rows = await store.query(
      "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_name = 'symbol_summaries'",
      [],
    );
    const first = rows[0];
    if (!first) return false;
    const hasTable = Number(first["n"] ?? 0) > 0;
    if (!hasTable) return false;
    const rows2 = await store.query("SELECT COUNT(*) AS n FROM symbol_summaries", []);
    const first2 = rows2[0];
    if (!first2) return false;
    return Number(first2["n"] ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Fetch name/kind/filePath/startLine/endLine for a set of node ids in one
 * round trip. Ids missing from the store (e.g. stale embeddings) are
 * silently dropped from the returned map.
 */
async function hydrateNodeMeta(
  store: DuckDbStore,
  ids: readonly string[],
): Promise<Map<string, NodeMeta>> {
  const out = new Map<string, NodeMeta>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => "?").join(",");
  const params: readonly SqlParam[] = ids;
  const rows = await store.query(
    `SELECT id, name, file_path, kind, start_line, end_line FROM nodes WHERE id IN (${placeholders})`,
    params,
  );
  for (const r of rows) {
    const id = String(r["id"] ?? "");
    if (id === "") continue;
    out.set(id, {
      name: String(r["name"] ?? ""),
      filePath: String(r["file_path"] ?? ""),
      kind: String(r["kind"] ?? ""),
      startLine: toLineOrNull(r["start_line"]),
      endLine: toLineOrNull(r["end_line"]),
    });
  }
  return out;
}

function toLineOrNull(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

/**
 * Pull a snippet of the source file between `[startLine, endLine]`, capped
 * at {@link SNIPPET_CHAR_CAP} characters. Returns `null` when the file
 * can't be read (renamed, deleted, permission error) or when the line
 * range is missing or obviously bogus. Never throws — snippet extraction
 * is best-effort.
 */
async function extractSnippet(
  fs: FsAbstraction,
  repoRoot: string,
  filePath: string,
  startLine: number | null,
  endLine: number | null,
): Promise<string | null> {
  if (startLine === null || endLine === null) return null;
  if (endLine < startLine) return null;
  const abs = isAbsolute(filePath) ? filePath : resolvePath(repoRoot, filePath);
  let source: string;
  try {
    source = await fs.readFile(abs);
  } catch {
    return null;
  }
  const lines = source.split("\n");
  if (lines.length === 0) return null;
  const safeStart = Math.max(1, startLine);
  const safeEnd = Math.min(lines.length, endLine);
  if (safeEnd < safeStart) return null;
  const slice = lines.slice(safeStart - 1, safeEnd).join("\n");
  if (slice.length <= SNIPPET_CHAR_CAP) return slice;
  return `${slice.slice(0, SNIPPET_CHAR_CAP - 1)}…`;
}

/**
 * Enrich ranked hits (FusedHit or plain SymbolHit-derived) with node
 * metadata and snippets. Order is preserved from the input list.
 */
async function enrichWithContext(
  store: DuckDbStore,
  fs: FsAbstraction,
  repoRoot: string,
  hits: readonly { nodeId: string; score: number; sources: readonly ("bm25" | "vector")[] }[],
): Promise<readonly QueryRow[]> {
  if (hits.length === 0) return [];
  const uniqIds = Array.from(new Set(hits.map((h) => h.nodeId)));
  const meta = await hydrateNodeMeta(store, uniqIds);
  const out: QueryRow[] = [];
  let rank = 0;
  for (const hit of hits) {
    const m = meta.get(hit.nodeId);
    if (!m) continue;
    rank += 1;
    const snippet = await extractSnippet(fs, repoRoot, m.filePath, m.startLine, m.endLine);
    out.push({
      rank,
      nodeId: hit.nodeId,
      name: m.name,
      kind: m.kind,
      filePath: m.filePath,
      startLine: m.startLine,
      endLine: m.endLine,
      snippet,
      score: hit.score,
      sources: hit.sources,
    });
  }
  return out;
}

/**
 * Read the full body of a symbol from disk between `[startLine, endLine]`,
 * capped at {@link INCLUDE_CONTENT_CHAR_CAP} characters. Best-effort: any
 * read error or missing line range returns `null` so the caller can simply
 * omit the `content` field for that row.
 *
 * Distinct from {@link extractSnippet} — that one is always on and caps at
 * 200 chars; this one fires only when `include_content: true` and gives
 * the agent a much larger window (2000 chars) into the symbol body.
 */
async function readSymbolContent(
  fs: FsAbstraction,
  repoRoot: string,
  filePath: string,
  startLine: number | null,
  endLine: number | null,
): Promise<string | null> {
  if (startLine === null || endLine === null) return null;
  if (endLine < startLine) return null;
  const abs = isAbsolute(filePath) ? filePath : resolvePath(repoRoot, filePath);
  let source: string;
  try {
    source = await fs.readFile(abs);
  } catch {
    return null;
  }
  const lines = source.split("\n");
  if (lines.length === 0) return null;
  const safeStart = Math.max(1, startLine);
  const safeEnd = Math.min(lines.length, endLine);
  if (safeEnd < safeStart) return null;
  const slice = lines.slice(safeStart - 1, safeEnd).join("\n");
  if (slice.length <= INCLUDE_CONTENT_CHAR_CAP) return slice;
  return `${slice.slice(0, INCLUDE_CONTENT_CHAR_CAP - 1)}…`;
}

/**
 * Build the text fed to BM25 + embedding when the caller supplied
 * `task_context` and/or `goal`. Parts are joined by " — " (em-dash with
 * surrounding spaces) in the order `task_context — goal — query`. Empty /
 * whitespace-only parts are dropped so the concatenation never starts with
 * a dangling separator.
 */
function buildSearchText(
  query: string,
  taskContext: string | undefined,
  goal: string | undefined,
): string {
  const parts: string[] = [];
  if (taskContext !== undefined && taskContext.trim() !== "") parts.push(taskContext.trim());
  if (goal !== undefined && goal.trim() !== "") parts.push(goal.trim());
  parts.push(query);
  return parts.join(" — ");
}

/** Convert BM25-only hits into the uniform fused-shaped row. */
function bm25RowsAsFused(
  hits: readonly SymbolHit[],
): readonly { nodeId: string; score: number; sources: readonly ("bm25" | "vector")[] }[] {
  return hits.map((h) => ({
    nodeId: h.nodeId,
    score: h.score,
    sources: ["bm25" as const],
  }));
}

/** Convert FusedHit[] to the enrichWithContext input shape. */
function fusedAsRanked(
  fused: readonly FusedHit[],
): readonly { nodeId: string; score: number; sources: readonly ("bm25" | "vector")[] }[] {
  return fused.map((f) => ({ nodeId: f.nodeId, score: f.score, sources: f.sources }));
}

/**
 * Default production factory — lazy-imports `@opencodehub/embedder` so the
 * ONNX runtime native binding only loads when the tool actually needs it.
 * Tests replace this via `ctx.openEmbedder` so they don't have to stage
 * gte-modernbert-base weight files on disk.
 *
 * Priority:
 *   1. If `CODEHUB_EMBEDDING_URL` + `CODEHUB_EMBEDDING_MODEL` are set, route
 *      through the HTTP embedder. The query tool runs inside the MCP stdio
 *      server which never runs in offline mode, so the HTTP path is
 *      available whenever the env is configured.
 *   2. Otherwise, open the local ONNX embedder. The existing graceful
 *      fallback (`EMBEDDER_NOT_SETUP` → BM25-only) continues to apply.
 *
 * Any dim mismatch between the remote model and the stored vectors surfaces
 * as an error on the first `embed()` call, which `tryOpenEmbedder` catches
 * and degrades to BM25-only with a clear warning.
 */
async function defaultOpenEmbedder(): Promise<Embedder> {
  const mod = await import("@opencodehub/embedder");
  const httpEmbedder = mod.tryOpenHttpEmbedder();
  if (httpEmbedder !== null) return httpEmbedder;
  return mod.openOnnxEmbedder();
}

/**
 * Walk PROCESS_STEP edges backwards from each top-K hit to find containing
 * Process nodes, then walk PROCESS_STEP edges forward from each matched
 * Process's entry point to enumerate its ordered member symbols. All of
 * this happens in a single consolidated query: two recursive CTEs + a
 * join against `nodes` for symbol metadata. Returns empty arrays when no
 * processes touch a hit, or when the repo has no PROCESS_STEP edges.
 *
 * Depth cap of 10 on both walks matches `MAX_DEPTH` in the ingestion
 * `processes` phase — any member reachable during ingestion is reachable
 * here. `USING KEY` dedupes the recursion frontier so dense call graphs
 * don't blow up.
 */
async function fetchProcessGrouping(
  store: DuckDbStore,
  hits: readonly { nodeId: string; score: number }[],
): Promise<{
  readonly groups: readonly ProcessGroup[];
  readonly symbols: readonly ProcessSymbol[];
}> {
  if (hits.length === 0) return { groups: [], symbols: [] };
  const hitIds = Array.from(new Set(hits.map((h) => h.nodeId)));
  if (hitIds.length === 0) return { groups: [], symbols: [] };
  const placeholders = hitIds.map(() => "?").join(",");
  // Any failure here (schema mismatch, DuckDB version without `USING KEY`,
  // etc.) degrades gracefully to an empty grouping — callers treat missing
  // processes as "no PROCESS_STEP detection yet" and still return the flat
  // `results` list. We never want process enrichment to abort a query.
  let rows: readonly Record<string, unknown>[];
  try {
    rows = await store.query(
      `WITH RECURSIVE
         ancestors(ancestor_id, depth) USING KEY (ancestor_id) AS (
           SELECT CAST(n.id AS TEXT), 0 FROM nodes n WHERE n.id IN (${placeholders})
           UNION ALL
           SELECT r.from_id, a.depth + 1
             FROM ancestors a
             JOIN relations r ON r.to_id = a.ancestor_id AND r.type = 'PROCESS_STEP'
            WHERE a.depth < 10
         ),
         matched_processes AS (
           SELECT DISTINCT p.id             AS process_id,
                           p.name           AS process_name,
                           p.inferred_label AS inferred_label,
                           p.step_count     AS step_count,
                           p.entry_point_id AS entry_point_id
             FROM nodes p
             JOIN ancestors a ON a.ancestor_id = p.entry_point_id
            WHERE p.kind = 'Process'
         ),
         members(process_id, node_id, step) USING KEY (process_id, node_id) AS (
           SELECT mp.process_id, mp.entry_point_id, 0
             FROM matched_processes mp
           UNION ALL
           SELECT m.process_id, r.to_id, m.step + 1
             FROM members m
             JOIN relations r ON r.from_id = m.node_id AND r.type = 'PROCESS_STEP'
            WHERE m.step < 10
         )
       SELECT mp.process_id      AS process_id,
              mp.process_name    AS process_name,
              mp.inferred_label  AS inferred_label,
              mp.step_count      AS step_count,
              m.node_id          AS node_id,
              m.step             AS step,
              n.name             AS node_name,
              n.kind             AS node_kind,
              n.file_path        AS node_file
         FROM matched_processes mp
         JOIN members m ON m.process_id = mp.process_id
         JOIN nodes n ON n.id = m.node_id
        ORDER BY mp.process_id ASC, m.step ASC, m.node_id ASC`,
      hitIds,
    );
  } catch {
    return { groups: [], symbols: [] };
  }

  if (rows.length === 0) return { groups: [], symbols: [] };

  // Index fused-hit scores so we can score each process by the best hit
  // that reaches it. A process with two top-K hits at score 0.8 and 0.6
  // gets score 0.8.
  const scoreById = new Map<string, number>();
  for (const h of hits) {
    const prev = scoreById.get(h.nodeId);
    if (prev === undefined || h.score > prev) scoreById.set(h.nodeId, h.score);
  }

  const groupById = new Map<string, { group: ProcessGroup; scoreCandidates: number[] }>();
  const symbols: ProcessSymbol[] = [];
  for (const r of rows) {
    const processId = String(r["process_id"] ?? "");
    const nodeId = String(r["node_id"] ?? "");
    if (processId === "" || nodeId === "") continue;
    const stepRaw = Number(r["step"] ?? 0);
    const step = Number.isFinite(stepRaw) ? Math.max(0, Math.trunc(stepRaw)) : 0;
    if (!groupById.has(processId)) {
      const processName = String(r["process_name"] ?? "");
      const inferredLabel = r["inferred_label"];
      const label =
        typeof inferredLabel === "string" && inferredLabel.length > 0 ? inferredLabel : processName;
      const stepCountRaw = Number(r["step_count"] ?? 0);
      const stepCount = Number.isFinite(stepCountRaw) ? Math.max(0, Math.trunc(stepCountRaw)) : 0;
      groupById.set(processId, {
        group: {
          id: processId,
          label,
          processType: "flow",
          stepCount,
          score: 0,
        },
        scoreCandidates: [],
      });
    }
    const bucket = groupById.get(processId);
    if (bucket === undefined) continue;
    const hitScore = scoreById.get(nodeId);
    if (hitScore !== undefined) bucket.scoreCandidates.push(hitScore);
    symbols.push({
      process_id: processId,
      nodeId,
      name: String(r["node_name"] ?? ""),
      kind: String(r["node_kind"] ?? ""),
      filePath: String(r["node_file"] ?? ""),
      step,
    });
  }

  const groups: ProcessGroup[] = [];
  for (const { group, scoreCandidates } of groupById.values()) {
    const score = scoreCandidates.length === 0 ? 0 : Math.max(...scoreCandidates);
    groups.push({ ...group, score });
  }
  // Deterministic ordering: highest process score first, then id ascending.
  groups.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return { groups, symbols };
}

interface QueryArgs {
  readonly query: string;
  readonly repo?: string;
  readonly limit?: number;
  readonly kinds?: readonly string[];
  readonly task_context?: string;
  readonly goal?: string;
  readonly include_content?: boolean;
  readonly max_symbols?: number;
  /** Hierarchical tier filter (P03). Defaults to "symbol". */
  readonly granularity?: "symbol" | "file" | "community";
  /** "flat" (default) or "zoom" coarse-to-fine retrieval. */
  readonly mode?: "flat" | "zoom";
  /** Coarse file-tier fanout when mode=zoom. */
  readonly zoom_fanout?: number;
}

export async function runQuery(ctx: ToolContext, args: QueryArgs): Promise<ToolResult> {
  const limit = args.limit ?? 10;
  const maxSymbols = args.max_symbols ?? DEFAULT_MAX_SYMBOLS;
  const includeContent = args.include_content === true;
  const openEmbedder = ctx.openEmbedder ?? defaultOpenEmbedder;
  const fsFactory = ctx.fsFactory ?? createNodeFs;
  // `searchText` is what goes to BM25 + the embedder. When `task_context`
  // or `goal` are present, they get prefixed so the ranker sees the broader
  // intent; `args.query` remains the human-facing string echoed in headers.
  const searchText = buildSearchText(args.query, args.task_context, args.goal);
  const call = await withStore(ctx, args.repo, async (store, resolved) => {
    try {
      const kinds = args.kinds && args.kinds.length > 0 ? args.kinds : undefined;

      // Probe for the symbol_summaries table so the value is recorded
      // alongside `mode` (surfaces via structuredContent). This is a
      // cheap metadata read; it runs once per query.
      const summariesJoined = await bm25CorpusHasSummaries(store);

      let ranked: readonly {
        nodeId: string;
        score: number;
        sources: readonly ("bm25" | "vector")[];
      }[];
      let mode: "bm25" | "hybrid" = "bm25";

      if (await embeddingsPopulated(store)) {
        const embedder = await tryOpenEmbedder<Embedder>(openEmbedder, "[mcp:query]");
        if (embedder) {
          try {
            const fused = await hybridSearch(
              store,
              {
                text: searchText,
                limit,
                ...(kinds !== undefined ? { kinds } : {}),
                ...(args.mode !== undefined ? { mode: args.mode } : {}),
                ...(args.zoom_fanout !== undefined ? { zoomFanout: args.zoom_fanout } : {}),
                ...(args.granularity !== undefined ? { granularity: args.granularity } : {}),
              },
              embedder,
            );
            ranked = fusedAsRanked(fused);
            mode = "hybrid";
          } finally {
            // Always release the native session — even on error —
            // so we don't leak ONNX runtime resources.
            await embedder.close();
          }
        } else {
          const bmHits = await bm25Search(store, {
            text: searchText,
            limit,
            ...(kinds !== undefined ? { kinds } : {}),
          });
          ranked = bm25RowsAsFused(bmHits);
        }
      } else {
        const bmHits = await bm25Search(store, {
          text: searchText,
          limit,
          ...(kinds !== undefined ? { kinds } : {}),
        });
        ranked = bm25RowsAsFused(bmHits);
      }

      const fs = fsFactory();
      const enrichedRows = await enrichWithContext(store, fs, resolved.repoPath, ranked);

      // Join `symbol_summaries` onto each hit when P04 data is present.
      // Single round trip for the whole top-K via `IN (...)`; missing rows
      // simply omit `summary` / `signatureSummary`. Any lookup failure
      // degrades silently — summaries are enrichment, not load-bearing.
      const summaryMap = await lookupSummariesForHits(
        store,
        summariesJoined,
        enrichedRows.map((r) => r.nodeId),
      );
      const baseRows: readonly QueryRow[] =
        summaryMap.size === 0
          ? enrichedRows
          : enrichedRows.map((r) => {
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

      // When `include_content` is requested, re-read each result's source
      // between startLine/endLine and attach a capped `content` body. This
      // is best-effort — any unreadable path simply omits the field.
      const rows: readonly QueryRow[] = includeContent
        ? await Promise.all(
            baseRows.map(async (r): Promise<QueryRow> => {
              const content = await readSymbolContent(
                fs,
                resolved.repoPath,
                r.filePath,
                r.startLine,
                r.endLine,
              );
              return content !== null ? { ...r, content } : r;
            }),
          )
        : baseRows;

      const modeLabel = mode === "hybrid" ? "hybrid" : "BM25";
      const header = `Top ${rows.length} ${modeLabel} match(es) for "${args.query}" in ${resolved.name}:`;
      const body =
        rows.length === 0
          ? "(no matches — try a broader phrase or drop the kinds filter)"
          : rows
              .map(
                (r) =>
                  `${r.rank}. ${r.name} [${r.kind}] — ${r.filePath}${
                    r.startLine !== null ? `:${r.startLine}` : ""
                  } (score ${r.score.toFixed(3)}, sources=${r.sources.join("+")})`,
              )
              .join("\n");

      const next =
        rows.length === 0
          ? ["broaden the query or remove `kinds` filter"]
          : [
              `call \`context\` with symbol="${rows[0]?.name ?? ""}" to see its callers/callees`,
              `call \`impact\` on the top match to see its blast radius`,
            ];

      const staleness = stalenessFromMeta(resolved.meta);
      // `definitions` mirrors `results` for agents that learned the legacy
      // shape. `processes` + `process_symbols` come from one consolidated
      // PROCESS_STEP walk: backward from the top-K hits to find Process
      // nodes, then forward from each matched Process's entry point to
      // enumerate members. Repos without PROCESS_STEP edges yet (fresh
      // index pre-`processes` phase, or ingestion where the phase emitted
      // no flows) naturally return empty arrays. `max_symbols` caps the
      // flat `process_symbols` list AFTER grouping; `results[]` is always
      // capped by `limit`.
      const { groups: processes, symbols: processSymbols } = await fetchProcessGrouping(
        store,
        ranked,
      );
      const cappedProcessSymbols = processSymbols.slice(0, maxSymbols);
      return withNextSteps(
        `${header}\n${body}`,
        {
          results: rows,
          definitions: rows,
          processes,
          process_symbols: cappedProcessSymbols,
          mode,
          summaries_joined: summariesJoined,
        },
        next,
        staleness,
      );
    } catch (err) {
      return toolErrorFromUnknown(err);
    }
  });
  return toToolResult(call);
}

export function registerQueryTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "query",
    {
      title: "Hybrid code-graph search",
      description: [
        "True hybrid retrieval over the indexed code graph: BM25 keyword search",
        "(over symbol name + signature + description) fused with HNSW vector",
        "search (gte-modernbert-base, 768-dim) via Reciprocal Rank Fusion (k=60).",
        "Each result carries `rank`, `nodeId`, `name`, `kind`, `filePath`,",
        "`startLine`/`endLine`, a capped `snippet` (~200 chars), the fused",
        "`score`, and `sources` indicating which ranker(s) contributed (`bm25`",
        "and/or `vector`).",
        "Graceful fallback: when the `embeddings` table is empty, or the ONNX",
        "weights are not installed (run `codehub setup --embeddings` to",
        "install), the vector leg is silently skipped and BM25-only results",
        "are returned with `mode: 'bm25'`. The query never fails because of",
        "missing embeddings.",
        "Use this as the first lookup step when you know the concept but not",
        "the exact symbol. For exact-name lookups, a plain `context` call is",
        "often sufficient.",
      ].join(" "),
      inputSchema: QueryInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      // Zod with `exactOptionalPropertyTypes` emits explicit `undefined`
      // for unset optional properties; `QueryArgs` uses `?:` which forbids
      // an explicit `undefined`. Strip the undefined-valued keys so the
      // two types line up without a structural cast.
      const typed: QueryArgs = {
        query: args.query,
        ...(args.repo !== undefined ? { repo: args.repo } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.kinds !== undefined ? { kinds: args.kinds } : {}),
        ...(args.task_context !== undefined ? { task_context: args.task_context } : {}),
        ...(args.goal !== undefined ? { goal: args.goal } : {}),
        ...(args.include_content !== undefined ? { include_content: args.include_content } : {}),
        ...(args.max_symbols !== undefined ? { max_symbols: args.max_symbols } : {}),
        ...(args.granularity !== undefined ? { granularity: args.granularity } : {}),
        ...(args.mode !== undefined ? { mode: args.mode } : {}),
        ...(args.zoom_fanout !== undefined ? { zoom_fanout: args.zoom_fanout } : {}),
      };
      return fromToolResult(await runQuery(ctx, typed));
    },
  );
}
