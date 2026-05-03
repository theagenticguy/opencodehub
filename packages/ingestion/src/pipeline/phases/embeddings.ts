/**
 * Embeddings phase — generates 768-dim vectors across one or more
 * hierarchical tiers and materialises them into the phase output as an
 * array of `EmbeddingRow`s the CLI upserts into DuckDB.
 *
 * Granularity tiers (P03):
 *   - `"symbol"` — one vector per callable/declaration symbol. When a
 *     `SymbolSummaryRow` exists for the node the text is fused
 *     `signature\nsummary\nbody`; otherwise we fall back to the raw
 *     signature/description pair.
 *   - `"file"` — one vector per scanned file. Coarse tier used by the
 *     `--zoom` retrieval path. Files larger than ~8192 tokens are
 *     truncated to the first `N` chars so a single outlier never blows
 *     up batch latency.
 *   - `"community"` — one vector per Community node. Architectural tier
 *     used to answer "which subsystem handles X?" queries. Text is
 *     `inferredLabel\nkeywords…\ntop_symbols…`.
 *
 * Contract:
 *   - `options.embeddings !== true` → phase is a silent no-op.
 *   - Weights missing (EMBEDDER_NOT_SETUP) → emit a warning via the
 *     progress callback and return zeroes. NEVER aborts the pipeline.
 *   - Default `granularity = ["symbol"]` preserves v1.0 behaviour; callers
 *     opt in to hierarchical tiers explicitly.
 *
 * Determinism:
 *   - Rows are sorted by (granularity, node_id, chunk_index).
 *     `embeddingsHash` hashes the canonical representation so downstream
 *     callers can assert byte-level stability across runs. The hash is
 *     returned in the phase output but is intentionally not folded into
 *     graphHash.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  type Embedder,
  EmbedderNotSetupError,
  openOnnxEmbedder,
  tryOpenHttpEmbedder,
} from "@opencodehub/embedder";
import type { EmbeddingGranularity, EmbeddingRow } from "@opencodehub/storage";

import type { PipelineContext, PipelinePhase } from "../types.js";
import { ANNOTATE_PHASE_NAME } from "./annotate.js";
import { COMMUNITIES_PHASE_NAME } from "./communities.js";
import { openOnnxEmbedderPool } from "./embedder-pool.js";
import { SCAN_PHASE_NAME, type ScanOutput } from "./scan.js";
import { SUMMARIZE_PHASE_NAME, type SummarizePhaseOutput } from "./summarize.js";

/**
 * Default batch size for cross-node inference. Picked so a single batch
 * fully utilizes one ONNX session without blowing host memory on a typical
 * M-series / Linux laptop: 32 symbols × ~500 tokens × 2 (int64 id+mask) is
 * comfortably under 1 MB of tensor feed, and the quadratic attention cost
 * is dominated by the per-chunk cost rather than the batch dimension.
 * Callers can override via `options.embeddingsBatchSize`.
 */
const DEFAULT_EMBEDDING_BATCH_SIZE = 32;

export const EMBEDDER_PHASE_NAME = "embeddings" as const;

/**
 * Options-bag extension point used by {@link runEmbeddings} to read prior
 * `content_hash` values for the `embeddings` table. Plugged onto
 * `ctx.options` by the orchestrator under this well-known key so the phase
 * stays pure (no direct {@link IGraphStore} handle).
 *
 * When absent (or when `options.force === true`), the phase behaves as it
 * did pre-M1-3: every eligible chunk is embedded and emitted. When present
 * and `force !== true`, the adapter is invoked once per run; its returned
 * map is probed per chunk so unchanged chunks skip both `embedder.embed()`
 * and the upsert batch.
 */
export interface EmbeddingHashCacheAdapter {
  /**
   * Return every prior `content_hash` keyed by
   * `${granularity}\0${nodeId}\0${chunkIndex}`. Empty map on a fresh
   * database or any error the adapter wants to degrade gracefully.
   */
  list(): Promise<Map<string, string>>;
}

