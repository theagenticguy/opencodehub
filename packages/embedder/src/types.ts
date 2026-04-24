/**
 * Public types for the @opencodehub/embedder package.
 *
 * The embedder turns a piece of text into a deterministic 384-dim Float32Array
 * using the Arctic Embed XS ONNX model. Callers in @opencodehub/search and
 * @opencodehub/mcp consume this via the `Embedder` interface; the concrete
 * implementation is opened with `openOnnxEmbedder`.
 */

/**
 * Deterministic text-to-vector embedder. Returned Float32Arrays are
 * byte-identical across repeat calls on the same input — this is the
 * contract the graphHash CI gate relies on.
 */
export interface Embedder {
  /** Output dimension. Always 384 for Arctic Embed XS. */
  readonly dim: number;
  /**
   * Stable model identifier, e.g. `snowflake-arctic-embed-xs/fp32`. Used by
   * the storage layer to tag `embeddings.model` so incompatible vectors are
   * never mixed in the same HNSW index.
   */
  readonly modelId: string;
  /** Embed a single text. */
  embed(text: string): Promise<Float32Array>;
  /** Embed a batch of texts. Returned array matches the input order 1:1. */
  embedBatch(texts: readonly string[]): Promise<readonly Float32Array[]>;
  /** Release native session + tokenizer resources. Idempotent. */
  close(): Promise<void>;
}

/**
 * Configuration for {@link openOnnxEmbedder}.
 *
 * Every field is optional; defaults match the v1.0 acceptance gate.
 */
export interface EmbedderConfig {
  /**
   * Directory containing `model.onnx` (or `model_int8.onnx`) and the four
   * tokenizer JSON files. Defaults to
   * `${CODEHUB_HOME:-~/.codehub}/models/arctic-embed-xs/${variant}/`.
   */
  readonly modelDir?: string;
  /** Which ONNX weight file to load. Defaults to `fp32`. */
  readonly variant?: "fp32" | "int8";
  /**
   * Max tokens of the user-supplied text, before `[CLS]`/`[SEP]` are added.
   * Defaults to 510 so the full sequence fits in the model's 512-token
   * position embedding table.
   */
  readonly maxSequenceLength?: number;
  /** L2-normalize the output vector. Defaults to `true`. */
  readonly normalize?: boolean;
}

/**
 * Thrown by {@link openOnnxEmbedder} when the model files are missing from
 * {@link EmbedderConfig.modelDir}. The CLI surfaces this as `codehub setup
 * --embeddings` guidance; tests check `error.code === "EMBEDDER_NOT_SETUP"`
 * to skip determinism assertions when weights are not installed.
 */
export class EmbedderNotSetupError extends Error {
  readonly code = "EMBEDDER_NOT_SETUP" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EmbedderNotSetupError";
  }
}
