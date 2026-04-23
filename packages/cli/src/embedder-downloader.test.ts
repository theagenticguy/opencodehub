/**
 * Tests for the SHA256-pinned embedder downloader.
 *
 * Every test injects a fake fetch — we never hit the real network. The
 * matrix covers:
 *  - Happy path: one byte body, verified SHA256, atomic rename.
 *  - Idempotency: second call with same pin → skipped.
 *  - SHA mismatch aborts + cleans up the tmp file.
 *  - ECONNRESET retry: two failures followed by a success → three attempts.
 */

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadableStream } from "node:stream/web";
import { describe, it } from "node:test";

import { ARCTIC_EMBED_XS_PINS } from "@opencodehub/embedder";

import {
  downloadEmbedderWeights,
  type FetchFn,
  Sha256MismatchError,
} from "./embedder-downloader.js";

function sha256(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Build a minimal fake Response with a single-chunk body that supports the
 * streaming `ReadableStream` consumer used by the downloader.
 */
function makeResponse(status: number, body: Uint8Array | null): Response {
  const headers = new Headers();
  if (status === 200 && body !== null) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(body);
        controller.close();
      },
    });
    // Node's Response constructor accepts the node:stream/web ReadableStream.
    // The DOM types differ; we coerce via unknown since the runtime shape is
    // identical.
    // Node's fetch accepts a web ReadableStream; coerce past the DOM type.
    return new Response(stream as unknown as ConstructorParameters<typeof Response>[0], {
      status,
      headers,
    });
  }
  return new Response(null, { status, headers });
}

/**
 * Build a fake fetch that maps each pinned file's URL to a synthetic body
 * whose SHA256 we override in the pin manifest. Returns `{ fetch, calls }`
 * where `calls` records URLs requested in order.
 */
function makeFetchWith(
  bodies: Map<string, Uint8Array>,
  errorAfter?: { url: string; error: NodeJS.ErrnoException; times: number },
): { fetch: FetchFn; calls: string[] } {
  const calls: string[] = [];
  let remainingErrors = errorAfter?.times ?? 0;
  const fetchImpl: FetchFn = async (input): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : // Request object — fall back to its url property.
            (input as unknown as { url: string }).url;
    calls.push(url);
    if (errorAfter !== undefined && url === errorAfter.url && remainingErrors > 0) {
      remainingErrors -= 1;
      throw errorAfter.error;
    }
    const body = bodies.get(url);
    if (body === undefined) {
      return makeResponse(404, null);
    }
    return makeResponse(200, body);
  };
  return { fetch: fetchImpl, calls };
}

/**
 * Monkeypatch ARCTIC_EMBED_XS_PINS[variant] for a single test. Because the
 * pins are `readonly`, we rebuild the structure by casting into a mutable
 * shape. The test restores on completion.
 */
function withOverridePins<T>(
  variant: "fp32" | "int8",
  newFiles: readonly { name: string; url: string; sizeBytes: number; sha256: string }[],
  fn: () => Promise<T>,
): Promise<T> {
  const original = ARCTIC_EMBED_XS_PINS[variant];
  const mutable = ARCTIC_EMBED_XS_PINS as unknown as {
    [k in "fp32" | "int8"]: {
      variant: "fp32" | "int8";
      files: readonly { name: string; url: string; sizeBytes: number; sha256: string }[];
    };
  };
  mutable[variant] = { variant, files: newFiles };
  return fn().finally(() => {
    mutable[variant] = original;
  });
}