/**
 * Well-known options key the orchestrator uses to attach an
 * {@link EmbeddingHashCacheAdapter}. Kept as a `const` so callers can't
 * typo the probe site. Matches the pattern used by `SUMMARY_CACHE_OPTIONS_KEY`
 * in the summarize phase.
 */
export const EMBEDDING_HASH_CACHE_OPTIONS_KEY = "__embeddingHashCache" as const;

function resolveEmbeddingHashCacheAdapter(
  ctx: PipelineContext,
): EmbeddingHashCacheAdapter | undefined {
  const opts = ctx.options as unknown as Record<string, unknown>;
  const cache = opts[EMBEDDING_HASH_CACHE_OPTIONS_KEY];
  if (cache === undefined || cache === null || typeof cache !== "object") return undefined;
  const adapter = cache as EmbeddingHashCacheAdapter;
  if (typeof adapter.list !== "function") return undefined;
  return adapter;
}

/**
 * Compose the composite key used to probe {@link EmbeddingHashCacheAdapter}.
 * `\0` is binary-safe vs `:` which appears inside NodeIds; the same key
 * encoding is used by the storage adapter's `listEmbeddingHashes`.
 */
function priorHashKey(
  granularity: EmbeddingGranularity,
  nodeId: string,
  chunkIndex: number,
): string {
  return `${granularity}\0${nodeId}\0${chunkIndex}`;
}

/** Node kinds we currently embed at the symbol tier. */
const EMBEDDABLE_KINDS: ReadonlySet<string> = new Set([
  "Function",
  "Method",
  "Constructor",
  "Route",
  "Tool",
  "Class",
  "Interface",
]);

/**
 * Max body chars to fuse into a summary-fused symbol embedding. Keeps the
 * fused text well under the embedder's ~500-token window even after
 * signature + summary join. The chunker downstream still wraps any
 * overflow, so this cap is a belt-and-braces guard.
 */
const SYMBOL_BODY_CHAR_CAP = 1200;

/**
 * File-level truncation cap. 8192 tokens × ~4 chars/token on code
 * (conservative WordPiece approximation) ≈ 32_768 chars. Rarely hit in
 * practice because most source files are well under this size; outliers
 * (generated code, lockfiles) are truncated to the first chunk so the
 * phase stays responsive.
 */
const FILE_CHAR_CAP = 8192 * 4;

/**
 * File extensions that contribute to file-tier embeddings. Picked to
 * mirror `scan.detectLanguage`'s reliably-parseable set so we don't try
 * to embed binary assets or vendored artifacts. The gate is
 * deliberately conservative — the file tier is a retrieval aid, not a
 * completeness guarantee.
 */
const EMBEDDABLE_FILE_EXTS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".cs",
  ".swift",
  ".md",
  ".mdx",
]);

export interface EmbedderPhaseOptions {
  /**
   * Which granularity tiers to emit (P03). Defaults to `["symbol"]` so
   * existing callers (v1.0 default) see no behavior change.
   */
  readonly granularity?: readonly EmbeddingGranularity[];
}

/** Shape of the `embeddings` phase output. */
export interface EmbedderPhaseOutput {
  /** Number of embeddings appended to the output `rows` array. */
  readonly embeddingsInserted: number;
  /** Symbols of an eligible kind that were skipped (no signature/name pair). */
  readonly symbolsSkipped: number;
  /** Total chunks emitted across all symbols (always >= embeddingsInserted). */
  readonly chunksTotal: number;
  /**
   * Stable id tag for the embedder that produced these rows — e.g.
   * `gte-modernbert-base/fp32`. Empty string when the phase was a
   * no-op (flag off or weights missing).
   */
  readonly embeddingsModelId: string;
  /**
   * Content-addressable hash of the canonicalised rows. Used for acceptance
   * and snapshot tests; NOT folded into graphHash.
   */
  readonly embeddingsHash: string;
  /** Rows the CLI forwards to `store.upsertEmbeddings(...)`. */
  readonly rows: readonly EmbeddingRow[];
  /** `true` when the phase ran against a real embedder, `false` otherwise. */
  readonly ranEmbedder: boolean;
  /**
   * Per-tier emit counts. Callers use this to surface "emitted 421
   * symbol, 38 file, 7 community embeddings" in the analyze summary.
   * Absent tiers are reported as `0` so consumers can iterate without
   * null-checks.
   */
  readonly byGranularity: Readonly<Record<EmbeddingGranularity, number>>;
  /**
   * Whether the symbol tier fused `signature + summary + body` for at
   * least one row. Diagnostic flag consumers can surface — summaries
   * drive the biggest quality lift, so CLI output calls it out when it
   * actually kicked in.
   */
  readonly summaryFused: boolean;
  /**
   * Chunks short-circuited by the content-hash skip (T-M1-3). Counts
   * chunks whose `(granularity, node_id, chunk_index)` had a prior row
   * with identical `content_hash` in the store — so the phase neither
   * embedded them nor emitted a row. `0` when `options.force === true`,
   * when the hash-cache adapter is absent, or on a fresh database.
   */
  readonly chunksSkipped: number;
}

