/**
 * Deterministic ONNX-based embedder for codefuse-ai F2LLM-v2-80M.
 *
 * Loads weights from disk (populated by `codehub setup --embeddings`), runs
 * inference with every nondeterminism knob disabled, and emits a 320-dim
 * Float32Array per input. The same input MUST produce byte-identical output
 * across repeat calls; this is the contract the graphHash CI gate relies
 * on.
 *
 * F2LLM-v2-80M is a Qwen3-0.6B-Base derivative (8 layers, hidden 320, 16
 * heads / 8 KV heads). The ONNX export bakes last-token pooling
 * (`attention_mask.sum()-1`) AND L2 normalization INTO the graph, emitting
 * a single output named `embedding` of shape `[batch, 320]` already
 * unit-length — so this module does NO JS-side pooling or normalization,
 * unlike the previous gte-modernbert (CLS-pool) path.
 *
 * Query/document asymmetry: F2LLM expects an `Instruct:`-wrapped prefix on
 * QUERY text only; documents are embedded raw. {@link OnnxEmbedder.embed}
 * /`embedBatch` embed raw text (the document path); {@link
 * OnnxEmbedder.embedQuery} applies the prefix (the query path). See
 * {@link buildQueryText}.
 *
 * The weights themselves are NOT downloaded here — `codehub setup
 * --embeddings` owns that code path. If the weights are absent we throw
 * {@link EmbedderNotSetupError} so callers can degrade to BM25-only search
 * gracefully.
 */

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Tokenizer } from "@huggingface/tokenizers";
// `onnxruntime-web` ships prebuilt WebAssembly (no native binding, no node-gyp,
// no install step) and runs the ONNX runtime in pure WASM under Node. Import
// only its TYPES at the top level (erased at compile time), and load the actual
// module via a dynamic `import()` inside `openOnnxEmbedder` so a BM25-only
// install never pays the WASM-load cost. The Node path is single-threaded WASM,
// which is exactly the determinism-friendly configuration the graphHash gate
// needs — verified byte-identical across repeat + fresh-session runs.
import type { InferenceSession, Tensor } from "onnxruntime-web";

import { embedderModelId } from "./model-pins.js";
import { modelFileName, resolveModelDir, TOKENIZER_FILES } from "./paths.js";
import { buildQueryText } from "./query-prefix.js";
import { type Embedder, type EmbedderConfig, EmbedderNotSetupError } from "./types.js";

// F2LLM-v2-80M emits a single graph output named `embedding`, shape
// `[batch, 320]`, already L2-normalized. These numbers are part of the
// model contract, not a config knob — do not expose to callers.
const EMBED_DIM = 320;
// Practical truncation cap in tokens. F2LLM's model_max_length is 131072,
// but code symbols are short and a large cap wastes memory/latency; 8192 is
// the operative ceiling.
const MODEL_MAX_LENGTH = 8192;

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function assertModelFiles(
  modelDir: string,
  variant: "fp32" | "int8",
): Promise<{ readonly modelPath: string; readonly tokenizerDir: string }> {
  const modelPath = join(modelDir, modelFileName(variant));
  const missing: string[] = [];
  if (!(await fileExists(modelPath))) {
    missing.push(modelFileName(variant));
  }
  for (const fname of TOKENIZER_FILES) {
    if (!(await fileExists(join(modelDir, fname)))) {
      missing.push(fname);
    }
  }
  if (missing.length > 0) {
    throw new EmbedderNotSetupError(
      `F2LLM-v2-80M weights not found in ${modelDir}: ` +
        `missing ${missing.join(", ")}. ` +
        `Run \`codehub setup --embeddings\` while online.`,
    );
  }
  return { modelPath, tokenizerDir: modelDir };
}

