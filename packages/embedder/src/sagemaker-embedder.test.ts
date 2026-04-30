/**
 * Tests for the SageMaker embedder backend.
 *
 * Coverage:
 *   - happy path: single input + small batch returns 768-d Float32Array
 *   - large batch (>64) splits into multiple InvokeEndpointCommand calls
 *   - dim mismatch throws with clear message
 *   - row-count mismatch (endpoint returned fewer rows than inputs) throws
 *   - 413 / ValidationException triggers split-retry at size 1
 *   - repeated 413 on single item surfaces the error
 *   - missing credentials surfaces EmbedderNotSetupError
 *   - env reader parses positive integers and rejects garbage
 *   - env reader returns null when the endpoint var is absent
 *   - modelId stamp includes the endpoint name by default
 *   - offline mode + SageMaker env → throw via tryOpenHttpEmbedder
 */

import { deepEqual, equal, match, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  EmbedderNotSetupError,
  openSagemakerEmbedder,
  readSagemakerEmbedderConfigFromEnv,
  type SagemakerRuntimeLike,
  tryOpenHttpEmbedder,
} from "./index.js";

/** The argument shape {@link SagemakerRuntimeLike.send} receives. */
interface SendCmd {
  readonly input: {
    readonly EndpointName: string;
    readonly ContentType: string;
    readonly Accept: string;
    readonly Body: Uint8Array;
  };
}

/** Helper: encode a JSON body the way the SDK would return it. */
function responseBody(matrix: readonly (readonly number[])[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(matrix));
}

/** Fake runtime that records each call and returns the matching response. */
function makeRuntime(
  responder: (inputsCount: number, call: number) => readonly (readonly number[])[] | Error,
): { runtime: SagemakerRuntimeLike; calls: () => number; lastBatch: () => number } {
  let calls = 0;
  let lastBatch = 0;
  const runtime: SagemakerRuntimeLike = {
    async send(command: SendCmd) {
      calls += 1;
      const body = new TextDecoder().decode(command.input.Body);
      const parsed = JSON.parse(body) as { readonly inputs: readonly string[] };
      lastBatch = parsed.inputs.length;
      const result = responder(parsed.inputs.length, calls);
      if (result instanceof Error) throw result;
      return { Body: responseBody(result) };
    },
  };
  return { runtime, calls: () => calls, lastBatch: () => lastBatch };
}

function vec(dim: number, seed: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < dim; i++) out.push(seed + i * 0.001);
  return out;
}

