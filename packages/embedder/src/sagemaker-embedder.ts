/**
 * SageMaker embedder backend. Invokes a TEI (Text Embeddings Inference)
 * SageMaker endpoint — e.g. the `embed-serve` stack at
 * `/efs/lalsaado/workplace/embed-serve/` which serves
 * `Alibaba-NLP/gte-modernbert-base` as `gte-modernbert-embed` in us-east-1.
 *
 * Selection: {@link readSagemakerEmbedderConfigFromEnv} returns a config
 * when `CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT` is set; otherwise `null` so
 * the higher-level factory falls through to HTTP or ONNX.
 *
 * Wire contract (TEI native, NOT OpenAI-wrapped):
 *   - Request:  `POST /endpoints/<name>/invocations`, body
 *               `{"inputs": ["text1", "text2"]}`, ContentType
 *               `application/json`.
 *   - Response: raw `list[list[float]]` — one row per input, each row is a
 *               `dims`-length vector. No `data[].embedding` wrapper.
 *   - Auth:     SigV4 via the AWS SDK default credential chain.
 *   - Limits:   batch ≤ 64, total tokens ≤ 16384, seq ≤ 8192.
 *
 * Scope invariants (v1):
 *   - One `InvokeEndpointCommand` per chunk of ≤64 texts.
 *   - No client-side token accounting; 413 (`ValidationException`) triggers
 *     a single split-retry at chunk size 1 before surfacing.
 *   - SDK retry (`maxAttempts: 5`) handles throttling + 5xx.
 *   - Dims asserted on every response so a remote model swap cannot
 *     silently pollute downstream HNSW indexes.
 *   - `modelId` is stamped as `gte-modernbert-base/sagemaker:<endpoint>`
 *     so an index built with this backend is visibly distinct from a
 *     local ONNX index.
 */

import { type Embedder, EmbedderNotSetupError } from "./types.js";

const DEFAULT_DIMS = 768;
const DEFAULT_REGION = "us-east-1";
const MAX_BATCH = 64;
const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Minimal structural typing of the subset of
 * `@aws-sdk/client-sagemaker-runtime` we consume. Keeping this narrow lets
 * tests inject a fake `runtime` without pulling the SDK's type surface into
 * unit tests and sidesteps dual-package / ESM interop friction.
 */
export interface SagemakerRuntimeLike {
  send(command: {
    readonly input: {
      readonly EndpointName: string;
      readonly ContentType: string;
      readonly Accept: string;
      readonly Body: Uint8Array;
    };
  }): Promise<{ readonly Body?: Uint8Array }>;
}

/** Configuration for {@link openSagemakerEmbedder}. */
export interface SagemakerEmbedderConfig {
  /** Name of the SageMaker endpoint (e.g. `gte-modernbert-embed`). */
  readonly endpointName: string;
  /** AWS region of the endpoint. Defaults to `us-east-1`. */
  readonly region?: string;
  /**
   * Stable model id reported to the index layer. Defaults to
   * `gte-modernbert-base/sagemaker:<endpointName>` so index metadata
   * distinguishes this backend from local ONNX.
   */
  readonly modelId?: string;
  /** Expected response-vector dimension. Defaults to 768. */
  readonly dims?: number;
  /** SDK `maxAttempts`. Defaults to 5. */
  readonly maxAttempts?: number;
  /**
   * Optional pre-constructed runtime client, primarily for tests. When
   * supplied, the dynamic SDK import is skipped.
   */
  readonly runtime?: SagemakerRuntimeLike;
}

/**
 * Read SageMaker config from the environment. Returns `null` when
 * `CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT` is unset, so the factory can fall
 * through to HTTP or ONNX on its own.
 */
