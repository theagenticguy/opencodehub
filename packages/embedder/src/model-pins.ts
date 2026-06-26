/**
 * SHA256 and source-URL pins for every F2LLM-v2-80M weight file we ship.
 *
 * These pins are the authoritative contract consumed by `codehub setup
 * --embeddings` and by `codehub doctor` at runtime. SHA256 values were
 * computed locally against the ONNX export produced from
 * `codefuse-ai/F2LLM-v2-80M` (a Qwen3-0.6B-Base derivative) — the export
 * bakes last-token pooling + L2 normalization into the graph, so it is NOT
 * the upstream Hugging Face repo's own files. We host the exported
 * artifacts as a GitHub release asset and pin them by URL + SHA256.
 *
 * This module does NOT download anything on its own. It is pure data.
 */

/** Source repo + release the pins are anchored to. */
export const F2LLM_V2_80M_REPO = {
  /** Upstream model the ONNX export is derived from (attribution). */
  upstream: "codefuse-ai/F2LLM-v2-80M",
  /** GitHub release tag hosting the exported ONNX + tokenizer artifacts. */
  release: "embed-v1",
  license: "Apache-2.0",
} as const;

/** One pinned file: name on disk, resolve URL, size in bytes, and SHA256. */
export interface PinnedFile {
  readonly name: string;
  readonly url: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

/** Full manifest for one model variant (fp32 or int8). */
export interface VariantPins {
  readonly variant: "fp32" | "int8";
  readonly files: readonly PinnedFile[];
}

/**
 * Build the download URL for a release asset. The exported ONNX files do
 * not exist upstream on Hugging Face — they are attached to a GitHub
 * release on the opencodehub repo. Asset names are flat (no directory),
 * so the int8 weights are uploaded as `model_int8.onnx` etc.
 */
function releaseUrl(asset: string): string {
  return `https://github.com/theagenticguy/opencodehub/releases/download/${F2LLM_V2_80M_REPO.release}/${asset}`;
}

// Tokenizer + config files are identical across variants — hashes computed
// once from the exported artifacts.
const TOKENIZER_JSON: PinnedFile = {
  name: "tokenizer.json",
  url: releaseUrl("tokenizer.json"),
  sizeBytes: 11423359,
  sha256: "7dd49a6a008054ecbf11f1568ea9244e99ca8a44fe47e883d1bb9915c3042705",
};

const TOKENIZER_CONFIG_JSON: PinnedFile = {
  name: "tokenizer_config.json",
  url: releaseUrl("tokenizer_config.json"),
  sizeBytes: 378,
  sha256: "3dbc087db36f09c0c359618cbfcebb4b3aed6d8438951c037789b5a0fdc099af",
};

/**
 * Per-variant manifests. The fp32 variant is the default (321 MB,
 * cosine-exact 1.0 vs the PyTorch reference, byte-deterministic under the
 * single-thread WASM gate); int8 is 4× smaller (81 MB) with 4/4 top-1
 * ranking agreement for size-constrained installs.
 *
 * F2LLM emits a single graph output named `embedding` of shape
 * `[batch, 320]` — pooling + L2 norm are in-graph, so only the ONNX file
 * + the two tokenizer files are required (no config.json /
 * special_tokens_map.json, which the export omits).
 */
export const F2LLM_V2_80M_PINS: {
  readonly fp32: VariantPins;
  readonly int8: VariantPins;
} = {
  fp32: {
    variant: "fp32",
    files: [
      {
        name: "model.onnx",
        url: releaseUrl("model.onnx"),
        sizeBytes: 320708733,
        sha256: "9347f761e1420e61c477b56616b3b4f2d2ee80d94747fd6cdde9a03b4c9176bc",
      },
      TOKENIZER_JSON,
      TOKENIZER_CONFIG_JSON,
    ],
  },
  int8: {
    variant: "int8",
    files: [
      {
        name: "model_int8.onnx",
        url: releaseUrl("model_int8.onnx"),
        sizeBytes: 80699171,
        sha256: "302845905e9273a1dd0fb4c670dcd12d16ad35e9522f518aa45a74da4d6ec5b8",
      },
      TOKENIZER_JSON,
      TOKENIZER_CONFIG_JSON,
    ],
  },
} as const;

/** Model id tag written into `embeddings.model` (keeps vector indexes separable). */
export function embedderModelId(variant: "fp32" | "int8"): string {
  return `f2llm-v2-80m/${variant}`;
}
