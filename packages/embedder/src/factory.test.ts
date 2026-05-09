/**
 * Tests for {@link openDefaultEmbedder} — the shared HTTP-priority +
 * ONNX-fallback factory used by the CLI and MCP query call sites.
 *
 * Branches covered:
 *   1. HTTP env vars set → returns the HTTP embedder (sentinel).
 *   2. HTTP env vars absent + `allowOnnxFallback: true` (default) → returns
 *      the ONNX embedder (sentinel).
 *   3. HTTP env vars absent + `allowOnnxFallback: false` → throws
 *      {@link EmbedderNotSetupError}; ONNX path is never invoked.
 *   4. HTTP env vars absent + ONNX setup fails → propagates the underlying
 *      error (no swallowing, no wrapping).
 *
 * Dependency injection (the second `deps` arg) keeps the test pure: no
 * tempdirs, no env-var manipulation, no real ONNX session.
 */

import { equal, ok, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { openDefaultEmbedder } from "./factory.js";
import { type Embedder, EmbedderNotSetupError } from "./types.js";

/** Build a sentinel Embedder whose identity we can assert against. */
function makeSentinelEmbedder(modelId: string): Embedder {
  return {
    dim: 768,
    modelId,
    embed: async () => new Float32Array(768),
    embedBatch: async (texts) => texts.map(() => new Float32Array(768)),
    close: async () => {},
  };
}

describe("openDefaultEmbedder", () => {
  it("returns the HTTP embedder when env vars are set", async () => {
    const httpSentinel = makeSentinelEmbedder("remote/http");
    const result = await openDefaultEmbedder(
      {},
      {
        tryOpenHttp: () => httpSentinel,
        openOnnx: async () => {
          throw new Error("openOnnx must not be called when HTTP is configured");
        },
      },
    );
    strictEqual(result, httpSentinel, "factory should return the HTTP embedder reference");
    equal(result.modelId, "remote/http");
  });

  it("falls back to ONNX when no HTTP env vars and allowOnnxFallback defaults to true", async () => {
    const onnxSentinel = makeSentinelEmbedder("gte-modernbert-base/fp32");
    const result = await openDefaultEmbedder(
      {},
      {
        tryOpenHttp: () => null,
        openOnnx: async () => onnxSentinel,
      },
    );
    strictEqual(result, onnxSentinel, "factory should return the ONNX embedder reference");
    equal(result.modelId, "gte-modernbert-base/fp32");
  });

  it("throws EmbedderNotSetupError when HTTP env vars absent and allowOnnxFallback=false", async () => {
    let onnxCalled = false;
    await rejects(
      openDefaultEmbedder(
        { allowOnnxFallback: false },
        {
          tryOpenHttp: () => null,
          openOnnx: async () => {
            onnxCalled = true;
            return makeSentinelEmbedder("should-not-be-reached");
          },
        },
      ),
      (err: unknown) => {
        ok(err instanceof EmbedderNotSetupError, "expected EmbedderNotSetupError");
        equal(err.code, "EMBEDDER_NOT_SETUP");
        ok(
          err.message.includes("allowOnnxFallback") ||
            err.message.includes("CODEHUB_EMBEDDING_URL"),
          "message should mention the option or the env var",
        );
        return true;
      },
    );
    equal(onnxCalled, false, "openOnnx must not be invoked when fallback is disabled");
  });

  it("propagates the underlying error when ONNX setup fails", async () => {
    const onnxFailure = new EmbedderNotSetupError(
      "Run `codehub setup --embeddings` to install gte-modernbert-base",
    );
    await rejects(
      openDefaultEmbedder(
        {},
        {
          tryOpenHttp: () => null,
          openOnnx: async () => {
            throw onnxFailure;
          },
        },
      ),
      (err: unknown) => {
        strictEqual(err, onnxFailure, "factory should re-throw the original error");
        return true;
      },
    );
  });
});
