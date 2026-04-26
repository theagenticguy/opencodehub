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
import { SCAN_PHASE_NAME, type ScanOutput } from "./scan.js";
import { SUMMARIZE_PHASE_NAME, type SummarizePhaseOutput } from "./summarize.js";

export const EMBEDDER_PHASE_NAME = "embeddings" as const;

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
  let embedder: Embedder;
  try {
    const httpEmbedder = tryOpenHttpEmbedder({ offline: ctx.options.offline === true });
    if (httpEmbedder !== null) {
      embedder = httpEmbedder;
    } else {
      const variant = ctx.options.embeddingsVariant ?? "fp32";
      const cfg: { variant: "fp32" | "int8"; modelDir?: string } = { variant };
      if (ctx.options.embeddingsModelDir !== undefined) {
        cfg.modelDir = ctx.options.embeddingsModelDir;
      }
      embedder = await openOnnxEmbedder(cfg);
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
    let summaryFused = false;
    const byGranularity: Record<EmbeddingGranularity, number> = {
      symbol: 0,
      file: 0,
      community: 0,
    };

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

    // ---- Symbol tier ---------------------------------------------------
    if (tiers.includes("symbol")) {
      const eligible: EmbeddableSymbol[] = [];
      for (const n of ctx.graph.nodes()) {
        if (isEmbeddableSymbol(n)) eligible.push(n);
      }
      eligible.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

      for (const node of eligible) {
        const summary = summaryByNode.get(node.id);
        // Summary-fused path reads the symbol body from disk when
        // startLine/endLine are present; missing → fall through to
        // signature/description text.
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
        const vectors = await embedder.embedBatch(chunks);
        for (let i = 0; i < vectors.length; i++) {
          const vec = vectors[i];
          const chunkText = chunks[i];
          if (vec === undefined || chunkText === undefined) continue;
          const row: EmbeddingRow = {
            nodeId: node.id,
            granularity: "symbol",
            chunkIndex: i,
            ...(node.startLine !== undefined ? { startLine: node.startLine } : {}),
            ...(node.endLine !== undefined ? { endLine: node.endLine } : {}),
            vector: vec,
            contentHash: hashText("symbol", chunkText),
          };
          rows.push(row);
          byGranularity["symbol"] = (byGranularity["symbol"] ?? 0) + 1;
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
      // Sort scan files so the embedding order is stable across runs.
      const scanFiles = scan ? [...scan.files] : [];
      scanFiles.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

      for (const f of scanFiles) {
        const ext = path.extname(f.relPath).toLowerCase();
        if (!EMBEDDABLE_FILE_EXTS.has(ext)) continue;
        const fileNode = fileNodeByPath.get(f.relPath);
        if (fileNode === undefined) continue; // node emission may have skipped it
        const raw = readFileWhole(ctx.repoPath, f.relPath);
        if (raw === undefined || raw.length === 0) {
          skipped += 1;
          continue;
        }
        const truncated = raw.length > FILE_CHAR_CAP ? raw.slice(0, FILE_CHAR_CAP) : raw;
        // Single chunk per file at v1.1 (spec: EMB-E-002). If the
        // truncated text still overflows the embedder's token budget
        // the chunker will split it; we keep only the first chunk so
        // one file always maps to one file-tier row.
        const chunks = splitIntoChunks(truncated, maxUserTokens);
        const firstChunk = chunks[0];
        if (firstChunk === undefined) {
          skipped += 1;
          continue;
        }
        chunksTotal += 1;
        const vectors = await embedder.embedBatch([firstChunk]);
        const vec = vectors[0];
        if (vec === undefined) continue;
        rows.push({
          nodeId: fileNode.id,
          granularity: "file",
          chunkIndex: 0,
          vector: vec,
          contentHash: hashText("file", firstChunk),
        });
        byGranularity["file"] = (byGranularity["file"] ?? 0) + 1;
      }
    }

    // ---- Community tier -----------------------------------------------
    if (tiers.includes("community")) {
      // Community nodes carry `inferredLabel` + `keywords`. Walk MEMBER_OF
      // edges (confidence 1.0, emitted by the communities phase) to
      // enumerate the top symbols by name; the label text is
      // `inferredLabel\nkeyword1 keyword2 …\ntopSymbol1 topSymbol2 …`.
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
        // Sort members for determinism; take the first 10 names for the
        // label (alphabetical — the community id itself is canonicalised
        // by the lexicographically-smallest member, so this keeps the
        // signal shape intact without leaking graph traversal order).
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
        const vectors = await embedder.embedBatch([firstChunk]);
        const vec = vectors[0];
        if (vec === undefined) continue;
        rows.push({
          nodeId: c.id,
          granularity: "community",
          chunkIndex: 0,
          vector: vec,
          contentHash: hashText("community", firstChunk),
        });
        byGranularity["community"] = (byGranularity["community"] ?? 0) + 1;
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