function emptyOutput(): EmbedderPhaseOutput {
  return {
    embeddingsInserted: 0,
    symbolsSkipped: 0,
    chunksTotal: 0,
    embeddingsModelId: "",
    embeddingsHash: hashRows([]),
    rows: [],
    ranEmbedder: false,
    byGranularity: { symbol: 0, file: 0, community: 0 },
    summaryFused: false,
    chunksSkipped: 0,
  };
}

/**
 * Fuse text for the symbol tier. When a summary is present the layout is
 * `signature\nsummary\nbody`; otherwise we fall back to
 * `signature\ndescription`. Body is length-capped so a long function's
 * source never overwhelms the 500-token embedder window even before the
 * chunker runs.
 */
function symbolText(
  node: {
    readonly name: string;
    readonly signature?: string;
    readonly description?: string;
  },
  summary: { readonly summaryText: string; readonly signatureSummary?: string } | undefined,
  body: string | undefined,
): string {
  const head =
    node.signature !== undefined && node.signature.length > 0 ? node.signature : node.name;
  if (summary !== undefined) {
    const sigLine =
      summary.signatureSummary !== undefined && summary.signatureSummary.length > 0
        ? summary.signatureSummary
        : head;
    const bodyPiece =
      body !== undefined && body.length > 0
        ? body.length > SYMBOL_BODY_CHAR_CAP
          ? body.slice(0, SYMBOL_BODY_CHAR_CAP)
          : body
        : "";
    const parts: string[] = [sigLine, summary.summaryText];
    if (bodyPiece.length > 0) parts.push(bodyPiece);
    return parts.join("\n");
  }
  const tail = node.description ?? "";
  return tail.length > 0 ? `${head}\n${tail}` : head;
}

/**
 * Greedy text splitter used when a single input exceeds the embedder's
 * maxTokens budget. We split on line boundaries first, and fall back to
 * fixed-width character slices when a single line is too long.
 *
 * Token budget is approximated as `maxChars = tokens * 4` (conservative
 * for WordPiece, which produces ~4 chars/token on English code).
 */
function splitIntoChunks(text: string, tokens: number): readonly string[] {
  const maxChars = Math.max(tokens * 4, 64);
  if (text.length <= maxChars) {
    return [text];
  }
  const lines = text.split("\n");
  const chunks: string[] = [];
  let buf = "";
  for (const line of lines) {
    if (line.length > maxChars) {
      // Flush whatever we had.
      if (buf.length > 0) {
        chunks.push(buf);
        buf = "";
      }
      // Fixed-width slice.
      for (let i = 0; i < line.length; i += maxChars) {
        chunks.push(line.slice(i, i + maxChars));
      }
      continue;
    }
    if (buf.length + line.length + 1 > maxChars) {
      chunks.push(buf);
      buf = line;
    } else {
      buf = buf.length > 0 ? `${buf}\n${line}` : line;
    }
  }
  if (buf.length > 0) {
    chunks.push(buf);
  }
  return chunks;
}

/**
 * Hash a canonical representation of the rows. Rows are sorted by
 * (granularity, node_id, chunk_index); each row is serialised as
 * `<granularity>\0<id>\0<chunk>\0<hex(vector bytes)>\0<content_hash>`.
 * This representation is byte-stable across machines and TypeScript
 * engines.
 */