describe("downloadEmbedderWeights", () => {
  it("downloads a pinned file, verifies SHA256, and atomically renames", async () => {
    const dir = await mkdtemp(join(tmpdir(), "och-dl-happy-"));
    try {
      const body = new TextEncoder().encode("hello-arctic-xs");
      const url = "https://example.test/fp32/model.onnx";
      const pins = [{ name: "model.onnx", url, sizeBytes: body.length, sha256: sha256(body) }];
      const { fetch: fakeFetch, calls } = makeFetchWith(new Map([[url, body]]));

      const result = await withOverridePins("fp32", pins, async () =>
        downloadEmbedderWeights({
          variant: "fp32",
          modelDir: dir,
          fetchImpl: fakeFetch,
        }),
      );

      assert.equal(result.downloaded, 1);
      assert.equal(result.skipped, 0);
      assert.equal(result.totalBytes, body.length);
      assert.equal(calls.length, 1);

      const written = await readFile(join(dir, "model.onnx"));
      assert.deepEqual(new Uint8Array(written), body);
      // No stray tmp files left behind.
      const entries = await readdir(dir);
      assert.deepEqual(entries.sort(), ["model.onnx"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is idempotent — a second call with matching SHA256 skips every file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "och-dl-idem-"));
    try {
      const body = new TextEncoder().encode("bytes-for-idempotency");
      const url = "https://example.test/fp32/model.onnx";
      const pins = [{ name: "model.onnx", url, sizeBytes: body.length, sha256: sha256(body) }];
      const { fetch: fakeFetch, calls } = makeFetchWith(new Map([[url, body]]));

      await withOverridePins("fp32", pins, async () => {
        const first = await downloadEmbedderWeights({
          variant: "fp32",
          modelDir: dir,
          fetchImpl: fakeFetch,
        });
        assert.equal(first.downloaded, 1);

        const second = await downloadEmbedderWeights({
          variant: "fp32",
          modelDir: dir,
          fetchImpl: fakeFetch,
        });
        assert.equal(second.downloaded, 0);
        assert.equal(second.skipped, 1);
      });

      // Only the first call's fetch should have been invoked — the second run
      // skipped without touching the network.
      assert.equal(calls.length, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("force=true re-downloads even when the on-disk SHA256 already matches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "och-dl-force-"));
    try {
      const body = new TextEncoder().encode("force-re-download");
      const url = "https://example.test/fp32/model.onnx";
      const pins = [{ name: "model.onnx", url, sizeBytes: body.length, sha256: sha256(body) }];
      const { fetch: fakeFetch, calls } = makeFetchWith(new Map([[url, body]]));
      await withOverridePins("fp32", pins, async () => {
        await downloadEmbedderWeights({
          variant: "fp32",
          modelDir: dir,
          fetchImpl: fakeFetch,
        });
        const forced = await downloadEmbedderWeights({
          variant: "fp32",
          modelDir: dir,
          fetchImpl: fakeFetch,
          force: true,
        });
        assert.equal(forced.downloaded, 1);
        assert.equal(forced.skipped, 0);
      });
      assert.equal(calls.length, 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("aborts on SHA256 mismatch, deletes tmp, and surfaces the expected/actual", async () => {
    const dir = await mkdtemp(join(tmpdir(), "och-dl-badsha-"));
    try {
      const served = new TextEncoder().encode("actual-bytes");
      const url = "https://example.test/fp32/model.onnx";
      // Pin a SHA for different bytes so the verification fails.
      const wrongSha = sha256(new TextEncoder().encode("expected-bytes"));
      const pins = [{ name: "model.onnx", url, sizeBytes: served.length, sha256: wrongSha }];
      const { fetch: fakeFetch } = makeFetchWith(new Map([[url, served]]));

      await withOverridePins("fp32", pins, async () => {
        await assert.rejects(
          () =>
            downloadEmbedderWeights({
              variant: "fp32",
              modelDir: dir,
              fetchImpl: fakeFetch,
              maxRetries: 1,
            }),
          (err: unknown) => {
            assert.ok(err instanceof Sha256MismatchError, "expected Sha256MismatchError");
            const e = err as Sha256MismatchError;
            assert.equal(e.fileName, "model.onnx");
            assert.equal(e.expected, wrongSha);
            assert.equal(e.actual, sha256(served));
            return true;
          },
        );
      });

      const entries = await readdir(dir);
      // Neither the .tmp nor the final path must survive.
      assert.ok(!entries.includes("model.onnx.tmp"), ".tmp should be cleaned up");
      assert.ok(!entries.includes("model.onnx"), "final file should not exist");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("retries transient errors up to maxRetries then succeeds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "och-dl-retry-"));
    try {
      const body = new TextEncoder().encode("after-two-retries");
      const url = "https://example.test/fp32/model.onnx";
      const pins = [{ name: "model.onnx", url, sizeBytes: body.length, sha256: sha256(body) }];
      const econnreset: NodeJS.ErrnoException = Object.assign(new Error("socket hang up"), {
        code: "ECONNRESET",
      });
      const { fetch: fakeFetch, calls } = makeFetchWith(new Map([[url, body]]), {
        url,
        error: econnreset,
        times: 2,
      });

      const result = await withOverridePins("fp32", pins, async () =>
        downloadEmbedderWeights({
          variant: "fp32",
          modelDir: dir,
          fetchImpl: fakeFetch,
          maxRetries: 3,
          backoffMs: [1, 1, 1],
        }),
      );

      // Three attempts total: two failures + one success.
      assert.equal(calls.length, 3);
      assert.equal(result.downloaded, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips on-disk file that matches SHA256 (no fetch call)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "och-dl-preexist-"));
    try {
      const body = new TextEncoder().encode("pre-existing-bytes");
      const url = "https://example.test/fp32/model.onnx";
      const pins = [{ name: "model.onnx", url, sizeBytes: body.length, sha256: sha256(body) }];
      await writeFile(join(dir, "model.onnx"), body);

      const { fetch: fakeFetch, calls } = makeFetchWith(new Map());

      const result = await withOverridePins("fp32", pins, async () =>
        downloadEmbedderWeights({
          variant: "fp32",
          modelDir: dir,
          fetchImpl: fakeFetch,
        }),
      );
      assert.equal(result.downloaded, 0);
      assert.equal(result.skipped, 1);
      assert.equal(calls.length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns totalBytes equal to the sum of newly downloaded sizes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "och-dl-total-"));
    try {
      const a = new TextEncoder().encode("a".repeat(10));
      const b = new TextEncoder().encode("b".repeat(25));
      const pins = [
        {
          name: "a.onnx",
          url: "https://example.test/a",
          sizeBytes: a.length,
          sha256: sha256(a),
        },
        {
          name: "tokenizer.json",
          url: "https://example.test/tok",
          sizeBytes: b.length,
          sha256: sha256(b),
        },
      ];
      const { fetch: fakeFetch } = makeFetchWith(
        new Map([
          ["https://example.test/a", a],
          ["https://example.test/tok", b],
        ]),
      );
      const result = await withOverridePins("fp32", pins, async () =>
        downloadEmbedderWeights({
          variant: "fp32",
          modelDir: dir,
          fetchImpl: fakeFetch,
        }),
      );
      assert.equal(result.totalBytes, a.length + b.length);
      assert.equal(result.downloaded, 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
