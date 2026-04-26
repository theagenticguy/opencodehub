/**
 * Embedder tests — defensive. Weights are installed out-of-band by
 * `codehub setup --embeddings`, so these tests exercise two paths:
 *
 *   1. Missing weights → {@link EmbedderNotSetupError} with the expected
 *      `code` literal. Guarantees the CLI and search layer can pattern-match
 *      the error to degrade to BM25-only.
 *   2. Real weights present → byte-identical output across three repeat
 *      calls + L2 norm ≈ 1 + dim === 768. Only runs when the cache dir is
 *      populated. CI does NOT populate this dir.
 *
 * When weights are absent we also run a mock-based check of the Embedder
 * contract (dim=768, embedBatch preserves input order, close() is
 * idempotent) so the interface is covered unconditionally.
 */

import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { embedderModelId, modelFileName, resolveModelDir, TOKENIZER_FILES } from "./index.js";
import { openOnnxEmbedder } from "./onnx-embedder.js";
import { type Embedder, EmbedderNotSetupError } from "./types.js";

// ─────────────────────────────────────────────────────────────────────
// Section 1 — error surface for missing weights
// ─────────────────────────────────────────────────────────────────────

describe("openOnnxEmbedder: missing weights", () => {
  const originalHome = process.env["CODEHUB_HOME"];

  beforeEach(() => {
    // Point at a tmp dir guaranteed not to contain weights so the test is
    // hermetic even on a dev machine that HAS model files installed.
    process.env["CODEHUB_HOME"] = join(
      tmpdir(),
      `codehub-embedder-test-${process.pid}-${Date.now()}`,
    );
  });
  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env["CODEHUB_HOME"];
    } else {
      process.env["CODEHUB_HOME"] = originalHome;
    }
  });

  it("throws EmbedderNotSetupError with the expected code", async () => {
    await rejects(openOnnxEmbedder(), (err: unknown) => {
      ok(err instanceof EmbedderNotSetupError, "expected EmbedderNotSetupError");
      equal(err.code, "EMBEDDER_NOT_SETUP");
      equal(err.name, "EmbedderNotSetupError");
      ok(
        err.message.includes("codehub setup --embeddings"),
        "message should point at the setup command",
      );
      return true;
    });
  });

  it("throws EmbedderNotSetupError for int8 too", async () => {
    await rejects(
      openOnnxEmbedder({ variant: "int8" }),
      (err: unknown) => err instanceof EmbedderNotSetupError,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// Section 2 — mock embedder to verify interface contract
// ─────────────────────────────────────────────────────────────────────

/**
 * A hand-rolled `Embedder` used when real weights are unavailable. Its
 * `embed` produces a deterministic fake vector (index-based) so we can still
 * exercise the downstream contract: L2 norm ≈ 1, dim=768, embedBatch
 * preserves order, close() is idempotent.
 */
class MockEmbedder implements Embedder {
  readonly dim = 768;
  readonly modelId = embedderModelId("fp32");
  #closed = false;

  async embed(text: string): Promise<Float32Array> {
    if (this.#closed) throw new Error("closed");
    const vec = new Float32Array(this.dim);
    let seed = 0;
    for (let i = 0; i < text.length; i++) {
      seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
    }
    // Use the seed to fill deterministic values, then L2-normalize.
    let state = seed || 1;
    for (let i = 0; i < this.dim; i++) {
      state = (state * 1664525 + 1013904223) >>> 0;
      vec[i] = (state / 0xffffffff) * 2 - 1;
    }
    let sum = 0;
    for (let i = 0; i < this.dim; i++) {
      const v = vec[i] ?? 0;
      sum += v * v;
    }
    const inv = 1 / Math.sqrt(sum);
    for (let i = 0; i < this.dim; i++) {
      vec[i] = (vec[i] ?? 0) * inv;
    }
    return vec;
  }

  async embedBatch(texts: readonly string[]): Promise<readonly Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}

function l2Norm(v: Float32Array): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i] ?? 0;
    s += x * x;
  }
  return Math.sqrt(s);
}

describe("Embedder contract (mocked)", () => {
  it("satisfies the Embedder interface shape", () => {
    const m = new MockEmbedder();
    // Static type check: `m satisfies Embedder` is enforced by the class
    // declaration. Here we re-check at runtime.
    equal(m.dim, 768);
    equal(m.modelId, "gte-modernbert-base/fp32");
    equal(typeof m.embed, "function");
    equal(typeof m.embedBatch, "function");
    equal(typeof m.close, "function");
  });

  it("dim === 768", async () => {
    const m = new MockEmbedder();
    const v = await m.embed("hello world");
    equal(v.length, 768);
  });

  it("L2 norm is ~1 (within 1e-6)", async () => {
    const m = new MockEmbedder();
    const v = await m.embed("the quick brown fox");
    const n = l2Norm(v);
    ok(Math.abs(n - 1) < 1e-6, `expected unit norm, got ${n}`);
  });

  it("embedBatch preserves input order 1:1", async () => {
    const m = new MockEmbedder();
    const texts = ["alpha", "beta", "gamma"];
    const batch = await m.embedBatch(texts);
    equal(batch.length, 3);
    // Each element should equal the single-call embed() for the same text.
    for (let i = 0; i < texts.length; i++) {
      const single = await m.embed(texts[i] as string);
      const fromBatch = batch[i];
      ok(fromBatch !== undefined);
      deepEqual(Array.from(fromBatch), Array.from(single));
    }
  });

  it("close() is idempotent", async () => {
    const m = new MockEmbedder();
    await m.close();
    await m.close();
  });

  it("repeat embed() calls are byte-identical for the same input", async () => {
    const m = new MockEmbedder();
    const text = "the quick brown fox";
    const a = await m.embed(text);
    const b = await m.embed(text);
    const c = await m.embed(text);
    deepEqual(new Uint8Array(a.buffer), new Uint8Array(b.buffer));
    deepEqual(new Uint8Array(a.buffer), new Uint8Array(c.buffer));
  });
});

// ─────────────────────────────────────────────────────────────────────
// Section 3 — real ONNX path, gated on weights being present
// ─────────────────────────────────────────────────────────────────────

async function hasRealWeights(): Promise<boolean> {
  const dir = resolveModelDir(undefined, "fp32");
  const required = [modelFileName("fp32"), ...TOKENIZER_FILES];
  try {
    for (const f of required) {
      await access(join(dir, f));
    }
    return true;
  } catch {
    return false;
  }
}

describe("OnnxEmbedder: real weights (optional)", () => {
  it("produces byte-identical vectors across 3 calls and has dim=768", async (t) => {
    if (!(await hasRealWeights())) {
      t.skip("gte-modernbert-base weights not installed — run `codehub setup --embeddings`");
      return;
    }
    let embedder: Embedder | undefined;
    try {
      embedder = await openOnnxEmbedder();
      const text = "function login(user: string, password: string): boolean";
      const a = await embedder.embed(text);
      const b = await embedder.embed(text);
      const c = await embedder.embed(text);
      equal(a.length, 768);
      equal(embedder.dim, 768);
      equal(embedder.modelId, "gte-modernbert-base/fp32");
      deepEqual(new Uint8Array(a.buffer), new Uint8Array(b.buffer));
      deepEqual(new Uint8Array(a.buffer), new Uint8Array(c.buffer));

      const n = l2Norm(a);
      ok(Math.abs(n - 1) < 1e-4, `expected unit norm, got ${n}`);
    } finally {
      if (embedder !== undefined) {
        await embedder.close();
      }
    }
  });
});
