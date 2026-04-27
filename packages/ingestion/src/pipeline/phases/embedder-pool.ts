/**
 * Worker-pool `Embedder` facade.
 *
 * Wraps a Piscina pool of OnnxEmbedder workers behind the same
 * `{ embed, embedBatch, close }` surface the embeddings phase already
 * consumes. Each worker holds its own OnnxEmbedder; tasks are partitioned
 * by batch index so repeat runs visit the same work → same worker
 * assignment for a fixed pool size, preserving byte-identical output.
 *
 * Determinism note: the underlying ONNX session pins all thread counts to 1
 * and disables graph optimization, so a given input text produces the same
 * vector regardless of *which* worker computes it. The ordering guarantee
 * here is belt-and-braces: we reassemble results in input order before
 * returning.
 */

import { fileURLToPath } from "node:url";
import type { Embedder } from "@opencodehub/embedder";
import { embedderModelId } from "@opencodehub/embedder";
import { Piscina } from "piscina";

import type { EmbedBatchResult, EmbedBatchTask } from "./embedder-worker.js";

const WORKER_FILENAME = fileURLToPath(new URL("./embedder-worker.js", import.meta.url));

export interface EmbedderPoolOptions {
  readonly workers: number;
  readonly variant: "fp32" | "int8";
  readonly modelDir?: string;
}

/**
 * Open a worker-pool-backed embedder. Caller must invoke `close()` when
 * done; that tears the pool down.
 *
 * The pool is sized with `minThreads === maxThreads === workers` so worker
 * allocation is stable across a run. Workers lazy-load their OnnxEmbedder
 * on first task, so pool construction itself is cheap.
 */
export function openOnnxEmbedderPool(opts: EmbedderPoolOptions): Embedder {
  const workerData: { variant: "fp32" | "int8"; modelDir?: string } = {
    variant: opts.variant,
  };
  if (opts.modelDir !== undefined) workerData.modelDir = opts.modelDir;

  const pool = new Piscina<EmbedBatchTask, EmbedBatchResult>({
    filename: WORKER_FILENAME,
    minThreads: opts.workers,
    maxThreads: opts.workers,
    // Each worker owns an ~300 MB ONNX session; don't recycle on idle.
    idleTimeout: Number.POSITIVE_INFINITY,
    workerData,
  });

  let closed = false;
  const dim = 768; // gte-modernbert-base — matches OnnxEmbedder's EMBED_DIM.

  async function embedBatch(texts: readonly string[]): Promise<readonly Float32Array[]> {
    if (closed) throw new Error("Embedder pool is closed");
    if (texts.length === 0) return [];
    const result = await pool.run({ texts: [...texts] });
    if (result.count === 0) return [];
    const flat = new Float32Array(result.buffer);
    const out: Float32Array[] = [];
    for (let i = 0; i < result.count; i++) {
      // Slice copies into a fresh, non-shared Float32Array so callers can
      // hang onto each vector independently of the transport buffer.
      out.push(flat.slice(i * result.dim, (i + 1) * result.dim));
    }
    return out;
  }

  return {
    dim,
    modelId: embedderModelId(opts.variant),
    async embed(text: string): Promise<Float32Array> {
      const [vec] = await embedBatch([text]);
      if (vec === undefined) throw new Error("embedBatch returned empty result");
      return vec;
    },
    embedBatch,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await pool.destroy();
    },
  };
}
