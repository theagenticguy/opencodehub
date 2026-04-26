/**
 * OpenAI-compatible HTTP embedder.
 *
 * When the user points `CODEHUB_EMBEDDING_URL` + `CODEHUB_EMBEDDING_MODEL`
 * (plus optional `CODEHUB_EMBEDDING_DIMS` + `CODEHUB_EMBEDDING_API_KEY`) at
 * an OpenAI-compatible `/v1/embeddings` server (Infinity, vLLM, TEI, Ollama
 * LM Studio, or OpenAI itself), this embedder POSTs each request there
 * instead of loading ONNX weights. The response-vector dimension is
 * asserted against the configured `dims` on every call so a remote model
 * swap can never silently pollute the HNSW index with mismatched rows.
 *
 * Scope invariants:
 *   - No streaming. One POST per `embed(text)` call.
 *   - No caching at this layer. Callers handle content-hash dedup upstream.
 *   - No default endpoint. If the env vars aren't set, the higher-level
 *     factory falls through to ONNX; this file is HTTP-only.
 *   - Bearer auth via the `Authorization` header; `unused` is sent when the
 *     API key is absent so servers that require a header still see one.
 *   - Retry on network errors + 5xx + 429. Retries cap at {@link HTTP_MAX_RETRIES}
 *     with a linear backoff; timeouts are NOT retried.
 */

import type { Embedder } from "./types.js";

const HTTP_TIMEOUT_MS = 30_000;
const HTTP_MAX_RETRIES = 2;
const HTTP_RETRY_BACKOFF_MS = 1_000;

/**
 * Configuration for {@link openHttpEmbedder}.
 *
 * `endpointUrl` must be the base of an OpenAI-compatible embeddings server;
 * the `/embeddings` suffix is appended automatically. Any trailing slash on
 * the base is stripped.
 */
export interface HttpEmbedderConfig {
  /**
   * Base URL of the embedding service. The client POSTs to
   * `${endpointUrl.replace(/\/+$/, "")}/embeddings`.
   */
  readonly endpointUrl: string;
  /** Model id sent in the `model` field of the request body. */
  readonly modelId: string;
  /**
   * Expected response-vector dimension. Defaults to 768 (gte-modernbert-base).
   * Every response is asserted against this so a remote model swap can
   * never silently pollute downstream vector indexes.
   */
  readonly dims?: number;
  /**
   * Optional bearer token. Sent as `Authorization: Bearer <key>`. Servers
   * that do not require auth still receive the header (`unused`) so
   * fetch's default behaviour is consistent across backends.
   */
  readonly apiKey?: string;
  /**
   * Optional fetch override, primarily for tests. Defaults to the global
   * `fetch`. The override must match the standard `fetch` signature.
   */
  readonly fetchImpl?: typeof fetch;
}

/** Default dim for gte-modernbert-base (the fallback when env doesn't set it). */
const DEFAULT_DIMS = 768;

/**
 * Read HTTP embedder config from the process environment. Returns `null`
 * when either the URL or model env var is unset, so the factory knows to
 * fall through to ONNX. Env vars are read fresh on every call (no caching)
 * so late `process.env` mutation during startup takes effect.
 */
export function readHttpEmbedderConfigFromEnv(): HttpEmbedderConfig | null {
  const endpointUrl = process.env["CODEHUB_EMBEDDING_URL"];
  const modelId = process.env["CODEHUB_EMBEDDING_MODEL"];
  if (endpointUrl === undefined || endpointUrl === "") return null;
  if (modelId === undefined || modelId === "") return null;

  const rawDims = process.env["CODEHUB_EMBEDDING_DIMS"];
  let dims: number | undefined;
  if (rawDims !== undefined && rawDims !== "") {
    const parsed = Number.parseInt(rawDims, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`CODEHUB_EMBEDDING_DIMS must be a positive integer, got "${rawDims}"`);
    }
    dims = parsed;
  }

  const apiKey = process.env["CODEHUB_EMBEDDING_API_KEY"];
  const cfg: HttpEmbedderConfig = {
    endpointUrl,
    modelId,
    ...(dims !== undefined ? { dims } : {}),
    ...(apiKey !== undefined && apiKey !== "" ? { apiKey } : {}),
  };
  return cfg;
}

/**
 * Return a representation of `url` safe to include in error messages: the
 * query string may carry a token or path-embedded secret, so strip it.
 */
function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "<invalid-url>";
  }
}

interface EmbeddingItem {
  readonly embedding: readonly number[];
}