function hashRows(rows: readonly EmbeddingRow[]): string {
  const hasher = createHash("sha256");
  const sorted = [...rows].sort((a, b) => {
    const ga = a.granularity ?? "symbol";
    const gb = b.granularity ?? "symbol";
    if (ga !== gb) return ga < gb ? -1 : 1;
    if (a.nodeId === b.nodeId) return a.chunkIndex - b.chunkIndex;
    return a.nodeId < b.nodeId ? -1 : 1;
  });
  for (const r of sorted) {
    hasher.update(r.granularity ?? "symbol", "utf8");
    hasher.update("\0");
    hasher.update(r.nodeId, "utf8");
    hasher.update("\0");
    hasher.update(String(r.chunkIndex));
    hasher.update("\0");
    // Vector bytes — endianness is stable across every platform we ship to
    // (little-endian on x86_64 + aarch64). Copy into a fresh Uint8Array so
    // we never leak Float32Array's ArrayBufferLike widening into crypto.
    const vecBytes = new Uint8Array(
      r.vector.buffer.slice(r.vector.byteOffset, r.vector.byteOffset + r.vector.byteLength),
    );
    hasher.update(vecBytes);
    hasher.update("\0");
    hasher.update(r.contentHash, "utf8");
    hasher.update("\0");
  }
  return hasher.digest("hex");
}

/**
 * Content hash = sha256 of `<granularity>\0<sourceText>`. Threading the
 * tier into the hash prevents collisions when the same node is embedded
 * at multiple granularities (very unlikely in practice, but keeps the
 * cache-key space clean when a future tier reuses the same underlying
 * content).
 */
function hashText(granularity: EmbeddingGranularity, text: string): string {
  const hasher = createHash("sha256");
  hasher.update(granularity, "utf8");
  hasher.update("\0");
  hasher.update(text, "utf8");
  return hasher.digest("hex");
}

interface EmbeddableSymbol {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly signature?: string;
  readonly description?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly filePath: string;
  readonly contentHash?: string;
}

function isEmbeddableSymbol(node: unknown): node is EmbeddableSymbol {
  if (typeof node !== "object" || node === null) return false;
  const n = node as Record<string, unknown>;
  return (
    typeof n["id"] === "string" &&
    typeof n["name"] === "string" &&
    typeof n["kind"] === "string" &&
    typeof n["filePath"] === "string" &&
    EMBEDDABLE_KINDS.has(n["kind"] as string)
  );
}

interface EmbeddableFile {
  readonly id: string;
  readonly name: string;
  readonly filePath: string;
}

function isFileNode(node: unknown): node is EmbeddableFile {
  if (typeof node !== "object" || node === null) return false;
  const n = node as Record<string, unknown>;
  return (
    typeof n["id"] === "string" &&
    n["kind"] === "File" &&
    typeof n["filePath"] === "string" &&
    typeof n["name"] === "string"
  );
}

interface EmbeddableCommunity {
  readonly id: string;
  readonly name: string;
  readonly inferredLabel?: string;
  readonly keywords?: readonly string[];
}

function isCommunityNode(node: unknown): node is EmbeddableCommunity {
  if (typeof node !== "object" || node === null) return false;
  const n = node as Record<string, unknown>;
  return typeof n["id"] === "string" && n["kind"] === "Community" && typeof n["name"] === "string";
}

/**
 * Normalize the requested tier list. De-dupe while preserving first-seen
 * order so the phase walks tiers in a predictable sequence
 * (symbol → file → community) regardless of how the caller supplied them.
 */
function normalizeGranularities(
  requested: readonly EmbeddingGranularity[] | undefined,
): readonly EmbeddingGranularity[] {
  if (requested === undefined || requested.length === 0) return ["symbol"];
  const seen = new Set<EmbeddingGranularity>();
  const out: EmbeddingGranularity[] = [];
  for (const g of requested) {
    if (seen.has(g)) continue;
    seen.add(g);
    out.push(g);
  }
  return out;
}

/**
 * Read a line-bounded slice of a source file. Returns `undefined` on any
 * error so the embedder never aborts because of a permission/missing
 * file condition. Tests patch readFileSync via module state; the fallback
 * is `fs.readFileSync`.
 */
