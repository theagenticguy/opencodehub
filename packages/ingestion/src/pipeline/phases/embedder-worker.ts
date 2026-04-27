/**
 * Piscina worker entry point for the embeddings phase.
 *
 * Each worker lazy-opens its own OnnxEmbedder on first task and caches it for
 * the lifetime of the worker. Tasks carry a flat list of chunk texts; the
 * worker returns the vectors in input order.
 *
 * Determinism contract: `openOnnxEmbedder()` pins intraOpNumThreads=1,
 * interOpNumThreads=1, and graphOptimizationLevel="disabled" — the same
 * input produces byte-identical output regardless of which worker processed
 * it. Callers partition work deterministically (block-chunked by batch
 * index) so repeat runs reproduce the same byte-level output.
 */

import { workerData } from "node:worker_threads";
import type { Embedder } from "@opencodehub/embedder";
import { openOnnxEmbedder } from "@opencodehub/embedder";

interface WorkerConfig {
  readonly variant: "fp32" | "int8";
  readonly modelDir?: string;
}

export interface EmbedBatchTask {
  readonly texts: readonly string[];
}

export interface EmbedBatchResult {
  /**
   * Flat binary payload of `texts.length * dim` float32 values, laid out as
   * `[vec0, vec1, ...]`. Shipping a single ArrayBuffer avoids the per-vector
   * structured-clone overhead when batches are large.
   */
  readonly buffer: ArrayBuffer;
  readonly dim: number;
  readonly count: number;
}

const cfg = (workerData as WorkerConfig | undefined) ?? { variant: "fp32" };

let embedderPromise: Promise<Embedder> | undefined;

function getEmbedder(): Promise<Embedder> {
  if (embedderPromise === undefined) {
    const opts: { variant: "fp32" | "int8"; modelDir?: string } = { variant: cfg.variant };
    if (cfg.modelDir !== undefined) opts.modelDir = cfg.modelDir;
    embedderPromise = openOnnxEmbedder(opts);
  }
  return embedderPromise;
}

export default async function embedBatch(task: EmbedBatchTask): Promise<EmbedBatchResult> {
  const embedder = await getEmbedder();
  const vectors = await embedder.embedBatch(task.texts);
  if (vectors.length === 0) {
    return { buffer: new ArrayBuffer(0), dim: embedder.dim, count: 0 };
  }
  const dim = vectors[0]?.length ?? embedder.dim;
  const out = new Float32Array(vectors.length * dim);
  for (let i = 0; i < vectors.length; i++) {
    const vec = vectors[i];
    if (vec === undefined) continue;
    out.set(vec, i * dim);
  }
  return { buffer: out.buffer, dim, count: vectors.length };
}
