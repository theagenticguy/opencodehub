/**
 * Deterministic ONNX-based embedder for Snowflake Arctic Embed XS.
 *
 * Loads weights from disk (populated by `codehub setup --embeddings`), runs
 * inference with every nondeterminism knob disabled, and emits a 384-dim
 * Float32Array per input. The same input MUST produce byte-identical output
 * across repeat calls; this is the contract the graphHash CI gate relies
 * on.
 *
 * The weights themselves are NOT downloaded here — `codehub setup
 * --embeddings` owns that code path. If the weights are absent we throw
 * {@link EmbedderNotSetupError} so callers can degrade to BM25-only search
 * gracefully.
 */

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Tokenizer } from "@huggingface/tokenizers";
import { InferenceSession, Tensor } from "onnxruntime-node";

import { embedderModelId } from "./model-pins.js";
import { modelFileName, resolveModelDir, TOKENIZER_FILES } from "./paths.js";
import { type Embedder, type EmbedderConfig, EmbedderNotSetupError } from "./types.js";

// Arctic Embed XS is built on MiniLM-L6-H384. These numbers are part of the
// model contract, not a config knob — do not expose to callers.
const EMBED_DIM = 384;
const MODEL_MAX_POSITION = 512; // includes [CLS] + [SEP]

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
      `Arctic Embed XS weights not found in ${modelDir}: ` +
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
    // ordering changes → embeddings drift in the last ~2 decimals.
    graphOptimizationLevel: "disabled",
    executionMode: "sequential",
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
    // Arena allocs can vary in layout and introduce timing jitter that
    // doesn't affect correctness but slows down determinism verification.
    enableCpuMemArena: false,
    // The string-keyed config entry mirrors SetDeterministicCompute() in
    // the ORT C++ API; honours CPU EP kernels with a det-vs-perf branch.
    extra: {
      session: {
        set_deterministic_compute: "1",
      },
    },
    // Force CPU EP only — even if NAPI probes find CoreML, we don't want
    // its nondeterministic MPS kernels participating.
    executionProviders: ["cpu"],
  };
}

/**
 * Encode `text` using the supplied Tokenizer and produce padded/truncated
 * input_ids, attention_mask, and token_type_ids arrays of length
 * `targetLength`. BigInt64Array matches the model's int64 input type.
 */
function encodeForModel(
  tokenizer: Tokenizer,
  text: string,
  maxModelLength: number,
): {
  readonly inputIds: BigInt64Array;
  readonly attentionMask: BigInt64Array;
  readonly tokenTypeIds: BigInt64Array;
  readonly seqLen: number;
} {
  const enc = tokenizer.encode(text, {
    add_special_tokens: true,
    return_token_type_ids: true,
  });
  // Truncate to the model's max_position_embeddings.
  const ids = enc.ids.slice(0, maxModelLength);
  const mask = enc.attention_mask.slice(0, maxModelLength);
  const types = (enc.token_type_ids ?? new Array<number>(ids.length).fill(0)).slice(
    0,
    maxModelLength,
  );

  const seqLen = ids.length;
  const inputIds = new BigInt64Array(seqLen);
  const attentionMask = new BigInt64Array(seqLen);
  const tokenTypeIds = new BigInt64Array(seqLen);
  for (let i = 0; i < seqLen; i++) {
    inputIds[i] = BigInt(ids[i] ?? 0);
    attentionMask[i] = BigInt(mask[i] ?? 0);
    tokenTypeIds[i] = BigInt(types[i] ?? 0);
  }
  return { inputIds, attentionMask, tokenTypeIds, seqLen };
}

/**
 * Pad three parallel BigInt64Arrays (ids, mask, types) up to `padTo` with the
 * BERT convention: id=0 (PAD), mask=0, type=0. Returns fresh arrays so the
 * callers may keep the originals.
 */
function padToLength(
  ids: BigInt64Array,
  mask: BigInt64Array,
  types: BigInt64Array,
  padTo: number,
): {
  readonly ids: BigInt64Array;
  readonly mask: BigInt64Array;
  readonly types: BigInt64Array;
} {
  if (ids.length === padTo) {
    return { ids, mask, types };
  }
  const outIds = new BigInt64Array(padTo);
  const outMask = new BigInt64Array(padTo);
  const outTypes = new BigInt64Array(padTo);
  outIds.set(ids);
  outMask.set(mask);
  outTypes.set(types);
  return { ids: outIds, mask: outMask, types: outTypes };
}

/**
 * Extract the [CLS] vector (index 0 of last_hidden_state) for batch item
 * `rowIdx`. The model is MiniLM-style so sentence-transformers convention
 * (and the Snowflake-published usage notes) call for CLS pooling.
 */
function clsPool(
  lastHidden: Float32Array,
  rowIdx: number,
  seqLen: number,
  hiddenSize: number,
): Float32Array {
  const rowStart = rowIdx * seqLen * hiddenSize;
  const out = new Float32Array(hiddenSize);
  for (let i = 0; i < hiddenSize; i++) {
    out[i] = lastHidden[rowStart + i] ?? 0;
  }
  return out;
}