async function loadTokenizer(tokenizerDir: string): Promise<Tokenizer> {
  const [tokenizerJsonRaw, tokenizerConfigRaw] = await Promise.all([
    readFile(join(tokenizerDir, "tokenizer.json"), "utf8"),
    readFile(join(tokenizerDir, "tokenizer_config.json"), "utf8"),
  ]);
  const tokenizerJson: unknown = JSON.parse(tokenizerJsonRaw);
  const tokenizerConfig: unknown = JSON.parse(tokenizerConfigRaw);
  // @huggingface/tokenizers accepts untyped plain-object configs; the library
  // validates shape at runtime. Upcasting to `object` keeps us within the
  // published constructor signature (`tokenizer: Object, config: Object`).
  if (
    typeof tokenizerJson !== "object" ||
    tokenizerJson === null ||
    typeof tokenizerConfig !== "object" ||
    tokenizerConfig === null
  ) {
    throw new Error(`Malformed tokenizer files in ${tokenizerDir}: expected objects`);
  }
  return new Tokenizer(tokenizerJson, tokenizerConfig);
}

function buildSessionOptions(): InferenceSession.SessionOptions {
  return {
    // Graph opts above `disabled` can reorder kernel fusion → float32 sum
    // ordering changes → embeddings drift in the last ~2 decimals. The WASM
    // EP honours this option (verified byte-identical with it set).
    graphOptimizationLevel: "disabled",
    executionMode: "sequential",
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
    // The WASM execution provider — the only EP onnxruntime-web exposes under
    // Node, and single-threaded by construction there (see env.wasm.numThreads
    // in openOnnxEmbedder). That single-threaded WASM kernel path is what makes
    // the embedding output deterministic across runs, sessions, and machines.
    executionProviders: ["wasm"],
  };
}

/**
 * Encode `text` using the supplied Tokenizer and produce padded/truncated
 * input_ids and attention_mask arrays. BigInt64Array matches the model's
 * int64 input type. Qwen3/F2LLM has no token_type_ids input.
 *
 * `add_special_tokens: true` is REQUIRED — the tokenizer's TemplateProcessing
 * appends the EOS (`<|im_end|>`) that the in-graph last-token pooling reads.
 */
function encodeForModel(
  tokenizer: Tokenizer,
  text: string,
  maxModelLength: number,
): {
  readonly inputIds: BigInt64Array;
  readonly attentionMask: BigInt64Array;
  readonly seqLen: number;
} {
  const enc = tokenizer.encode(text, {
    add_special_tokens: true,
  });
  // Truncate to the practical max length. On truncation the trailing EOS is
  // dropped and last-token pooling reads the final retained token — a valid
  // (if degraded) representation of the truncated prefix.
  const ids = enc.ids.slice(0, maxModelLength);
  const mask = enc.attention_mask.slice(0, maxModelLength);

  const seqLen = ids.length;
  const inputIds = new BigInt64Array(seqLen);
  const attentionMask = new BigInt64Array(seqLen);
  for (let i = 0; i < seqLen; i++) {
    inputIds[i] = BigInt(ids[i] ?? 0);
    attentionMask[i] = BigInt(mask[i] ?? 0);
  }
  return { inputIds, attentionMask, seqLen };
}

/**
 * Pad two parallel BigInt64Arrays (ids, mask) up to `padTo`. F2LLM's
 * tokenizer pad_token is `<|endoftext|>` (id 151643); the attention mask is
 * 0 for padding positions so the in-graph last-token pooling
 * (`attention_mask.sum()-1`) skips them regardless of the pad id used.
 */
const F2LLM_PAD_ID = 151643n;

function padToLength(
  ids: BigInt64Array,
  mask: BigInt64Array,
  padTo: number,
): {
  readonly ids: BigInt64Array;
  readonly mask: BigInt64Array;
} {
  if (ids.length === padTo) {
    return { ids, mask };
  }
  const outIds = new BigInt64Array(padTo).fill(F2LLM_PAD_ID);
  const outMask = new BigInt64Array(padTo);
  outIds.set(ids);
  outMask.set(mask);
  return { ids: outIds, mask: outMask };
}