function readSourceSpan(
  repoPath: string,
  filePath: string,
  startLine: number,
  endLine: number,
): string | undefined {
  try {
    const abs = path.isAbsolute(filePath) ? filePath : path.join(repoPath, filePath);
    const all = readFileSync(abs, "utf-8");
    const lines = all.split(/\r?\n/);
    const from = Math.max(0, startLine - 1);
    const to = Math.min(lines.length, endLine);
    if (to <= from) return undefined;
    return lines.slice(from, to).join("\n");
  } catch {
    return undefined;
  }
}

function readFileWhole(repoPath: string, relPath: string): string | undefined {
  try {
    const abs = path.isAbsolute(relPath) ? relPath : path.join(repoPath, relPath);
    return readFileSync(abs, "utf-8");
  } catch {
    return undefined;
  }
}

async function runEmbeddings(ctx: PipelineContext): Promise<EmbedderPhaseOutput> {
  // 1. Flag gate. Silent no-op when disabled.
  if (ctx.options.embeddings !== true) {
    return emptyOutput();
  }

  const tiers = normalizeGranularities(
    (ctx.options as { readonly embeddingsGranularity?: readonly EmbeddingGranularity[] })
      .embeddingsGranularity,
  );

  // 2. Open embedder. Priority:
  //   a. If CODEHUB_EMBEDDING_URL + CODEHUB_EMBEDDING_MODEL are set AND
  //      offline is not in effect, use the HTTP embedder — no ONNX weights
  //      needed, dimension is enforced against the remote response.
  //   b. Otherwise fall back to the local ONNX path. Missing weights is a
  //      graceful degradation (warn + empty output); any other ONNX open
  //      error is re-raised.
  //
  // The offline invariant is non-negotiable: when `offline === true`, the
  // HTTP path is REFUSED even if the env vars are set — `tryOpenHttpEmbedder`
  // throws, and we rethrow rather than silently continuing to ONNX.
  // `embeddingsWorkers` controls the ONNX worker-pool size. `undefined` or
  // `<= 1` preserves the legacy in-process embedder (no pool, no worker
  // overhead). Values >= 2 spin up a Piscina pool whose workers each hold
  // their own OnnxEmbedder. The HTTP backend ignores the flag — its
  // parallelism is driven by the remote server's capacity.
  const workers = Math.max(1, Math.floor(ctx.options.embeddingsWorkers ?? 1));
  const batchSize = Math.max(
    1,
    Math.floor(ctx.options.embeddingsBatchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE),
  );

  let embedder: Embedder;
  try {
    const httpEmbedder = await tryOpenHttpEmbedder({ offline: ctx.options.offline === true });
    if (httpEmbedder !== null) {
      embedder = httpEmbedder;
    } else {
      const variant = ctx.options.embeddingsVariant ?? "fp32";
      const cfg: { variant: "fp32" | "int8"; modelDir?: string } = { variant };
      if (ctx.options.embeddingsModelDir !== undefined) {
        cfg.modelDir = ctx.options.embeddingsModelDir;
      }
      if (workers > 1) {
        // Weight canary: open (and immediately close) a main-thread
        // OnnxEmbedder so EmbedderNotSetupError surfaces with its class
        // identity preserved. Piscina's structured-clone transport would
        // strip the prototype chain from a worker-raised error, breaking
        // the `instanceof EmbedderNotSetupError` catch below.
        const canary = await openOnnxEmbedder(cfg);
        await canary.close();
        embedder = openOnnxEmbedderPool({ workers, ...cfg });
      } else {
        embedder = await openOnnxEmbedder(cfg);
      }
    }
  } catch (err) {
    if (err instanceof EmbedderNotSetupError) {
      ctx.onProgress?.({
        phase: EMBEDDER_PHASE_NAME,
        kind: "warn",
        message:
          "embeddings phase skipped: weights not installed. " +
          "Run `codehub setup --embeddings` while online, or set " +
          "CODEHUB_EMBEDDING_URL to use a remote OpenAI-compatible endpoint.",
      });
      return emptyOutput();
    }
    throw err;
  }

  try {
    const rows: EmbeddingRow[] = [];
    let skipped = 0;
    let chunksTotal = 0;
    let chunksSkipped = 0;
    let summaryFused = false;
    const byGranularity: Record<EmbeddingGranularity, number> = {
      symbol: 0,
      file: 0,
      community: 0,
    };

    // Prior-hash cache (T-M1-3). When the CLI plugs an adapter AND the caller
    // did not pass `force: true`, we load every prior `content_hash` from the
    // `embeddings` table in a single round-trip. Chunks whose
    // `(granularity, nodeId, chunkIndex)` key maps to an identical freshly-
    // computed hash skip both `embedder.embed()` and the upsert batch —
    // unchanged source reduces a full re-analyze to a no-op for the
    // embeddings phase. Under `force`, or with no adapter installed, the map
    // is empty and the phase behaves exactly as it did pre-M1-3.
    const forceFlag = ctx.options.force === true;
    const hashCache = resolveEmbeddingHashCacheAdapter(ctx);
    const priorHashes: Map<string, string> =
      forceFlag || hashCache === undefined ? new Map() : await hashCache.list();

    // Max tokens includes [CLS]/[SEP]; the embedder caps input at 510 user
    // tokens by default. Keep the chunker slightly conservative.
    const maxUserTokens = 500;

    // Lookup summaries by nodeId (the newest `createdAt` wins when multiple
    // prompt versions coexist). Summaries live in the `summarize` phase's
    // output; absent phase / disabled flag → empty map, which simply means
    // raw-body fallback.
    const summarizeOut = ctx.phaseOutputs.get(SUMMARIZE_PHASE_NAME) as
      | SummarizePhaseOutput
      | undefined;
    const summaryByNode = new Map<
      string,
      { readonly summaryText: string; readonly signatureSummary?: string }
    >();
    if (summarizeOut !== undefined && summarizeOut.rows.length > 0) {
      for (const s of summarizeOut.rows) {
        const entry: { summaryText: string; signatureSummary?: string } = {
          summaryText: s.summaryText,
        };
        if (s.signatureSummary !== undefined) entry.signatureSummary = s.signatureSummary;
        summaryByNode.set(s.nodeId, entry);
      }
    }

    // Job-collection phase. Walk all requested tiers in canonical order
    // (symbol → file → community) and accumulate one `EmbedJob` per chunk
    // we'd like to embed. Each job knows how to emit its row once a
    // vector arrives, keeping the dispatch loop below tier-agnostic.
    //
    // Row assembly order is preserved: the collection step runs tiers in
    // the same sequence as the previous per-tier loops, so `rows[]` ends
    // up identical to the pre-refactor layout modulo within-symbol chunk
    // ordering (which is already controlled by `chunkIndex`).
    interface EmbedJob {
      readonly granularity: EmbeddingGranularity;
      readonly text: string;
      readonly emitRow: (vector: Float32Array) => EmbeddingRow;
    }
    const jobs: EmbedJob[] = [];

    // ---- Symbol tier ---------------------------------------------------
    if (tiers.includes("symbol")) {
      const eligible: EmbeddableSymbol[] = [];
      for (const n of ctx.graph.nodes()) {
        if (isEmbeddableSymbol(n)) eligible.push(n);
      }
      eligible.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

      for (const node of eligible) {
        const summary = summaryByNode.get(node.id);
        let body: string | undefined;
        if (
          summary !== undefined &&
          node.startLine !== undefined &&
          node.endLine !== undefined &&
          node.filePath.length > 0
        ) {
          body = readSourceSpan(ctx.repoPath, node.filePath, node.startLine, node.endLine);
        }
        const text = symbolText(node, summary, body);
        if (text.length === 0) {
          skipped += 1;
          continue;
        }
        if (summary !== undefined) summaryFused = true;
        const chunks = splitIntoChunks(text, maxUserTokens);
        if (chunks.length === 0) {
          skipped += 1;
          continue;
        }
        chunksTotal += chunks.length;
        // Content-hash skip (T-M1-3). A symbol can emit multiple chunks
        // (long signature+summary+body). We only skip when *every* fresh
        // chunk hash matches its prior row — otherwise one mismatched chunk
        // would leave the tier partially updated with stale neighbours.
        // The anti-goal is explicit: don't try to diff indices; re-embed
        // the whole node at this granularity.
        const freshHashes = chunks.map((ch) => hashText("symbol", ch));
        const allMatch =
          priorHashes.size > 0 &&
          chunks.every((_chunk, i) => {
            const fresh = freshHashes[i];
            if (fresh === undefined) return false;
            return priorHashes.get(priorHashKey("symbol", node.id, i)) === fresh;
          });
        if (allMatch) {
          chunksSkipped += chunks.length;
          continue;
        }
        for (let i = 0; i < chunks.length; i++) {
          const chunkText = chunks[i] ?? "";
          const contentHash = freshHashes[i] ?? hashText("symbol", chunkText);
          const chunkIndex = i;
          jobs.push({
            granularity: "symbol",
            text: chunkText,
            emitRow: (vector) => ({
              nodeId: node.id,
              granularity: "symbol",
              chunkIndex,
              ...(node.startLine !== undefined ? { startLine: node.startLine } : {}),
              ...(node.endLine !== undefined ? { endLine: node.endLine } : {}),
              vector,
              contentHash,
            }),
          });
        }
      }
    }

    // ---- File tier -----------------------------------------------------
    if (tiers.includes("file")) {
      const scan = ctx.phaseOutputs.get(SCAN_PHASE_NAME) as ScanOutput | undefined;
      const fileNodeByPath = new Map<string, EmbeddableFile>();
      for (const n of ctx.graph.nodes()) {
        if (isFileNode(n)) fileNodeByPath.set(n.filePath, n);
      }
      const scanFiles = scan ? [...scan.files] : [];
      scanFiles.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

      for (const f of scanFiles) {
        const ext = path.extname(f.relPath).toLowerCase();
        if (!EMBEDDABLE_FILE_EXTS.has(ext)) continue;
        const fileNode = fileNodeByPath.get(f.relPath);
        if (fileNode === undefined) continue;
        const raw = readFileWhole(ctx.repoPath, f.relPath);
        if (raw === undefined || raw.length === 0) {
          skipped += 1;
          continue;
        }
        const truncated = raw.length > FILE_CHAR_CAP ? raw.slice(0, FILE_CHAR_CAP) : raw;
        const chunks = splitIntoChunks(truncated, maxUserTokens);
        const firstChunk = chunks[0];
        if (firstChunk === undefined) {
          skipped += 1;
          continue;
        }
        chunksTotal += 1;
        // Content-hash skip (T-M1-3). Single-chunk tier — the compare is
        // straightforward: if the prior row's hash equals the fresh hash,
        // bail before queuing work.
        const contentHash = hashText("file", firstChunk);
        if (
          priorHashes.size > 0 &&
          priorHashes.get(priorHashKey("file", fileNode.id, 0)) === contentHash
        ) {
          chunksSkipped += 1;
          continue;
        }
        jobs.push({
          granularity: "file",
          text: firstChunk,
          emitRow: (vector) => ({
            nodeId: fileNode.id,
            granularity: "file",
            chunkIndex: 0,
            vector,
            contentHash,
          }),
        });
      }
    }

    // ---- Community tier -----------------------------------------------
    if (tiers.includes("community")) {
      const membersByCommunity = new Map<string, string[]>();
      const nameById = new Map<string, string>();
      for (const n of ctx.graph.nodes()) {
        const nn = n as { id?: unknown; name?: unknown };
        if (typeof nn.id === "string" && typeof nn.name === "string") {
          nameById.set(nn.id, nn.name);
        }
      }
      for (const e of ctx.graph.edges()) {
        if (e.type !== "MEMBER_OF") continue;
        const to = e.to as string;
        const arr = membersByCommunity.get(to);
        if (arr !== undefined) arr.push(e.from as string);
        else membersByCommunity.set(to, [e.from as string]);
      }

      const communities: EmbeddableCommunity[] = [];
      for (const n of ctx.graph.nodes()) {
        if (isCommunityNode(n)) communities.push(n);
      }
      communities.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

      for (const c of communities) {
        const members = membersByCommunity.get(c.id) ?? [];
        const memberNames = members
          .map((m) => nameById.get(m))
          .filter((x): x is string => x !== undefined)
          .sort();
        const topNames = memberNames.slice(0, 10);
        const label = c.inferredLabel ?? c.name;
        const keywords = (c.keywords ?? []).slice(0, 5).join(" ");
        const parts: string[] = [label];
        if (keywords.length > 0) parts.push(keywords);
        if (topNames.length > 0) parts.push(topNames.join(" "));
        const text = parts.join("\n");
        if (text.length === 0) {
          skipped += 1;
          continue;
        }
        const chunks = splitIntoChunks(text, maxUserTokens);
        const firstChunk = chunks[0];
        if (firstChunk === undefined) {
          skipped += 1;
          continue;
        }
        chunksTotal += 1;
        // Content-hash skip (T-M1-3). Community tier is also single-chunk.
        const contentHash = hashText("community", firstChunk);
        if (
          priorHashes.size > 0 &&
          priorHashes.get(priorHashKey("community", c.id, 0)) === contentHash
        ) {
          chunksSkipped += 1;
          continue;
        }
        jobs.push({
          granularity: "community",
          text: firstChunk,
          emitRow: (vector) => ({
            nodeId: c.id,
            granularity: "community",
            chunkIndex: 0,
            vector,
            contentHash,
          }),
        });
      }
    }

    // ---- Dispatch ------------------------------------------------------
    // Cross-node batching: group jobs into fixed-size batches and embed
    // them as a single `embedBatch()` call. When the embedder is a worker
    // pool, successive batches ride different workers in parallel; when
    // it's an in-process embedder the batching still cuts per-call
    // overhead (tokenizer + tensor feed building amortize across the
    // batch). We fire `workers` batches concurrently so the pool stays
    // saturated — the pool's Piscina queue handles backpressure.
    for (let i = 0; i < jobs.length; i += batchSize * workers) {
      const waveEnd = Math.min(jobs.length, i + batchSize * workers);
      const waveBatches: Promise<readonly Float32Array[]>[] = [];
      const waveJobSlices: EmbedJob[][] = [];
      for (let b = i; b < waveEnd; b += batchSize) {
        const batchEnd = Math.min(waveEnd, b + batchSize);
        const slice = jobs.slice(b, batchEnd);
        waveJobSlices.push(slice);
        waveBatches.push(embedder.embedBatch(slice.map((j) => j.text)));
      }
      const waveResults = await Promise.all(waveBatches);
      for (let w = 0; w < waveResults.length; w++) {
        const vectors = waveResults[w] ?? [];
        const slice = waveJobSlices[w] ?? [];
        for (let k = 0; k < slice.length; k++) {
          const job = slice[k];
          const vec = vectors[k];
          if (job === undefined || vec === undefined) continue;
          rows.push(job.emitRow(vec));
          byGranularity[job.granularity] = (byGranularity[job.granularity] ?? 0) + 1;
        }
      }
    }

    return {
      embeddingsInserted: rows.length,
      symbolsSkipped: skipped,
      chunksTotal,
      embeddingsModelId: embedder.modelId,
      embeddingsHash: hashRows(rows),
      rows,
      ranEmbedder: true,
      byGranularity,
      summaryFused,
      chunksSkipped,
    };
  } finally {
    await embedder.close();
  }
}

export const embeddingsPhase: PipelinePhase<EmbedderPhaseOutput> = {
  name: EMBEDDER_PHASE_NAME,
  // Depend on `summarize` so summary-fused text is available; depend on
  // `communities` so the community tier sees the emitted Community nodes
  // and MEMBER_OF edges; depend on `scan` transitively via `annotate`
  // (annotate → structure → scan) for the file tier.
  deps: [ANNOTATE_PHASE_NAME, SUMMARIZE_PHASE_NAME, COMMUNITIES_PHASE_NAME],
  async run(ctx): Promise<EmbedderPhaseOutput> {
    return runEmbeddings(ctx);
  },
};
