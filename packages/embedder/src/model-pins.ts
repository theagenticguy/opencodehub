/**
 * SHA256 and source-URL pins for every Arctic Embed XS weight file we ship.
 *
 * These pins are the authoritative contract consumed by `codehub setup
 * --embeddings` and by `codehub doctor` at runtime. SHA256 values were
 * computed locally against the Hugging Face model repo at commit
 * `d8c86521100d3556476a063fc2342036d45c106f` on 2026-04-18.
 *
 * This module does NOT download anything on its own. It is pure data.
 */

/** HF repo + commit the pins are anchored to. */
export const ARCTIC_EMBED_XS_REPO = {
  hfRepo: "Snowflake/snowflake-arctic-embed-xs",
  commit: "d8c86521100d3556476a063fc2342036d45c106f",
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
  return `https://huggingface.co/${ARCTIC_EMBED_XS_REPO.hfRepo}/resolve/${ARCTIC_EMBED_XS_REPO.commit}/${path}`;
}

// Tokenizer + config files are identical across variants — hashes computed
// once from the model repo.
const TOKENIZER_JSON: PinnedFile = {
  name: "tokenizer.json",
  url: hfUrl("tokenizer.json"),
  sizeBytes: 711649,
  sha256: "91f1def9b9391fdabe028cd3f3fcc4efd34e5d1f08c3bf2de513ebb5911a1854",
};

const TOKENIZER_CONFIG_JSON: PinnedFile = {
  name: "tokenizer_config.json",
  url: hfUrl("tokenizer_config.json"),
  sizeBytes: 1430,
  sha256: "9ca59277519f6e3692c8685e26b94d4afca2d5438deff66483db495e48735810",
};

const CONFIG_JSON: PinnedFile = {
  name: "config.json",
  url: hfUrl("config.json"),
  sizeBytes: 737,
  sha256: "d7d071046ab952af96b7abad788db7ab3fc997b465e1b9914ff39707092254ec",
};

const SPECIAL_TOKENS_MAP_JSON: PinnedFile = {
  name: "special_tokens_map.json",
  url: hfUrl("special_tokens_map.json"),
  sizeBytes: 695,
  sha256: "5d5b662e421ea9fac075174bb0688ee0d9431699900b90662acd44b2a350503a",
};

/**
 * Per-variant manifests. The fp32 variant is the default (90 MB, highest
 * precision); int8 is 4× smaller with ~99% fidelity for size-constrained
 * installs.
 */
export const ARCTIC_EMBED_XS_PINS: {
  readonly fp32: VariantPins;
  readonly int8: VariantPins;
} = {
  fp32: {
    variant: "fp32",
    files: [
      {
        name: "model.onnx",
        url: hfUrl("onnx/model.onnx"),
        sizeBytes: 90387631,
        sha256: "cf2698d30ff05da02c70a088313bad56e5c2f401d734cb24a8390d446111936c",
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
        sizeBytes: 22972992,
        sha256: "e6aa5e656466a73d7c3111e9a3378bd13e5b93af30eaac2b3f13fd56692589a1",
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
  return `snowflake-arctic-embed-xs/${variant}`;
}