/** Internal implementation — exported only via the {@link Embedder} seam. */
class OnnxEmbedder implements Embedder {
  readonly dim = EMBED_DIM;
  readonly modelId: string;

  readonly #session: InferenceSession;
  readonly #tokenizer: Tokenizer;
  readonly #maxModelLength: number;
  // Runtime `Tensor` constructor, threaded in from the dynamic
  // `import("onnxruntime-web")` so this module never statically loads the
  // native binding.
  readonly #Tensor: typeof Tensor;
  #closed = false;

  constructor(params: {
    readonly session: InferenceSession;
    readonly tokenizer: Tokenizer;
    readonly variant: "fp32" | "int8";
    readonly maxModelLength: number;
    readonly Tensor: typeof Tensor;
  }) {
    this.#session = params.session;
    this.#tokenizer = params.tokenizer;
    this.modelId = embedderModelId(params.variant);
    this.#maxModelLength = params.maxModelLength;
    this.#Tensor = params.Tensor;
  }

  /** Embed a single DOCUMENT (no query prefix). */
  async embed(text: string): Promise<Float32Array> {
    this.#ensureOpen();
    const [vec] = await this.embedBatch([text]);
    if (vec === undefined) {
      throw new Error("embedBatch returned empty result for single input");
    }
    return vec;
  }

  /**
   * Embed a QUERY. F2LLM expects the `Instruct:`-wrapped prefix on query
   * text only; documents (`embed`/`embedBatch`) get none. Keeping this on
   * the embedder localizes the model-specific instruction string and keeps
   * the asymmetry explicit + unit-testable.
   */
  async embedQuery(text: string): Promise<Float32Array> {
    this.#ensureOpen();
    return this.embed(buildQueryText(text));
  }