export function readSagemakerEmbedderConfigFromEnv(): SagemakerEmbedderConfig | null {
  const endpointName = process.env["CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT"];
  if (endpointName === undefined || endpointName === "") return null;

  const region = process.env["CODEHUB_EMBEDDING_SAGEMAKER_REGION"];
  const modelIdOverride = process.env["CODEHUB_EMBEDDING_MODEL"];

  const rawDims = process.env["CODEHUB_EMBEDDING_DIMS"];
  let dims: number | undefined;
  if (rawDims !== undefined && rawDims !== "") {
    const parsed = Number.parseInt(rawDims, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`CODEHUB_EMBEDDING_DIMS must be a positive integer, got "${rawDims}"`);
    }
    dims = parsed;
  }

  const cfg: SagemakerEmbedderConfig = {
    endpointName,
    ...(region !== undefined && region !== "" ? { region } : {}),
    ...(modelIdOverride !== undefined && modelIdOverride !== ""
      ? { modelId: modelIdOverride }
      : {}),
    ...(dims !== undefined ? { dims } : {}),
  };
  return cfg;
}

/** AWS SDK v3 credential-missing error family — same shape as summarize.ts. */
function isMissingCredentialsError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  const e = err as { readonly name?: unknown; readonly message?: unknown };
  const name = typeof e.name === "string" ? e.name : "";
  if (
    name === "CredentialsProviderError" ||
    name === "NoCredentialsError" ||
    name === "ExpiredTokenException"
  ) {
    return true;
  }
  const message = typeof e.message === "string" ? e.message : "";
  return (
    message.includes("Could not load credentials") ||
    message.includes("credentials is missing") ||
    message.includes("Unable to load credentials") ||
    message.includes("The security token included in the request is expired")
  );
}

/** SageMaker's 413 equivalent — payload too large relative to endpoint limits. */
function isPayloadTooLargeError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  const e = err as { readonly name?: unknown; readonly $metadata?: { httpStatusCode?: number } };
  const name = typeof e.name === "string" ? e.name : "";
  if (name === "ValidationException" || name === "ModelError") return true;
  const status = e.$metadata?.httpStatusCode;
  return status === 413;
}

function isNumberMatrix(v: unknown): v is number[][] {
  if (!Array.isArray(v)) return false;
  for (const row of v) {
    if (!Array.isArray(row)) return false;
    for (const cell of row) {
      if (typeof cell !== "number") return false;
    }
  }
  return true;
}

/**
 * Public factory. Performs a dynamic SDK import (matching the repo's
 * Bedrock adapter in `packages/ingestion/src/pipeline/phases/summarize.ts`)
 * unless the caller supplied a runtime. On a credential-chain failure we
 * raise {@link EmbedderNotSetupError} so callers — notably
 * `tryOpenHttpEmbedder` — can fall back to ONNX or BM25.
 */