/**
 * In-place L2 normalization with Kahan-summed squared norm for 2-ULP tighter
 * precision than naive sum. Single division by `sqrt(norm)` keeps the op
 * deterministic across x86_64 + aarch64 (IEEE-754 round-to-nearest-even).
 */
function l2NormalizeInPlace(vec: Float32Array): void {
  let sum = 0;
  let comp = 0; // Kahan compensator
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i] ?? 0;
    const term = v * v - comp;
    const t = sum + term;
    comp = t - sum - term;
    sum = t;
  }
  if (sum <= 0) {
    return;
  }
  const inv = 1 / Math.sqrt(sum);
  for (let i = 0; i < vec.length; i++) {
    vec[i] = (vec[i] ?? 0) * inv;
  }
}

/** Internal implementation — exported only via the {@link Embedder} seam. */
class OnnxEmbedder implements Embedder {
  readonly dim = EMBED_DIM;
  readonly modelId: string;

  readonly #session: InferenceSession;
  readonly #tokenizer: Tokenizer;
  readonly #normalize: boolean;
  readonly #maxModelLength: number;
  #closed = false;

  constructor(params: {
    readonly session: InferenceSession;
    readonly tokenizer: Tokenizer;
    readonly variant: "fp32" | "int8";
    readonly normalize: boolean;
    readonly maxModelLength: number;
  }) {
    this.#session = params.session;
    this.#tokenizer = params.tokenizer;
    this.modelId = embedderModelId(params.variant);
    this.#normalize = params.normalize;
    this.#maxModelLength = params.maxModelLength;
  }

  async embed(text: string): Promise<Float32Array> {
    this.#ensureOpen();
    const [vec] = await this.embedBatch([text]);
    if (vec === undefined) {
      throw new Error("embedBatch returned empty result for single input");
    }
    return vec;
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
      // vectors (still dim=384) so callers downstream get a stable shape.
      return texts.map(() => new Float32Array(EMBED_DIM));
    }

    // Build flat [B, seqLen] buffers.
    const batchSize = encoded.length;
    const flatIds = new BigInt64Array(batchSize * batchMax);
    const flatMask = new BigInt64Array(batchSize * batchMax);
    const flatTypes = new BigInt64Array(batchSize * batchMax);
    for (let b = 0; b < batchSize; b++) {
      const e = encoded[b];
      if (e === undefined) continue;
      const padded = padToLength(e.inputIds, e.attentionMask, e.tokenTypeIds, batchMax);
      flatIds.set(padded.ids, b * batchMax);
      flatMask.set(padded.mask, b * batchMax);
      flatTypes.set(padded.types, b * batchMax);
    }

    const dims: readonly number[] = [batchSize, batchMax];
    const feeds: Record<string, Tensor> = {
      input_ids: new Tensor("int64", flatIds, dims),
      attention_mask: new Tensor("int64", flatMask, dims),
      token_type_ids: new Tensor("int64", flatTypes, dims),
    };
    const results = await this.#session.run(feeds, ["last_hidden_state"]);
    const hidden = results["last_hidden_state"];
    if (hidden === undefined || hidden.type !== "float32") {
      throw new Error(
        `ONNX session did not return float32 last_hidden_state (got ${String(hidden?.type)})`,
      );
    }
    // Shape is [B, seqLen, hiddenSize]. hiddenSize derived from data length
    // so we don't hard-fail if a checkpoint ever surprises us with a
    // different dim — we just assert it matches EMBED_DIM at the boundary.
    const data = hidden.data as Float32Array;
    const hiddenSize = data.length / (batchSize * batchMax);
    if (hiddenSize !== EMBED_DIM) {
      throw new Error(`Expected hidden size ${EMBED_DIM}, got ${hiddenSize}. Wrong model loaded?`);
    }

    const out: Float32Array[] = [];
    for (let b = 0; b < batchSize; b++) {
      const vec = clsPool(data, b, batchMax, hiddenSize);
      if (this.#normalize) {
        l2NormalizeInPlace(vec);
      }
      out.push(vec);
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
 * Open a deterministic Arctic Embed XS embedder.
 *
 * Throws {@link EmbedderNotSetupError} if the weight files are not present —
 * callers in the CLI use this to surface `codehub setup --embeddings`
 * guidance, and the search layer degrades to BM25-only.
 */
export async function openOnnxEmbedder(cfg: EmbedderConfig = {}): Promise<Embedder> {
  const variant = cfg.variant ?? "fp32";
  const modelDir = resolveModelDir(cfg.modelDir, variant);
  const normalize = cfg.normalize ?? true;
  // `maxSequenceLength` is the caller-facing budget in user tokens; the
  // actual model input adds 2 slots for [CLS]/[SEP], capped at
  // MODEL_MAX_POSITION (512) to fit the position embedding table.
  const userMax = cfg.maxSequenceLength ?? MODEL_MAX_POSITION - 2;
  const maxModelLength = Math.min(userMax + 2, MODEL_MAX_POSITION);

  const { modelPath, tokenizerDir } = await assertModelFiles(modelDir, variant);

  const tokenizer = await loadTokenizer(tokenizerDir);
  const session = await InferenceSession.create(modelPath, buildSessionOptions());

  return new OnnxEmbedder({
    session,
    tokenizer,
    variant,
    normalize,
    maxModelLength,
  });
}