interface EmbeddingResponse {
  readonly data: readonly EmbeddingItem[];
}

function isEmbeddingResponse(value: unknown): value is EmbeddingResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { data?: unknown };
  if (!Array.isArray(v.data)) return false;
  for (const item of v.data) {
    if (typeof item !== "object" || item === null) return false;
    const it = item as { embedding?: unknown };
    if (!Array.isArray(it.embedding)) return false;
  }
  return true;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** POST one batch of texts to the embedding endpoint with retry on 5xx/429. */
async function postEmbedding(
  url: string,
  body: { readonly input: readonly string[]; readonly model: string },
  apiKey: string,
  fetchImpl: typeof fetch,
  attempt = 0,
): Promise<EmbeddingResponse> {
  let resp: Response;
  try {
    resp = await fetchImpl(url, {
      method: "POST",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Timeouts are NOT retried — the server is unresponsive.
    const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
    if (isTimeout) {
      throw new Error(`Embedding request timed out after ${HTTP_TIMEOUT_MS}ms (${safeUrl(url)})`);
    }
    // DNS / connection / TLS errors — retry with linear backoff.
    if (attempt < HTTP_MAX_RETRIES) {
      await sleep(HTTP_RETRY_BACKOFF_MS * (attempt + 1));
      return postEmbedding(url, body, apiKey, fetchImpl, attempt + 1);
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Embedding request failed (${safeUrl(url)}): ${reason}`);
  }

  if (!resp.ok) {
    const status = resp.status;
    if ((status === 429 || status >= 500) && attempt < HTTP_MAX_RETRIES) {
      await sleep(HTTP_RETRY_BACKOFF_MS * (attempt + 1));
      return postEmbedding(url, body, apiKey, fetchImpl, attempt + 1);
    }
    throw new Error(`Embedding endpoint returned ${status} (${safeUrl(url)})`);
  }

  const parsed: unknown = await resp.json();
  if (!isEmbeddingResponse(parsed)) {
    throw new Error(`Embedding endpoint returned malformed body (${safeUrl(url)})`);
  }
  return parsed;
}

/**
 * Public factory for the HTTP embedder. The caller supplies an explicit
 * config; see {@link readHttpEmbedderConfigFromEnv} for the env-var path.
 *
 * Throws synchronously on an invalid {@link HttpEmbedderConfig.endpointUrl};
 * the first `embed()` call is what actually contacts the server, and a
 * connection failure there surfaces as a normal `Error`.
 */
export function openHttpEmbedder(cfg: HttpEmbedderConfig): Embedder {
  const baseUrl = cfg.endpointUrl.replace(/\/+$/, "");
  // Accept both a bare host (https://host) and a fully-qualified
  // `/v1/embeddings` URL. Only append `/embeddings` when the base does not
  // already end in that segment.
  const url = baseUrl.endsWith("/embeddings") ? baseUrl : `${baseUrl}/embeddings`;
  const dims = cfg.dims ?? DEFAULT_DIMS;
  const apiKey = cfg.apiKey ?? "unused";
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const modelId = cfg.modelId;

  async function embedOne(text: string): Promise<Float32Array> {
    const resp = await postEmbedding(url, { input: [text], model: modelId }, apiKey, fetchImpl);
    const first = resp.data[0];
    if (first === undefined) {
      throw new Error(`Embedding endpoint returned empty data array (${safeUrl(url)})`);
    }
    if (first.embedding.length !== dims) {
      throw new Error(
        `Embedding dimension mismatch: endpoint returned ${first.embedding.length}d vector, ` +
          `but expected ${dims}d. Update CODEHUB_EMBEDDING_DIMS to match your model output ` +
          `(or change CODEHUB_EMBEDDING_MODEL).`,
      );
    }
    return new Float32Array(first.embedding);
  }

  return {
    dim: dims,
    modelId,
    embed: embedOne,
    async embedBatch(texts: readonly string[]): Promise<readonly Float32Array[]> {
      if (texts.length === 0) return [];
      // One request per text. The HTTP surface supports batched `input`, but
      // the phases that consume this embedder already stream through small
      // chunks per symbol; keeping one-request-per-embed preserves the
      // v1-scope invariant "single embedding per request".
      const out: Float32Array[] = [];
      for (const text of texts) {
        out.push(await embedOne(text));
      }
      return out;
    },
    async close(): Promise<void> {
      // No native handles to release — HTTP embedder is stateless.
    },
  };
}
