/**
 * SHA256 and source-URL pins for every gte-modernbert-base weight file we ship.
 *
 * These pins are the authoritative contract consumed by `codehub setup
 * --embeddings` and by `codehub doctor` at runtime. SHA256 values were
 * computed locally against the Hugging Face model repo at commit
 * `e7f32e3c00f91d699e8c43b53106206bcc72bb22` on 2026-04-25.
 *
 * This module does NOT download anything on its own. It is pure data.
 */

/** HF repo + commit the pins are anchored to. */
export const GTE_MODERNBERT_BASE_REPO = {
  hfRepo: "Alibaba-NLP/gte-modernbert-base",
  commit: "e7f32e3c00f91d699e8c43b53106206bcc72bb22",
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

function hfUrl(path: string): string {
  return `https://huggingface.co/${GTE_MODERNBERT_BASE_REPO.hfRepo}/resolve/${GTE_MODERNBERT_BASE_REPO.commit}/${path}`;
}

// Tokenizer + config files are identical across variants — hashes computed
// once from the model repo.
const TOKENIZER_JSON: PinnedFile = {
  name: "tokenizer.json",
  url: hfUrl("tokenizer.json"),
  sizeBytes: 3583228,
  sha256: "6c8aaa9a542084f2457eab775d4eeb51f92a70c0fd9de28d5edb0ddec3c08d30",
};

const TOKENIZER_CONFIG_JSON: PinnedFile = {
  name: "tokenizer_config.json",
  url: hfUrl("tokenizer_config.json"),
  sizeBytes: 20867,
  sha256: "9654072f7c873161814043cf08cb5ed72f71d0b935abcd4e267935cb34352c21",
};

const CONFIG_JSON: PinnedFile = {
  name: "config.json",
  url: hfUrl("config.json"),
  sizeBytes: 1184,
  sha256: "8ba54dc3d35d7194f5178a4194b649f146753e02dabd22bdca5c5cbac15069ed",
};

const SPECIAL_TOKENS_MAP_JSON: PinnedFile = {
  name: "special_tokens_map.json",
  url: hfUrl("special_tokens_map.json"),
  sizeBytes: 694,
  sha256: "ea97ecdbcc73713039d8d64dbb05e3689495c96657fbd9a18f5bed381be81049",
};

/**
 * Per-variant manifests. The fp32 variant is the default (596 MB, highest
 * precision); int8 is 4× smaller (150 MB) with near-identical retrieval
 * quality for size-constrained installs.
 */
export const GTE_MODERNBERT_BASE_PINS: {
  readonly fp32: VariantPins;
  readonly int8: VariantPins;
} = {
  fp32: {
    variant: "fp32",
    files: [
      {
        name: "model.onnx",
        url: hfUrl("onnx/model.onnx"),
        sizeBytes: 596392315,
        sha256: "947f31df7effaeec4edb57c50e4ed7e0f2034d9336063f92615b92e3e0d24d78",
      },
      TOKENIZER_JSON,
      TOKENIZER_CONFIG_JSON,
      CONFIG_JSON,
      SPECIAL_TOKENS_MAP_JSON,
    ],
  },
  int8: {
    variant: "int8",
    files: [
      {
        name: "model_int8.onnx",
        url: hfUrl("onnx/model_int8.onnx"),
        sizeBytes: 150218016,
        sha256: "bae96b276d342bf86eeee07c1bdbc0c75bb82bf4033941aab7fabc1e33ee3b44",
      },
      TOKENIZER_JSON,
      TOKENIZER_CONFIG_JSON,
      CONFIG_JSON,
      SPECIAL_TOKENS_MAP_JSON,
    ],
  },
} as const;

/** Model id tag written into `embeddings.model` (keeps HNSW indexes separable). */
export function embedderModelId(variant: "fp32" | "int8"): string {
  return `gte-modernbert-base/${variant}`;
}
