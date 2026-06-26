/**
 * Public types for the @opencodehub/embedder package.
 *
 * The embedder turns a piece of text into a deterministic 320-dim Float32Array
 * using the F2LLM-v2-80M ONNX model. Callers in @opencodehub/search and
 * @opencodehub/mcp consume this via the `Embedder` interface; the concrete
 * implementation is opened with `openOnnxEmbedder`.
 */

/**
 * Deterministic text-to-vector embedder. Returned Float32Arrays are
 * byte-identical across repeat calls on the same input — this is the
 * contract the graphHash CI gate relies on.
 */
export interface Embedder {
  /** Output dimension. 320 for F2LLM-v2-80M (the local ONNX backend). */
  readonly dim: number;
  /**
   * Stable model identifier, e.g. `f2llm-v2-80m/fp32`. Used by the storage
   * layer to tag `embeddings.model` so incompatible vectors are never mixed
   * in the same index.
   */
  readonly modelId: string;
  /**
   * Embed a single DOCUMENT (no query prefix). Use {@link embedQuery} for
   * search queries.
   */
  embed(text: string): Promise<Float32Array>;
  /**
   * Embed a single QUERY. For asymmetric models (F2LLM) this applies the
   * model's query instruction prefix; documents are embedded raw via
   * {@link embed}. Symmetric backends may alias this to {@link embed}.
   */
  embedQuery(text: string): Promise<Float32Array>;
  /** Embed a batch of DOCUMENTS. Returned array matches the input order 1:1. */
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
   * Directory containing `model.onnx` (or `model_int8.onnx`) and the two
   * tokenizer JSON files. Defaults to
   * `${CODEHUB_HOME:-~/.codehub}/models/f2llm-v2-80m/${variant}/`.
   */
  readonly modelDir?: string;
  /** Which ONNX weight file to load. Defaults to `fp32`. */
  readonly variant?: "fp32" | "int8";
  /**
   * Max tokens of the user-supplied text, before the EOS token is appended.
   * Defaults to 8191 so the full sequence fits the 8192-token operative cap.
   */
  readonly maxSequenceLength?: number;
  /**
   * Directory containing the onnxruntime-web `.wasm` artifacts
   * (`ort-wasm-simd-threaded.*.wasm`). Sets `ort.env.wasm.wasmPaths`. When
   * omitted, onnxruntime-web resolves its own bundled WASM next to its module
   * entry — correct for a source checkout / plain `node_modules` install. The
   * bundled CLI passes the dir its asset walk-up resolved, because the tsup
   * bundle relocates the module away from its sibling `.wasm` files.
   */
  readonly wasmDir?: string;
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
