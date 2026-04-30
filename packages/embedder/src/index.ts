/**
 * @opencodehub/embedder — deterministic text embedder with three backends.
 *
 * Callers pick the backend by supplying a config:
 *   - When `sagemakerEndpointName` is set, {@link openEmbedder} returns a
 *     client that invokes a SageMaker Runtime endpoint (TEI native wire
 *     format, SigV4 auth). No ONNX weights and no local GPU needed.
 *   - When `endpointUrl` is set, {@link openEmbedder} returns an HTTP client
 *     that POSTs to an OpenAI-compatible `/v1/embeddings` server (Infinity,
 *     vLLM, TEI, Ollama, LM Studio, OpenAI).
 *   - When neither is set, {@link openEmbedder} falls back to the local
 *     ONNX gte-modernbert-base path (deterministic embedder).
 *
 * Offline invariant: when `offline === true` and any remote option
 * (SageMaker or `endpointUrl`) is set, {@link openEmbedder} throws. Remote
 * paths open sockets; offline mode forbids sockets, full stop.
 *
 * Env-var shortcut: {@link tryOpenHttpEmbedder} checks SageMaker env vars
 * first (`CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT` / `_REGION`), then
 * OpenAI-HTTP env vars (`CODEHUB_EMBEDDING_URL` / `_MODEL` / `_DIMS` /
 * `_API_KEY`). Env vars are read fresh on every call.
 */

import {
  type HttpEmbedderConfig,
  openHttpEmbedder,
  readHttpEmbedderConfigFromEnv,
} from "./http-embedder.js";
import { openOnnxEmbedder } from "./onnx-embedder.js";
import {
  openSagemakerEmbedder,
  readSagemakerEmbedderConfigFromEnv,
  type SagemakerEmbedderConfig,
} from "./sagemaker-embedder.js";
import type { Embedder, EmbedderConfig } from "./types.js";

export {
  type HttpEmbedderConfig,
  openHttpEmbedder,
  readHttpEmbedderConfigFromEnv,
} from "./http-embedder.js";
export {
  embedderModelId,
  GTE_MODERNBERT_BASE_PINS,
  GTE_MODERNBERT_BASE_REPO,
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
  openSagemakerEmbedder,
  readSagemakerEmbedderConfigFromEnv,
  type SagemakerEmbedderConfig,
  type SagemakerRuntimeLike,
} from "./sagemaker-embedder.js";
export {
  type Embedder,
  type EmbedderConfig,
  EmbedderNotSetupError,
} from "./types.js";

/**
 * Options accepted by {@link openEmbedder}. Every field is optional.
 * Backend selection precedence: `sagemakerEndpointName` → `endpointUrl` →
 * ONNX.
 */
export interface OpenEmbedderOptions {
  /**
   * When `true`, remote embeddings (SageMaker or HTTP) are forbidden.
   * Passing `sagemakerEndpointName` or `endpointUrl` alongside
   * `offline=true` throws — the ONNX path is still available. Defaults to
   * `false`.
   */
  readonly offline?: boolean;
  /**
   * SageMaker endpoint name. When set (and not offline), selects the
   * SageMaker backend ahead of the HTTP and ONNX options.
   */
  readonly sagemakerEndpointName?: string;
  /** AWS region for the SageMaker endpoint. Defaults to `us-east-1`. */
  readonly sagemakerRegion?: string;
  /**
   * OpenAI-compatible embeddings base URL. When set (and no SageMaker
   * endpoint is configured, and not offline), selects the HTTP backend.
   */
  readonly endpointUrl?: string;
  /**
   * Model id for the HTTP request body. Required when `endpointUrl` is
   * set; optional override for the SageMaker backend's default stamp.
   */
  readonly modelId?: string;
  /** Bearer token for the HTTP request. Optional; sent as `unused` when absent. */
  readonly apiKey?: string;
  /** Expected response-vector dimension. Defaults to 768 for HTTP/SageMaker. */
  readonly dims?: number;
  /**
   * Pass-through options for the ONNX backend when a remote backend is
   * not selected. Ignored when `sagemakerEndpointName` or `endpointUrl`
   * is set.
   */
  readonly onnx?: EmbedderConfig;
  /**
   * Optional fetch override, primarily for tests. Only consulted when the
   * HTTP backend is chosen.
   */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Factory that picks the SageMaker, HTTP, or ONNX backend based on the
 * supplied options.
 *
 *   - `offline === true` AND (`sagemakerEndpointName` OR `endpointUrl`)
 *     set → throws. Remote clients open sockets; offline forbids sockets.
 *   - `sagemakerEndpointName` set (and not offline) → SageMaker backend.
 *   - `endpointUrl` set (and not offline) → HTTP backend.
 *   - Otherwise → ONNX backend (the existing local path).
 *
 * Callers that want env-driven selection without threading the env vars
 * through their own config should use {@link tryOpenHttpEmbedder} to read
 * env first and then fall back to `openOnnxEmbedder()` themselves.
 */
export async function openEmbedder(opts: OpenEmbedderOptions = {}): Promise<Embedder> {
  if (opts.sagemakerEndpointName !== undefined && opts.sagemakerEndpointName !== "") {
    if (opts.offline === true) {
      throw new Error(
        "SageMaker embeddings are disabled in offline mode. Either unset " +
          "CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT / the sagemakerEndpointName " +
          "option, or drop `--offline`.",
      );
    }
    const cfg: SagemakerEmbedderConfig = {
      endpointName: opts.sagemakerEndpointName,
      ...(opts.sagemakerRegion !== undefined && opts.sagemakerRegion !== ""
        ? { region: opts.sagemakerRegion }
        : {}),
      ...(opts.modelId !== undefined && opts.modelId !== "" ? { modelId: opts.modelId } : {}),
      ...(opts.dims !== undefined ? { dims: opts.dims } : {}),
    };
    return openSagemakerEmbedder(cfg);
  }
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
 * Check remote-embedder env vars and return a ready-to-use `Embedder` when
 * one is configured. Selection precedence:
 *
 *   1. `CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT` set → SageMaker backend
 *      (returned as a `Promise<Embedder>` because SDK loading is async).
 *   2. `CODEHUB_EMBEDDING_URL` + `CODEHUB_EMBEDDING_MODEL` set → HTTP
 *      backend (returned synchronously — zero async work in construction).
 *   3. Neither → `null` so the caller falls back to ONNX on its own.
 *
 * The mixed sync/async return type is a compromise to keep the existing
 * synchronous HTTP call-sites unchanged. Existing callers already do
 * `const e = mod.tryOpenHttpEmbedder(); if (e !== null) return e;` inside
 * an `async` function, which awaits the returned promise transparently.
 *
 * Respects the offline invariant: when `offline === true` and either
 * remote env-var set is populated, this function throws rather than
 * silently falling through to ONNX — the user asked for a remote backend
 * explicitly and we refuse to paper over the conflict.
 */
export function tryOpenHttpEmbedder(
  options: { readonly offline?: boolean; readonly fetchImpl?: typeof fetch } = {},
): Embedder | Promise<Embedder> | null {
  const sagemakerCfg = readSagemakerEmbedderConfigFromEnv();
  if (sagemakerCfg !== null) {
    if (options.offline === true) {
      throw new Error(
        "SageMaker embeddings are disabled in offline mode. Either unset " +
          "CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT, or drop `--offline`.",
      );
    }
    return openSagemakerEmbedder(sagemakerCfg);
  }
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