export async function openSagemakerEmbedder(cfg: SagemakerEmbedderConfig): Promise<Embedder> {
  const region = cfg.region ?? DEFAULT_REGION;
  const dims = cfg.dims ?? DEFAULT_DIMS;
  const endpointName = cfg.endpointName;
  const modelId = cfg.modelId ?? `gte-modernbert-base/sagemaker:${endpointName}`;
  const maxAttempts = cfg.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  let runtime: SagemakerRuntimeLike;
  interface InvokeInput {
    readonly EndpointName: string;
    readonly ContentType: string;
    readonly Accept: string;
    readonly Body: Uint8Array;
  }
  let InvokeEndpointCommand: new (input: InvokeInput) => { readonly input: InvokeInput };

  if (cfg.runtime !== undefined) {
    runtime = cfg.runtime;
    // Test path: construct a plain carrier object; `runtime.send` only reads
    // `.input`, so a class shim is unnecessary.
    InvokeEndpointCommand = class {
      readonly input: InvokeInput;
      constructor(input: InvokeInput) {
        this.input = input;
      }
    };
  } else {
    try {
      const mod = await import("@aws-sdk/client-sagemaker-runtime");
      runtime = new mod.SageMakerRuntimeClient({ region, maxAttempts });
      InvokeEndpointCommand = mod.InvokeEndpointCommand as unknown as typeof InvokeEndpointCommand;
    } catch (err) {
      if (isMissingCredentialsError(err)) {
        throw new EmbedderNotSetupError(
          `SageMaker embedder: AWS credentials are not configured. Set AWS_PROFILE ` +
            `or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, or unset ` +
            `CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT to use a different backend.`,
          { cause: err as Error },
        );
      }
      throw err;
    }
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  async function invokeOnce(chunk: readonly string[]): Promise<Float32Array[]> {
    const body = encoder.encode(JSON.stringify({ inputs: chunk }));
    const command = new InvokeEndpointCommand({
      EndpointName: endpointName,
      ContentType: "application/json",
      Accept: "application/json",
      Body: body,
    });
    let resp: { readonly Body?: Uint8Array };
    try {
      resp = await runtime.send(command);
    } catch (err) {
      if (isMissingCredentialsError(err)) {
        throw new EmbedderNotSetupError(
          `SageMaker embedder: AWS credentials not available when invoking ` +
            `endpoint "${endpointName}".`,
          { cause: err as Error },
        );
      }
      throw err;
    }
    if (resp.Body === undefined) {
      throw new Error(`SageMaker endpoint "${endpointName}" returned empty response body`);
    }
    const text = decoder.decode(resp.Body);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`SageMaker endpoint "${endpointName}" returned non-JSON body: ${reason}`);
    }
    if (!isNumberMatrix(parsed)) {
      throw new Error(
        `SageMaker endpoint "${endpointName}" returned a body that is not ` +
          `number[][] (got ${typeof parsed}). Expected TEI native format.`,
      );
    }
    if (parsed.length !== chunk.length) {
      throw new Error(
        `SageMaker endpoint "${endpointName}" returned ${parsed.length} ` +
          `rows for ${chunk.length} inputs.`,
      );
    }
    const out: Float32Array[] = [];
    for (const [i, row] of parsed.entries()) {
      if (row.length !== dims) {
        throw new Error(
          `SageMaker endpoint "${endpointName}" returned ${row.length}d ` +
            `vector at row ${i}, expected ${dims}d. Update CODEHUB_EMBEDDING_DIMS ` +
            `to match the endpoint's model output.`,
        );
      }
      out.push(new Float32Array(row));
    }
    return out;
  }

  async function invokeChunk(chunk: readonly string[]): Promise<Float32Array[]> {
    try {
      return await invokeOnce(chunk);
    } catch (err) {
      // One split-retry at size 1 on 413 / ValidationException. If a single
      // row still fails, surface the original error rather than looping.
      if (chunk.length > 1 && isPayloadTooLargeError(err)) {
        const rows: Float32Array[] = [];
        for (const text of chunk) {
          const [vec] = await invokeOnce([text]);
          if (vec === undefined) {
            throw new Error(
              `SageMaker endpoint "${endpointName}" returned no vector for ` +
                `a single-text retry after a 413 split.`,
            );
          }
          rows.push(vec);
        }
        return rows;
      }
      throw err;
    }
  }

  async function embedOne(text: string): Promise<Float32Array> {
    const [vec] = await invokeChunk([text]);
    if (vec === undefined) {
      throw new Error(
        `SageMaker endpoint "${endpointName}" returned no vector for a single input.`,
      );
    }
    return vec;
  }

  async function embedBatch(texts: readonly string[]): Promise<readonly Float32Array[]> {
    if (texts.length === 0) return [];
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const chunk = texts.slice(i, i + MAX_BATCH);
      const vecs = await invokeChunk(chunk);
      for (const v of vecs) out.push(v);
    }
    return out;
  }

  return {
    dim: dims,
    modelId,
    embed: embedOne,
    embedBatch,
    async close(): Promise<void> {
      // SageMakerRuntimeClient keeps an HTTP agent alive; destroy when
      // available, otherwise no-op.
      const destroyable = runtime as { destroy?: () => void };
      if (typeof destroyable.destroy === "function") destroyable.destroy();
    },
  };
}