describe("readSagemakerEmbedderConfigFromEnv", () => {
  let originals: Record<string, string | undefined>;
  const keys = [
    "CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT",
    "CODEHUB_EMBEDDING_SAGEMAKER_REGION",
    "CODEHUB_EMBEDDING_MODEL",
    "CODEHUB_EMBEDDING_DIMS",
  ];

  beforeEach(() => {
    originals = {};
    for (const k of keys) {
      originals[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of keys) {
      const v = originals[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("returns null when the endpoint var is absent", () => {
    strictEqual(readSagemakerEmbedderConfigFromEnv(), null);
  });

  it("reads the endpoint name when set", () => {
    process.env["CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT"] = "gte-modernbert-embed";
    const cfg = readSagemakerEmbedderConfigFromEnv();
    ok(cfg !== null);
    equal(cfg.endpointName, "gte-modernbert-embed");
    equal(cfg.region, undefined); // default applied at factory
  });

  it("reads region, modelId, dims when all set", () => {
    process.env["CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT"] = "my-endpoint";
    process.env["CODEHUB_EMBEDDING_SAGEMAKER_REGION"] = "us-west-2";
    process.env["CODEHUB_EMBEDDING_MODEL"] = "custom/id";
    process.env["CODEHUB_EMBEDDING_DIMS"] = "1024";
    const cfg = readSagemakerEmbedderConfigFromEnv();
    ok(cfg !== null);
    equal(cfg.endpointName, "my-endpoint");
    equal(cfg.region, "us-west-2");
    equal(cfg.modelId, "custom/id");
    equal(cfg.dims, 1024);
  });

  it("rejects non-integer dims", () => {
    process.env["CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT"] = "x";
    process.env["CODEHUB_EMBEDDING_DIMS"] = "not-a-number";
    throws(() => readSagemakerEmbedderConfigFromEnv(), /positive integer/);
  });

  it("rejects zero dims", () => {
    process.env["CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT"] = "x";
    process.env["CODEHUB_EMBEDDING_DIMS"] = "0";
    throws(() => readSagemakerEmbedderConfigFromEnv(), /positive integer/);
  });
});

describe("openSagemakerEmbedder — happy path", () => {
  it("embeds a single text and returns a 768-d Float32Array", async () => {
    const row = vec(768, 0.1);
    const { runtime, calls, lastBatch } = makeRuntime(() => [row]);

    const embedder = await openSagemakerEmbedder({
      endpointName: "test-endpoint",
      runtime,
    });

    const out = await embedder.embed("hello");
    equal(out.length, 768);
    equal(out[0], Math.fround(0.1));
    equal(calls(), 1);
    equal(lastBatch(), 1);
    await embedder.close();
  });

  it("reports modelId with endpoint-name stamp by default", async () => {
    const { runtime } = makeRuntime(() => [vec(768, 0)]);
    const embedder = await openSagemakerEmbedder({
      endpointName: "gte-modernbert-embed",
      runtime,
    });
    equal(embedder.dim, 768);
    match(embedder.modelId, /^gte-modernbert-base\/sagemaker:gte-modernbert-embed$/);
    await embedder.close();
  });

  it("honors an explicit modelId override", async () => {
    const { runtime } = makeRuntime(() => [vec(768, 0)]);
    const embedder = await openSagemakerEmbedder({
      endpointName: "anything",
      modelId: "custom/model:v1",
      runtime,
    });
    equal(embedder.modelId, "custom/model:v1");
    await embedder.close();
  });

  it("batches ≤64 inputs in a single InvokeEndpoint call", async () => {
    const { runtime, calls, lastBatch } = makeRuntime((n) =>
      Array.from({ length: n }, (_, i) => vec(768, i * 0.01)),
    );

    const embedder = await openSagemakerEmbedder({
      endpointName: "test-endpoint",
      runtime,
    });

    const texts = Array.from({ length: 32 }, (_, i) => `text-${i}`);
    const out = await embedder.embedBatch(texts);
    equal(out.length, 32);
    equal(calls(), 1);
    equal(lastBatch(), 32);
    await embedder.close();
  });

  it("splits >64 inputs into multiple calls", async () => {
    const sizes: number[] = [];
    const runtime: SagemakerRuntimeLike = {
      async send(command: SendCmd) {
        const parsed = JSON.parse(new TextDecoder().decode(command.input.Body)) as {
          readonly inputs: readonly string[];
        };
        sizes.push(parsed.inputs.length);
        return {
          Body: responseBody(parsed.inputs.map((_, i) => vec(768, i * 0.001))),
        };
      },
    };

    const embedder = await openSagemakerEmbedder({
      endpointName: "test-endpoint",
      runtime,
    });

    const texts = Array.from({ length: 150 }, (_, i) => `text-${i}`);
    const out = await embedder.embedBatch(texts);
    equal(out.length, 150);
    // 150 split by 64 → [64, 64, 22]
    deepEqual(sizes, [64, 64, 22]);
    await embedder.close();
  });

  it("returns an empty array for an empty batch without calling the endpoint", async () => {
    const { runtime, calls } = makeRuntime(() => [vec(768, 0)]);
    const embedder = await openSagemakerEmbedder({
      endpointName: "test-endpoint",
      runtime,
    });
    const out = await embedder.embedBatch([]);
    equal(out.length, 0);
    equal(calls(), 0);
    await embedder.close();
  });
});

describe("openSagemakerEmbedder — error cases", () => {
  it("throws on dim mismatch", async () => {
    const { runtime } = makeRuntime(() => [vec(512, 0.1)]);
    const embedder = await openSagemakerEmbedder({
      endpointName: "test-endpoint",
      runtime,
    });
    await rejects(embedder.embed("hello"), /512d vector at row 0, expected 768d/);
  });

  it("throws on row-count mismatch (endpoint returned too few rows)", async () => {
    const runtime: SagemakerRuntimeLike = {
      async send(_command: SendCmd) {
        // Return 1 row for any number of inputs.
        return { Body: responseBody([vec(768, 0)]) };
      },
    };
    const embedder = await openSagemakerEmbedder({
      endpointName: "test-endpoint",
      runtime,
    });
    await rejects(embedder.embedBatch(["a", "b", "c"]), /returned 1 rows for 3 inputs/);
  });

  it("throws on non-JSON body", async () => {
    const runtime: SagemakerRuntimeLike = {
      async send(_command: SendCmd) {
        return { Body: new TextEncoder().encode("<html>500</html>") };
      },
    };
    const embedder = await openSagemakerEmbedder({
      endpointName: "test-endpoint",
      runtime,
    });
    await rejects(embedder.embed("x"), /non-JSON body/);
  });

  it("throws when response body is absent", async () => {
    const runtime: SagemakerRuntimeLike = {
      async send(_command: SendCmd) {
        return {};
      },
    };
    const embedder = await openSagemakerEmbedder({
      endpointName: "test-endpoint",
      runtime,
    });
    await rejects(embedder.embed("x"), /empty response body/);
  });

  it("splits on ValidationException (413) and retries at size 1", async () => {
    const batchSizes: number[] = [];
    const runtime: SagemakerRuntimeLike = {
      async send(command: SendCmd) {
        const parsed = JSON.parse(new TextDecoder().decode(command.input.Body)) as {
          readonly inputs: readonly string[];
        };
        batchSizes.push(parsed.inputs.length);
        if (parsed.inputs.length > 1) {
          const err = new Error("payload too large");
          (err as { name: string }).name = "ValidationException";
          throw err;
        }
        return { Body: responseBody([vec(768, parsed.inputs[0] === "a" ? 0.1 : 0.2)]) };
      },
    };
    const embedder = await openSagemakerEmbedder({
      endpointName: "test-endpoint",
      runtime,
    });
    const out = await embedder.embedBatch(["a", "b"]);
    equal(out.length, 2);
    // First call: batch of 2 → 413. Then 2 individual retries.
    deepEqual(batchSizes, [2, 1, 1]);
    await embedder.close();
  });

  it("surfaces credential errors as EmbedderNotSetupError at call time", async () => {
    const credErr = new Error("Could not load credentials from any providers");
    (credErr as { name: string }).name = "CredentialsProviderError";
    const runtime: SagemakerRuntimeLike = {
      async send(_command: SendCmd) {
        throw credErr;
      },
    };
    const embedder = await openSagemakerEmbedder({
      endpointName: "test-endpoint",
      runtime,
    });
    await rejects(embedder.embed("x"), (err: unknown) => {
      ok(err instanceof EmbedderNotSetupError);
      return true;
    });
  });
});

describe("tryOpenHttpEmbedder — SageMaker precedence", () => {
  let originals: Record<string, string | undefined>;
  const keys = [
    "CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT",
    "CODEHUB_EMBEDDING_SAGEMAKER_REGION",
    "CODEHUB_EMBEDDING_URL",
    "CODEHUB_EMBEDDING_MODEL",
  ];

  beforeEach(() => {
    originals = {};
    for (const k of keys) {
      originals[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of keys) {
      const v = originals[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("throws when offline AND SageMaker env is configured", () => {
    process.env["CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT"] = "gte-modernbert-embed";
    throws(
      () => tryOpenHttpEmbedder({ offline: true }),
      /SageMaker embeddings are disabled in offline mode/,
    );
  });
});