  async embedBatch(texts: readonly string[]): Promise<readonly Float32Array[]> {
    this.#ensureOpen();
    if (texts.length === 0) {
      return [];
    }

    // Encode all texts; find max seqLen in this batch for padding.
    const encoded = texts.map((t) => encodeForModel(this.#tokenizer, t, this.#maxModelLength));
    let batchMax = 0;
    for (const e of encoded) {
      if (e.seqLen > batchMax) {
        batchMax = e.seqLen;
      }
    }
    if (batchMax === 0) {
      // Degenerate case: every input tokenized to zero tokens. Return zero
      // vectors (still dim=320) so callers downstream get a stable shape.
      return texts.map(() => new Float32Array(EMBED_DIM));
    }

    // Build flat [B, seqLen] buffers.
    const batchSize = encoded.length;
    const flatIds = new BigInt64Array(batchSize * batchMax).fill(F2LLM_PAD_ID);
    const flatMask = new BigInt64Array(batchSize * batchMax);
    for (let b = 0; b < batchSize; b++) {
      const e = encoded[b];
      if (e === undefined) continue;
      const padded = padToLength(e.inputIds, e.attentionMask, batchMax);
      flatIds.set(padded.ids, b * batchMax);
      flatMask.set(padded.mask, b * batchMax);
    }

    const dims: readonly number[] = [batchSize, batchMax];
    const Tensor = this.#Tensor;
    const feeds: Record<string, Tensor> = {
      input_ids: new Tensor("int64", flatIds, dims),
      attention_mask: new Tensor("int64", flatMask, dims),
    };
    // F2LLM's graph pools (last-token) + L2-normalizes internally and emits a
    // single output named `embedding`, shape [B, EMBED_DIM] — already
    // unit-length. We do NO JS-side pooling/normalization here.
    const results = await this.#session.run(feeds, ["embedding"]);
    const embedding = results["embedding"];
    if (embedding === undefined || embedding.type !== "float32") {
      throw new Error(
        `ONNX session did not return a float32 'embedding' tensor (got ${String(embedding?.type)})`,
      );
    }
    // Shape is [B, EMBED_DIM] (NOT [B, seqLen, H]). Derive the per-row width
    // from the flat buffer length and assert it matches EMBED_DIM at the
    // boundary so a wrong model loaded surfaces loudly.
    const data = embedding.data as Float32Array;
    const rowDim = data.length / batchSize;
    if (rowDim !== EMBED_DIM) {
      throw new Error(`Expected embedding dim ${EMBED_DIM}, got ${rowDim}. Wrong model loaded?`);
    }

    const out: Float32Array[] = [];
    for (let b = 0; b < batchSize; b++) {
      // Copy each row out of the shared buffer so callers own an independent
      // Float32Array (the graph already normalized it).
      out.push(data.slice(b * EMBED_DIM, (b + 1) * EMBED_DIM));
    }
    return out;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#session.release();
  }

  #ensureOpen(): void {
    if (this.#closed) {
      throw new Error("Embedder is closed");
    }
  }
}

/**
 * Open a deterministic F2LLM-v2-80M embedder.
 *
 * Throws {@link EmbedderNotSetupError} if the weight files are not present —
 * callers in the CLI use this to surface `codehub setup --embeddings`
 * guidance, and the search layer degrades to BM25-only.
 */
export async function openOnnxEmbedder(cfg: EmbedderConfig = {}): Promise<Embedder> {
  const variant = cfg.variant ?? "fp32";
  const modelDir = resolveModelDir(cfg.modelDir, variant);
  // `maxSequenceLength` is the caller-facing budget in user tokens; the
  // tokenizer appends a single EOS token, so the model input is at most
  // userMax + 1, capped at MODEL_MAX_LENGTH.
  const userMax = cfg.maxSequenceLength ?? MODEL_MAX_LENGTH - 1;
  const maxModelLength = Math.min(userMax + 1, MODEL_MAX_LENGTH);

  const { modelPath, tokenizerDir } = await assertModelFiles(modelDir, variant);

  // Load the WASM runtime lazily. `onnxruntime-web` ships prebuilt WebAssembly
  // — no native binding, no install step — so a BM25-only install simply never
  // imports it. assertModelFiles already passed (weights are present), so
  // reaching here means the user ran `codehub setup --embeddings`; surface a
  // clear error if the module is somehow absent rather than a raw
  // MODULE_NOT_FOUND.
  let ort: typeof import("onnxruntime-web");
  try {
    ort = await import("onnxruntime-web");
  } catch (cause) {
    throw new EmbedderNotSetupError(
      "onnxruntime-web is not installed. It is an optional dependency that " +
        "ships the WASM ONNX runtime; reinstall with onnxruntime-web " +
        "available, or configure a remote embedder (CODEHUB_EMBEDDING_URL / " +
        "CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT) to avoid the local runtime.",
      { cause },
    );
  }

  // Single-threaded WASM is the deterministic path (ORT: "Node.js only support
  // single-threaded wasm EP"). Forcing numThreads=1 also avoids spawning worker
  // threads the headless CLI doesn't want. When the caller resolved a wasmDir
  // (the bundled CLI, whose tsup output is relocated away from the package's
  // sibling .wasm files), point the loader at it; otherwise let onnxruntime-web
  // find its own bundled artifacts next to its module entry.
  ort.env.wasm.numThreads = 1;
  if (cfg.wasmDir !== undefined) {
    // Trailing separator required: ORT concatenates the artifact filename.
    ort.env.wasm.wasmPaths = cfg.wasmDir.endsWith("/") ? cfg.wasmDir : `${cfg.wasmDir}/`;
  }

  const tokenizer = await loadTokenizer(tokenizerDir);
  // onnxruntime-web's InferenceSession.create takes model BYTES (Uint8Array) in
  // Node, not a filesystem path the way onnxruntime-node did.
  const modelBytes = await readFile(modelPath);
  const session = await ort.InferenceSession.create(modelBytes, buildSessionOptions());

  return new OnnxEmbedder({
    session,
    tokenizer,
    variant,
    maxModelLength,
    Tensor: ort.Tensor,
  });
}
