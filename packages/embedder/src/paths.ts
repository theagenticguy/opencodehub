/**
 * Resolves the on-disk location of Arctic Embed XS weight files.
 *
 * Layout convention:
 *   ${CODEHUB_HOME:-~/.codehub}/models/arctic-embed-xs/${variant}/
 *     ├── model.onnx          (or model_int8.onnx)
 *     ├── tokenizer.json
 *     ├── tokenizer_config.json
 *     ├── config.json
 *     └── special_tokens_map.json
 *
 * `codehub setup --embeddings` is the code path that populates this
 * directory; this module just resolves paths and never touches the network.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

const MODEL_SUBDIR = "models/arctic-embed-xs";

/**
 * Root directory that holds every OpenCodeHub-managed artefact (model weights,
 * caches, manifests). Honours `CODEHUB_HOME`; otherwise `~/.codehub`.
 */
export function getDefaultModelRoot(): string {
  const envHome = process.env["CODEHUB_HOME"];
  if (envHome !== undefined && envHome.length > 0) {
    return resolve(envHome);
  }
  return join(homedir(), ".codehub");
}

/**
 * Directory containing the variant-specific model files.
 *
 * @param override - explicit path; if provided it is returned unchanged
 *   (after `resolve(...)` to normalize `~`-less relative paths).
 * @param variant - `fp32` (default) or `int8`.
 */
export function resolveModelDir(override?: string, variant: "fp32" | "int8" = "fp32"): string {
  if (override !== undefined && override.length > 0) {
    return resolve(override);
  }
  return join(getDefaultModelRoot(), MODEL_SUBDIR, variant);
}

/** File name of the ONNX weights for a given variant. */
export function modelFileName(variant: "fp32" | "int8"): string {
  return variant === "fp32" ? "model.onnx" : "model_int8.onnx";
}

/** All tokenizer-related files we require alongside the ONNX weights. */
export const TOKENIZER_FILES = [
  "tokenizer.json",
  "tokenizer_config.json",
  "config.json",
  "special_tokens_map.json",
] as const;
