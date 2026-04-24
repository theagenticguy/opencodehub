/**
 * @opencodehub/embedder — deterministic text embedder with two backends.
 *
 * Callers pick the backend by supplying a config:
 *   - When `endpointUrl` is set, {@link openEmbedder} returns an HTTP client
 *     that POSTs to an OpenAI-compatible `/v1/embeddings` server (Infinity,
 *     vLLM, TEI, Ollama, LM Studio, OpenAI). No ONNX weights needed.
 *   - When `endpointUrl` is absent, {@link openEmbedder} falls back to the
 *     local ONNX Arctic Embed XS path (original deterministic embedder).
 *
 * Offline invariant: when `offline === true` and `endpointUrl` is set,
 * {@link openEmbedder} throws. The HTTP path opens sockets; offline mode
 * forbids sockets, full stop.
 *
 * Env-var shortcut: {@link readHttpEmbedderConfigFromEnv} reads
 * `CODEHUB_EMBEDDING_URL` / `_MODEL` / `_DIMS` / `_API_KEY` fresh on every
 * call. Callers that want env-driven behaviour without threading the vars
 * themselves can layer {@link tryOpenHttpEmbedder} on top.
 */

import {
  type HttpEmbedderConfig,
  openHttpEmbedder,
  readHttpEmbedderConfigFromEnv,
} from "./http-embedder.js";
import { openOnnxEmbedder } from "./onnx-embedder.js";
import type { Embedder, EmbedderConfig } from "./types.js";

export {
  type HttpEmbedderConfig,
  openHttpEmbedder,
  readHttpEmbedderConfigFromEnv,
} from "./http-embedder.js";
export {
  ARCTIC_EMBED_XS_PINS,
  ARCTIC_EMBED_XS_REPO,
  embedderModelId,
  type PinnedFile,
  type VariantPins,
} from "./model-pins.js";
export { openOnnxEmbedder } from "./onnx-embedder.js";
export {
  getDefaultModelRoot,
  modelFileName,
  resolveModelDir,
  TOKENIZER_FILES,
} from "./paths.js";
export {
  type Embedder,
  type EmbedderConfig,
  EmbedderNotSetupError,
} from "./types.js";

/**
 * Options accepted by {@link openEmbedder}. Every field is optional; the
 * presence of `endpointUrl` is what switches the backend from ONNX to HTTP.
 */
export interface OpenEmbedderOptions {
  /**
   * When `true`, HTTP embeddings are forbidden. Passing `endpointUrl`
   * alongside `offline=true` throws — the ONNX path is still available.
   * Defaults to `false`.
   */
  readonly offline?: boolean;
  /**
   * OpenAI-compatible embeddings base URL. When set (and not offline),
   * selects the HTTP backend; when unset, falls through to ONNX.
   */
  readonly endpointUrl?: string;
  /** Model id for the HTTP request body. Required when `endpointUrl` is set. */
  readonly modelId?: string;
  /** Bearer token for the HTTP request. Optional; sent as `unused` when absent. */
  readonly apiKey?: string;
  /** Expected response-vector dimension. Defaults to 384 for HTTP. */
  readonly dims?: number;
  /**
   * Pass-through options for the ONNX backend when HTTP is not selected.
   * Ignored when `endpointUrl` is set.
   */
  readonly onnx?: EmbedderConfig;
  /**
   * Optional fetch override, primarily for tests. Only consulted when the
   * HTTP backend is chosen.
   */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Factory that picks the HTTP or ONNX backend based on the supplied
 * options.
 *
 *   - `offline === true` AND `endpointUrl` set → throws. The HTTP client
 *     opens sockets; the offline invariant forbids sockets.
 *   - `endpointUrl` set (and not offline) → HTTP backend.
 *   - Otherwise → ONNX backend (the existing local path).
 *
 * Callers that want env-driven selection without threading
 * `CODEHUB_EMBEDDING_URL` through their own config should use
 * {@link tryOpenHttpEmbedder} to read env first and then fall back to
 * `openOnnxEmbedder()` themselves.
 */
export async function openEmbedder(opts: OpenEmbedderOptions = {}): Promise<Embedder> {
  if (opts.endpointUrl !== undefined && opts.endpointUrl !== "") {
    if (opts.offline === true) {
      throw new Error(
        "HTTP embeddings are disabled in offline mode. Either unset " +
          "CODEHUB_EMBEDDING_URL / the endpointUrl option, or drop `--offline`.",
      );
    }
    if (opts.modelId === undefined || opts.modelId === "") {
      throw new Error(
        "openEmbedder: `modelId` is required when `endpointUrl` is set " +
          "(set CODEHUB_EMBEDDING_MODEL or pass modelId explicitly).",
      );
    }
    const cfg: HttpEmbedderConfig = {
      endpointUrl: opts.endpointUrl,
      modelId: opts.modelId,
      ...(opts.dims !== undefined ? { dims: opts.dims } : {}),
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    };
    return openHttpEmbedder(cfg);
  }
  return openOnnxEmbedder(opts.onnx ?? {});
}

/**
 * If `CODEHUB_EMBEDDING_URL` + `CODEHUB_EMBEDDING_MODEL` are set, return an
 * HTTP embedder; otherwise return `null` so the caller can fall back to
 * ONNX on its own terms (the existing `openOnnxEmbedder()` path preserves
 * graceful degradation when weights are missing).
 *
 * Respects the offline invariant: when `offline === true` and the env vars
 * are set, this function throws rather than silently falling through to
 * ONNX — the user asked for HTTP explicitly and we refuse to paper over
 * the conflict.
 */
export function tryOpenHttpEmbedder(
  options: { readonly offline?: boolean; readonly fetchImpl?: typeof fetch } = {},
): Embedder | null {
  const envCfg = readHttpEmbedderConfigFromEnv();
  if (envCfg === null) return null;
  if (options.offline === true) {
    throw new Error(
      "HTTP embeddings are disabled in offline mode. Either unset " +
        "CODEHUB_EMBEDDING_URL, or drop `--offline`.",
    );
  }
  const cfg: HttpEmbedderConfig = {
    ...envCfg,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  };
  return openHttpEmbedder(cfg);
}
