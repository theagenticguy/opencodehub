/**
 * `openDefaultEmbedder` — the shared HTTP-priority + ONNX-fallback factory
 * used by `@opencodehub/cli` and `@opencodehub/mcp` query call sites.
 *
 * Selection precedence:
 *   1. {@link tryOpenHttpEmbedder} reads SageMaker / OpenAI-HTTP env vars
 *      first and returns a remote-backed embedder when configured.
 *   2. Otherwise — and only when `allowOnnxFallback === true` (the default) —
 *      fall back to {@link openOnnxEmbedder}, which loads F2LLM-v2-80m
 *      weights from disk (the lazy-load side effect).
 *   3. With `allowOnnxFallback: false` and no HTTP/SageMaker env, throw
 *      {@link EmbedderNotSetupError} — the ONNX binding is never loaded.
 *
 * The fuller variant in `packages/ingestion/src/pipeline/phases/embeddings.ts`
 * intentionally stays separate: ingestion needs an offline flag, an explicit
 * ONNX variant + modelDir config, a weight canary, and a Piscina pool. None
 * of those apply to the query-time path.
 */

import { openHttpEmbedder, readHttpEmbedderConfigFromEnv } from "./http-embedder.js";
import { openOnnxEmbedder as defaultOpenOnnxEmbedder } from "./onnx-embedder.js";
import { openSagemakerEmbedder, readSagemakerEmbedderConfigFromEnv } from "./sagemaker-embedder.js";
import { type Embedder, EmbedderNotSetupError } from "./types.js";

/**
 * Inline copy of {@link tryOpenHttpEmbedder} from `./index.ts` — kept
 * separate to avoid a circular import between `index.ts` (which re-exports
 * the factory) and the factory module. Behavior matches the public
 * `tryOpenHttpEmbedder` exactly: SageMaker env first, then HTTP env, then
 * `null`. The factory does not honor the `offline` flag — query-time
 * call-sites do not run in offline mode.
 */
function tryOpenHttpEmbedderFromEnv(): Embedder | Promise<Embedder> | null {
  const sagemakerCfg = readSagemakerEmbedderConfigFromEnv();
  if (sagemakerCfg !== null) {
    return openSagemakerEmbedder(sagemakerCfg);
  }
  const httpCfg = readHttpEmbedderConfigFromEnv();
  if (httpCfg === null) return null;
  return openHttpEmbedder(httpCfg);
}

/**
 * Options for {@link openDefaultEmbedder}.
 */
export interface OpenDefaultEmbedderOptions {
  /**
   * When `true` (default) — fall back to the local ONNX embedder if no
   * HTTP / SageMaker env vars are configured. When `false` — throw
   * {@link EmbedderNotSetupError} instead. Use `false` for fully-remote
   * deployments that should never load ONNX weights.
   */
  readonly allowOnnxFallback?: boolean;
}

/**
 * Internal injection seam used only by the unit test. The production
 * call-sites do not need to provide overrides.
 */
export interface OpenDefaultEmbedderDeps {
  readonly tryOpenHttp?: () => Embedder | Promise<Embedder> | null;
  readonly openOnnx?: typeof defaultOpenOnnxEmbedder;
}

/**
 * HTTP-priority + ONNX-fallback embedder factory.
 *
 * @param opts.allowOnnxFallback default `true` — set `false` to refuse the
 *   ONNX path and throw {@link EmbedderNotSetupError} when no remote
 *   embedder env vars are set.
 */
export async function openDefaultEmbedder(
  opts: OpenDefaultEmbedderOptions = {},
  deps: OpenDefaultEmbedderDeps = {},
): Promise<Embedder> {
  const tryOpenHttp = deps.tryOpenHttp ?? tryOpenHttpEmbedderFromEnv;
  const openOnnx = deps.openOnnx ?? defaultOpenOnnxEmbedder;
  const allowOnnxFallback = opts.allowOnnxFallback ?? true;

  // tryOpenHttp returns Embedder | Promise<Embedder> | null. `await` on a
  // non-Promise value just resolves to that value, so this normalizes both
  // shapes into a single branch.
  const httpEmbedder = await tryOpenHttp();
  if (httpEmbedder !== null) return httpEmbedder;

  if (!allowOnnxFallback) {
    throw new EmbedderNotSetupError(
      "No remote embedder is configured (set CODEHUB_EMBEDDING_URL or " +
        "CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT) and `allowOnnxFallback` is " +
        "disabled. Either configure a remote endpoint or pass " +
        "`allowOnnxFallback: true`.",
    );
  }
  return openOnnx();
}
