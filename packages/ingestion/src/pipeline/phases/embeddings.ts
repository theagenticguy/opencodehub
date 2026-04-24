/**
 * Embeddings phase — generates 384-dim vectors for every callable or
 * declaration symbol in the graph and materialises them into the phase
 * output as an array of `EmbeddingRow`s the CLI upserts into DuckDB.
 *
 * Contract:
 *   - `options.embeddings !== true` → phase is a no-op. Returns zeroes and
 *     an empty `rows` array. No log, no warning.
 *   - Weights missing (EMBEDDER_NOT_SETUP) → phase emits a warning via the
 *     progress callback and returns zeroes. NEVER aborts the pipeline.
 *   - Weights present → walk all kind-eligible nodes sorted by id for
 *     determinism, build text = `${signature ?? name}\n${description ?? ""}`,
 *     embed, and produce one row per symbol (chunk_index=0 for v1.0; the
 *     split-when-too-long path is a follow-up since text is short).
 *
 * Determinism:
 *   - Rows are sorted by (node_id, chunk_index). `embeddingsHash` hashes a
 *     canonical representation so downstream callers can assert byte-level
 *     stability across runs. This hash is returned in the phase output but
 *     is intentionally not folded into graphHash.
 */

import { createHash } from "node:crypto";

import {
  type Embedder,
  EmbedderNotSetupError,
  openOnnxEmbedder,
  tryOpenHttpEmbedder,
} from "@opencodehub/embedder";
import type { EmbeddingRow } from "@opencodehub/storage";

import type { PipelineContext, PipelinePhase } from "../types.js";
import { ANNOTATE_PHASE_NAME } from "./annotate.js";
import { SUMMARIZE_PHASE_NAME } from "./summarize.js";

export const EMBEDDER_PHASE_NAME = "embeddings" as const;

/** Node kinds we currently embed. Picked to match the v1.0 search surface. */
const EMBEDDABLE_KINDS: ReadonlySet<string> = new Set([
  "Function",
  "Method",
  "Constructor",
  "Route",
  "Tool",
  "Class",
  "Interface",
]);

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
   * `snowflake-arctic-embed-xs/fp32`. Empty string when the phase was a
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
  };
}

/**
 * Build the text to embed for a single node. `signature` is preferred because
 * it conveys the callable shape; we fall back to `name` when signature is
 * missing (e.g. Route / Tool nodes) and always append `description` when
 * available for richer grounding.
 */
function textForNode(node: {
  readonly name: string;
  readonly signature?: string;
  readonly description?: string;
}): string {
  const head =
    node.signature !== undefined && node.signature.length > 0 ? node.signature : node.name;
  const tail = node.description ?? "";
  return tail.length > 0 ? `${head}\n${tail}` : head;
}

/**
 * Greedy text splitter used when a single input exceeds the embedder's
 * maxTokens budget. v1.0 operates on symbol signatures + short descriptions,
 * so the overrun path is rare — we split on line boundaries first, and fall
 * back to fixed-width character slices when a single line is too long.
 *
 * Token budget is approximated as `maxChars = tokens * 4` (conservative for
 * WordPiece, which produces ~4 chars/token on English code).
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
 * (node_id, chunk_index) then each row is serialised as
 * `<id>\0<chunk>\0<hex(vector bytes)>\0<content_hash>`. This representation
 * is byte-stable across machines and TypeScript engines.
 */
function hashRows(rows: readonly EmbeddingRow[]): string {
  const hasher = createHash("sha256");
  const sorted = [...rows].sort((a, b) => {
    if (a.nodeId === b.nodeId) return a.chunkIndex - b.chunkIndex;
    return a.nodeId < b.nodeId ? -1 : 1;
  });
  for (const r of sorted) {
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

/** Content hash = sha256 of the input text — keyed by symbolic content. */
function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

interface EmbeddableNode {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly signature?: string;
  readonly description?: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

function isEmbeddable(node: unknown): node is EmbeddableNode {
  if (typeof node !== "object" || node === null) return false;
  const n = node as Record<string, unknown>;
  return (
    typeof n["id"] === "string" &&
    typeof n["name"] === "string" &&
    typeof n["kind"] === "string" &&
    EMBEDDABLE_KINDS.has(n["kind"] as string)
  );
}

async function runEmbeddings(ctx: PipelineContext): Promise<EmbedderPhaseOutput> {
  // 1. Flag gate. Silent no-op when disabled.
  if (ctx.options.embeddings !== true) {
    return emptyOutput();
  }

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
  // throws, and we rethrow rather than silently continuing to ONNX. A user
  // who explicitly set CODEHUB_EMBEDDING_URL deserves to see the conflict.
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
    // 3. Walk nodes, sorted by id for determinism.
    const eligible: EmbeddableNode[] = [];
    for (const n of ctx.graph.nodes()) {
      if (isEmbeddable(n)) {
        eligible.push(n);
      }
    }
    eligible.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const rows: EmbeddingRow[] = [];
    let skipped = 0;
    let chunksTotal = 0;

    // Max tokens includes [CLS]/[SEP]; the embedder caps input at 510 user
    // tokens by default. Keep the chunker slightly conservative.
    const maxUserTokens = 500;

    for (const node of eligible) {
      const text = textForNode(node);
      if (text.length === 0) {
        skipped += 1;
        continue;
      }
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
          chunkIndex: i,
          ...(node.startLine !== undefined ? { startLine: node.startLine } : {}),
          ...(node.endLine !== undefined ? { endLine: node.endLine } : {}),
          vector: vec,
          contentHash: hashText(chunkText),
        };
        rows.push(row);
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
    };
  } finally {
    await embedder.close();
  }
}

export const embeddingsPhase: PipelinePhase<EmbedderPhaseOutput> = {
  name: EMBEDDER_PHASE_NAME,
  // Depend on `summarize` so the topological order places summaries
  // immediately before embeddings. A future revision of this phase will
  // embed summary text alongside the existing signature/description
  // vectors; even in Session A (summaries gated off) the ordering matters
  // so a downstream enable-flag flip never requires a DAG reshuffle.
  deps: [ANNOTATE_PHASE_NAME, SUMMARIZE_PHASE_NAME],
  async run(ctx): Promise<EmbedderPhaseOutput> {
    return runEmbeddings(ctx);
  },
};
