/**
 * Tests for the OpenAI-compatible HTTP embedder + the shared
 * {@link openEmbedder} factory.
 *
 * Coverage:
 *   - happy path: mock fetch returns a 768-d vector → Float32Array of 768
 *   - retry on 5xx × 2, then succeed
 *   - retry on network error × 2, then succeed
 *   - empty endpointUrl → ONNX path chosen (factory falls through;
 *     asserted indirectly by showing openEmbedder never calls fetchImpl)
 *   - offline=true with endpointUrl set → throws
 *   - dim mismatch → throws with clear message
 *   - env-var reader parses positive integers and rejects garbage
 */

import { deepEqual, equal, match, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  openEmbedder,
  openHttpEmbedder,
  readHttpEmbedderConfigFromEnv,
  tryOpenHttpEmbedder,
} from "./index.js";

/** Build a fetch mock that returns a JSON body with the given embedding. */
function makeFetchMockOk(embedding: readonly number[]): typeof fetch {
  return async (_url, _init): Promise<Response> => {
    return new Response(JSON.stringify({ data: [{ embedding }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

/**
 * Build a fetch mock that returns the sequence of responses supplied as
 * (status, body) tuples. After the sequence is exhausted the mock throws.
 * Useful for exercising the retry-on-5xx path.
 */
function makeFetchMockSeq(
  responses: readonly { readonly status: number; readonly body: unknown }[],
): { fetchImpl: typeof fetch; calls: () => number } {
  let i = 0;
  const fetchImpl: typeof fetch = async (_url, _init): Promise<Response> => {
    const r = responses[i];
    i += 1;
    if (r === undefined) {
      throw new Error(`fetch mock exhausted at call ${i}`);
    }
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls: () => i };
}

/**
 * Build a fetch mock that throws network errors for the first `failTimes`
 * calls and then returns the supplied success body.
 */
function makeFetchMockNetErrThenOk(
  failTimes: number,
  embedding: readonly number[],
): { fetchImpl: typeof fetch; calls: () => number } {
  let i = 0;
  const fetchImpl: typeof fetch = async (_url, _init): Promise<Response> => {
    i += 1;
    if (i <= failTimes) {
      throw new Error("ECONNREFUSED: mock network error");
    }
    return new Response(JSON.stringify({ data: [{ embedding }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls: () => i };
}

describe("openHttpEmbedder: happy path", () => {
  it("returns a Float32Array of the expected dim on a 200 response", async () => {
    const vec768 = Array.from({ length: 768 }, (_, i) => (i + 1) / 400);
    const fetchImpl = makeFetchMockOk(vec768);
    const embedder = openHttpEmbedder({
      endpointUrl: "https://embed.example/v1",
      modelId: "gte-modernbert-base",
      fetchImpl,
    });
    const out = await embedder.embed("hello world");
    equal(out.length, 768);
    equal(embedder.dim, 768);
    equal(embedder.modelId, "gte-modernbert-base");
    // Values round-trip as Float32 (so small precision loss is acceptable).
    ok(Math.abs((out[0] ?? 0) - (vec768[0] ?? 0)) < 1e-6);
    await embedder.close();
  });

  it("honours a caller-supplied `dims` value (non-768 remote)", async () => {
    const vec1024 = new Array<number>(1024).fill(0.125);
    const fetchImpl = makeFetchMockOk(vec1024);
    const embedder = openHttpEmbedder({
      endpointUrl: "http://localhost:7997",
      modelId: "bge-large-en-v1.5",
      dims: 1024,
      fetchImpl,
    });
    const out = await embedder.embed("foo");
    equal(out.length, 1024);
    equal(embedder.dim, 1024);
  });

  it("embedBatch preserves input order 1:1", async () => {
    let call = 0;
    const fetchImpl: typeof fetch = async (_url, _init) => {
      call += 1;
      // Distinct vector per call so we can verify order.
      const embedding = new Array<number>(768).fill(call / 100);
      return new Response(JSON.stringify({ data: [{ embedding }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const embedder = openHttpEmbedder({
      endpointUrl: "https://embed.example/v1",
      modelId: "m",
      fetchImpl,
    });
    const batch = await embedder.embedBatch(["a", "b", "c"]);
    equal(batch.length, 3);
    ok(Math.abs((batch[0]?.[0] ?? 0) - 0.01) < 1e-6);
    ok(Math.abs((batch[1]?.[0] ?? 0) - 0.02) < 1e-6);
    ok(Math.abs((batch[2]?.[0] ?? 0) - 0.03) < 1e-6);
  });

  it("strips trailing slashes from the base URL", async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (url, _init) => {
      seen.push(String(url));
      return new Response(
        JSON.stringify({ data: [{ embedding: new Array<number>(768).fill(0) }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const embedder = openHttpEmbedder({
      endpointUrl: "https://embed.example/v1/",
      modelId: "m",
      fetchImpl,
    });
    await embedder.embed("x");
    equal(seen.length, 1);
    equal(seen[0], "https://embed.example/v1/embeddings");
  });

  it("reuses a fully-qualified /embeddings URL rather than appending", async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (url, _init) => {
      seen.push(String(url));
      return new Response(
        JSON.stringify({ data: [{ embedding: new Array<number>(768).fill(0) }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const embedder = openHttpEmbedder({
      endpointUrl: "https://embed.example/v1/embeddings",
      modelId: "m",
      fetchImpl,
    });
    await embedder.embed("x");
    equal(seen[0], "https://embed.example/v1/embeddings");
  });
});

describe("openHttpEmbedder: retries", () => {
  it("retries on 5xx and succeeds on the third attempt", async () => {
    const embedding = new Array<number>(768).fill(0.1);
    const seq = makeFetchMockSeq([
      { status: 500, body: { error: "bad" } },
      { status: 503, body: { error: "busy" } },
      { status: 200, body: { data: [{ embedding }] } },
    ]);
    const embedder = openHttpEmbedder({
      endpointUrl: "https://embed.example/v1",
      modelId: "m",
      fetchImpl: seq.fetchImpl,
    });
    const out = await embedder.embed("x");
    equal(out.length, 768);
    equal(seq.calls(), 3, "must have retried twice before succeeding");
  });

  it("retries on 429 (rate limit) and succeeds on the third attempt", async () => {
    const embedding = new Array<number>(768).fill(0.2);
    const seq = makeFetchMockSeq([
      { status: 429, body: { error: "rate" } },
      { status: 429, body: { error: "rate" } },
      { status: 200, body: { data: [{ embedding }] } },
    ]);
    const embedder = openHttpEmbedder({
      endpointUrl: "https://embed.example/v1",
      modelId: "m",
      fetchImpl: seq.fetchImpl,
    });
    const out = await embedder.embed("x");
    equal(out.length, 768);
    equal(seq.calls(), 3);
  });

  it("surfaces a 4xx (non-429) without retry", async () => {
    const seq = makeFetchMockSeq([{ status: 400, body: { error: "bad input" } }]);
    const embedder = openHttpEmbedder({
      endpointUrl: "https://embed.example/v1",
      modelId: "m",
      fetchImpl: seq.fetchImpl,
    });
    await rejects(embedder.embed("x"), /returned 400/);
    equal(seq.calls(), 1, "4xx must not be retried");
  });

  it("retries on a thrown network error and succeeds on the third attempt", async () => {
    const seq = makeFetchMockNetErrThenOk(2, new Array<number>(768).fill(0));
    const embedder = openHttpEmbedder({
      endpointUrl: "https://embed.example/v1",
      modelId: "m",
      fetchImpl: seq.fetchImpl,
    });
    const out = await embedder.embed("x");
    equal(out.length, 768);
    equal(seq.calls(), 3);
  });

  it("surfaces a persistent network error after exhausting retries", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async (_url, _init) => {
      calls += 1;
      throw new Error("ECONNREFUSED");
    };
    const embedder = openHttpEmbedder({
      endpointUrl: "https://embed.example/v1",
      modelId: "m",
      fetchImpl,
    });
    await rejects(embedder.embed("x"), /Embedding request failed/);
    // Initial attempt + 2 retries = 3 total calls.
    equal(calls, 3, "must have attempted exactly 1 + HTTP_MAX_RETRIES times");
  });
});

describe("openHttpEmbedder: dim mismatch guard", () => {
  it("throws a clear error when the remote dim ≠ expected", async () => {
    const wrong = new Array<number>(1024).fill(0);
    const embedder = openHttpEmbedder({
      endpointUrl: "https://embed.example/v1",
      modelId: "m",
      dims: 768,
      fetchImpl: makeFetchMockOk(wrong),
    });
    await rejects(embedder.embed("x"), (err: unknown) => {
      ok(err instanceof Error);
      match(err.message, /Embedding dimension mismatch/);
      match(err.message, /1024d vector/);
      match(err.message, /expected 768d/);
      match(err.message, /CODEHUB_EMBEDDING_DIMS/);
      return true;
    });
  });

  it("uses 768 as the default expected dim when `dims` is omitted", async () => {
    const wrong = new Array<number>(1024).fill(0);
    const embedder = openHttpEmbedder({
      endpointUrl: "https://embed.example/v1",
      modelId: "m",
      fetchImpl: makeFetchMockOk(wrong),
    });
    await rejects(embedder.embed("x"), /expected 768d/);
  });
});

describe("openHttpEmbedder: auth header", () => {
  it("sends `Authorization: Bearer <key>` when apiKey is set", async () => {
    let seenAuth: string | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      const headers = new Headers(init?.headers);
      seenAuth = headers.get("authorization") ?? undefined;
      return new Response(
        JSON.stringify({ data: [{ embedding: new Array<number>(768).fill(0) }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const embedder = openHttpEmbedder({
      endpointUrl: "https://embed.example/v1",
      modelId: "m",
      apiKey: "sk-test-123",
      fetchImpl,
    });
    await embedder.embed("x");
    equal(seenAuth, "Bearer sk-test-123");
  });

  it("falls back to `unused` when apiKey is absent", async () => {
    let seenAuth: string | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      const headers = new Headers(init?.headers);
      seenAuth = headers.get("authorization") ?? undefined;
      return new Response(
        JSON.stringify({ data: [{ embedding: new Array<number>(768).fill(0) }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const embedder = openHttpEmbedder({
      endpointUrl: "https://embed.example/v1",
      modelId: "m",
      fetchImpl,
    });
    await embedder.embed("x");
    equal(seenAuth, "Bearer unused");
  });
});

describe("openHttpEmbedder: malformed body", () => {
  it("rejects a response body that is not shaped like { data: [...] }", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ weird: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const embedder = openHttpEmbedder({
      endpointUrl: "https://embed.example/v1",
      modelId: "m",
      fetchImpl,
    });
    await rejects(embedder.embed("x"), /malformed body/);
  });

  it("rejects a response body whose `data` array is empty", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const embedder = openHttpEmbedder({
      endpointUrl: "https://embed.example/v1",
      modelId: "m",
      fetchImpl,
    });
    await rejects(embedder.embed("x"), /empty data array/);
  });
});

// ────────────────────────────────────────────────────────────────────
// readHttpEmbedderConfigFromEnv
// ────────────────────────────────────────────────────────────────────

describe("readHttpEmbedderConfigFromEnv", () => {
  let originals: Record<string, string | undefined>;

  beforeEach(() => {
    originals = {
      url: process.env["CODEHUB_EMBEDDING_URL"],
      model: process.env["CODEHUB_EMBEDDING_MODEL"],
      dims: process.env["CODEHUB_EMBEDDING_DIMS"],
      key: process.env["CODEHUB_EMBEDDING_API_KEY"],
    };
    delete process.env["CODEHUB_EMBEDDING_URL"];
    delete process.env["CODEHUB_EMBEDDING_MODEL"];
    delete process.env["CODEHUB_EMBEDDING_DIMS"];
    delete process.env["CODEHUB_EMBEDDING_API_KEY"];
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(originals)) {
      const envKey = `CODEHUB_EMBEDDING_${k === "key" ? "API_KEY" : k.toUpperCase()}`;
      if (v === undefined) delete process.env[envKey];
      else process.env[envKey] = v;
    }
  });

  it("returns null when URL or MODEL is unset", () => {
    strictEqual(readHttpEmbedderConfigFromEnv(), null);
    process.env["CODEHUB_EMBEDDING_URL"] = "https://embed.example/v1";
    strictEqual(readHttpEmbedderConfigFromEnv(), null);
  });

  it("returns config when URL + MODEL are set", () => {
    process.env["CODEHUB_EMBEDDING_URL"] = "https://embed.example/v1";
    process.env["CODEHUB_EMBEDDING_MODEL"] = "m";
    const cfg = readHttpEmbedderConfigFromEnv();
    ok(cfg !== null);
    equal(cfg.endpointUrl, "https://embed.example/v1");
    equal(cfg.modelId, "m");
    equal(cfg.dims, undefined);
    equal(cfg.apiKey, undefined);
  });

  it("parses DIMS as a positive integer", () => {
    process.env["CODEHUB_EMBEDDING_URL"] = "https://embed.example/v1";
    process.env["CODEHUB_EMBEDDING_MODEL"] = "m";
    process.env["CODEHUB_EMBEDDING_DIMS"] = "1024";
    const cfg = readHttpEmbedderConfigFromEnv();
    ok(cfg !== null);
    equal(cfg.dims, 1024);
  });

  it("rejects non-numeric DIMS", () => {
    process.env["CODEHUB_EMBEDDING_URL"] = "https://embed.example/v1";
    process.env["CODEHUB_EMBEDDING_MODEL"] = "m";
    process.env["CODEHUB_EMBEDDING_DIMS"] = "not-a-number";
    throws(() => readHttpEmbedderConfigFromEnv(), /positive integer/);
  });

  it("rejects non-positive DIMS", () => {
    process.env["CODEHUB_EMBEDDING_URL"] = "https://embed.example/v1";
    process.env["CODEHUB_EMBEDDING_MODEL"] = "m";
    process.env["CODEHUB_EMBEDDING_DIMS"] = "0";
    throws(() => readHttpEmbedderConfigFromEnv(), /positive integer/);
  });

  it("picks up the API key", () => {
    process.env["CODEHUB_EMBEDDING_URL"] = "https://embed.example/v1";
    process.env["CODEHUB_EMBEDDING_MODEL"] = "m";
    process.env["CODEHUB_EMBEDDING_API_KEY"] = "sk-abc";
    const cfg = readHttpEmbedderConfigFromEnv();
    ok(cfg !== null);
    equal(cfg.apiKey, "sk-abc");
  });
});

// ────────────────────────────────────────────────────────────────────
// openEmbedder factory
// ────────────────────────────────────────────────────────────────────

describe("openEmbedder factory", () => {
  it("picks HTTP when endpointUrl is set", async () => {
    const embedder = await openEmbedder({
      endpointUrl: "https://embed.example/v1",
      modelId: "m",
      fetchImpl: makeFetchMockOk(new Array<number>(768).fill(0.5)),
    });
    const out = await embedder.embed("x");
    equal(out.length, 768);
  });

  it("throws when offline=true AND endpointUrl is set", async () => {
    await rejects(
      openEmbedder({
        offline: true,
        endpointUrl: "https://embed.example/v1",
        modelId: "m",
      }),
      /offline mode/,
    );
  });

  it("does not throw when offline=true AND endpointUrl is empty string", async () => {
    // Empty endpointUrl is treated as "not set" — the factory falls through
    // to ONNX. We expect the ONNX open to fail with a setup error because
    // we point CODEHUB_HOME at a tmp dir without weights; any error is
    // fine as long as it is NOT the offline-mode guard.
    const originalHome = process.env["CODEHUB_HOME"];
    process.env["CODEHUB_HOME"] = "/tmp/codehub-open-embedder-test-no-weights";
    try {
      await rejects(
        openEmbedder({ offline: true, endpointUrl: "", modelId: "m" }),
        (err: unknown) => {
          ok(err instanceof Error);
          // Must NOT be the offline-mode guard error.
          ok(!/offline mode/.test(err.message), `expected ONNX-path error, got ${err.message}`);
          return true;
        },
      );
    } finally {
      if (originalHome === undefined) {
        delete process.env["CODEHUB_HOME"];
      } else {
        process.env["CODEHUB_HOME"] = originalHome;
      }
    }
  });

  it("throws when endpointUrl is set but modelId is missing", async () => {
    await rejects(openEmbedder({ endpointUrl: "https://embed.example/v1" }), /modelId/);
  });
});

describe("tryOpenHttpEmbedder", () => {
  let originals: Record<string, string | undefined>;

  beforeEach(() => {
    originals = {
      url: process.env["CODEHUB_EMBEDDING_URL"],
      model: process.env["CODEHUB_EMBEDDING_MODEL"],
    };
    delete process.env["CODEHUB_EMBEDDING_URL"];
    delete process.env["CODEHUB_EMBEDDING_MODEL"];
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(originals)) {
      const envKey = `CODEHUB_EMBEDDING_${k.toUpperCase()}`;
      if (v === undefined) delete process.env[envKey];
      else process.env[envKey] = v;
    }
  });

  it("returns null when env is not configured", () => {
    strictEqual(tryOpenHttpEmbedder(), null);
  });

  it("returns an Embedder when env is configured", async () => {
    process.env["CODEHUB_EMBEDDING_URL"] = "https://embed.example/v1";
    process.env["CODEHUB_EMBEDDING_MODEL"] = "m";
    const fetchImpl = makeFetchMockOk(new Array<number>(768).fill(0));
    const embedder = await tryOpenHttpEmbedder({ fetchImpl });
    ok(embedder !== null);
    const out = await embedder.embed("x");
    equal(out.length, 768);
  });

  it("throws when offline AND env is configured", () => {
    process.env["CODEHUB_EMBEDDING_URL"] = "https://embed.example/v1";
    process.env["CODEHUB_EMBEDDING_MODEL"] = "m";
    throws(() => tryOpenHttpEmbedder({ offline: true }), /offline mode/);
  });

  it("returns null when offline AND env is NOT configured", () => {
    // Offline + no env: the env-less caller is free to continue to ONNX.
    strictEqual(tryOpenHttpEmbedder({ offline: true }), null);
  });
});

describe("Embedder contract via HTTP", () => {
  it("close() is idempotent", async () => {
    const embedder = openHttpEmbedder({
      endpointUrl: "https://embed.example/v1",
      modelId: "m",
      fetchImpl: makeFetchMockOk(new Array<number>(768).fill(0)),
    });
    await embedder.close();
    await embedder.close();
  });

  it("embedBatch on an empty array returns an empty array without calling fetch", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      throw new Error("should not be called");
    };
    const embedder = openHttpEmbedder({
      endpointUrl: "https://embed.example/v1",
      modelId: "m",
      fetchImpl,
    });
    const batch = await embedder.embedBatch([]);
    equal(batch.length, 0);
    equal(calls, 0);
    deepEqual(batch, []);
  });
});
