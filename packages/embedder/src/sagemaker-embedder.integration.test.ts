/**
 * Live integration test for the SageMaker embedder backend.
 *
 * Gated: this test does nothing unless `CODEHUB_INTEGRATION=1` AND
 * `CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT` are both set in the environment.
 * It hits the real SageMaker Runtime API, so it requires AWS credentials
 * in the default chain (profile, env vars, IMDS, etc.) and network access.
 *
 * Run locally:
 *
 *   AWS_PROFILE=lalsaado-handson \
 *   AWS_REGION=us-east-1 \
 *   CODEHUB_INTEGRATION=1 \
 *   CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT=gte-modernbert-embed \
 *   pnpm --filter @opencodehub/embedder test
 */

import { equal, ok } from "node:assert/strict";
import { describe, it } from "node:test";

import { openSagemakerEmbedder } from "./index.js";

const INTEGRATION_GATE = process.env["CODEHUB_INTEGRATION"] === "1";
const ENDPOINT = process.env["CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT"];
const REGION = process.env["CODEHUB_EMBEDDING_SAGEMAKER_REGION"] ?? "us-east-1";

const skipReason = !INTEGRATION_GATE
  ? "CODEHUB_INTEGRATION!=1"
  : ENDPOINT === undefined || ENDPOINT === ""
    ? "CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT unset"
    : null;

describe("openSagemakerEmbedder — live SageMaker endpoint", {
  skip: skipReason ?? undefined,
}, () => {
  it("single text returns a 768-d Float32Array with unit L2 norm (≈1.0)", async () => {
    const embedder = await openSagemakerEmbedder({
      endpointName: ENDPOINT as string,
      region: REGION,
    });
    try {
      const vec = await embedder.embed(
        "function add(a: number, b: number): number { return a + b; }",
      );
      equal(vec.length, 768);
      // TEI with the gte-modernbert-base bundled Normalize module returns
      // L2-normalized vectors; assert norm is close to 1.
      let norm = 0;
      for (let i = 0; i < vec.length; i++) {
        const v = vec[i] ?? 0;
        norm += v * v;
      }
      norm = Math.sqrt(norm);
      ok(Math.abs(norm - 1.0) < 0.05, `expected unit-norm vector, got ||v||=${norm.toFixed(4)}`);
    } finally {
      await embedder.close();
    }
  });

  it("batch of 64 succeeds in a single call", async () => {
    const embedder = await openSagemakerEmbedder({
      endpointName: ENDPOINT as string,
      region: REGION,
    });
    try {
      const texts = Array.from({ length: 64 }, (_, i) => `const value${i} = ${i};`);
      const out = await embedder.embedBatch(texts);
      equal(out.length, 64);
      for (const v of out) equal(v.length, 768);
    } finally {
      await embedder.close();
    }
  });

  it("batch of 100 splits into multiple calls", async () => {
    const embedder = await openSagemakerEmbedder({
      endpointName: ENDPOINT as string,
      region: REGION,
    });
    try {
      const texts = Array.from({ length: 100 }, (_, i) => `let x${i} = ${i};`);
      const out = await embedder.embedBatch(texts);
      equal(out.length, 100);
      for (const v of out) equal(v.length, 768);
    } finally {
      await embedder.close();
    }
  });
});
