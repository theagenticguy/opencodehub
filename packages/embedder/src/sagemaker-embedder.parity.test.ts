/**
 * Cross-backend cosine-parity check — compares the SageMaker backend
 * against the local ONNX backend on a handful of code-chunk fixtures.
 *
 * Gated: runs only when
 *   - `CODEHUB_INTEGRATION=1` is set
 *   - `CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT` is set
 *   - the ONNX weights + tokenizer files are installed in the default
 *     `CODEHUB_HOME`. Weight-missing is detected lazily — `openOnnxEmbedder`
 *     throws `EmbedderNotSetupError` and we skip the rest of the suite.
 *
 * Acceptance threshold: per-pair cosine similarity ≥ 0.99. Both backends
 * use CLS pooling + L2 normalization, so cosine should be ≳ 0.999 on the
 * happy path — the 0.99 floor absorbs fp16-vs-fp32 drift on the GPU side.
 */

import { ok } from "node:assert/strict";
import { describe, it } from "node:test";

import { EmbedderNotSetupError, openOnnxEmbedder, openSagemakerEmbedder } from "./index.js";

const INTEGRATION_GATE = process.env["CODEHUB_INTEGRATION"] === "1";
const ENDPOINT = process.env["CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT"];
const REGION = process.env["CODEHUB_EMBEDDING_SAGEMAKER_REGION"] ?? "us-east-1";

const skipReason = !INTEGRATION_GATE
  ? "CODEHUB_INTEGRATION!=1"
  : ENDPOINT === undefined || ENDPOINT === ""
    ? "CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT unset"
    : null;

const COSINE_FLOOR = 0.99;

/** Compact set of code-shaped fixtures — realistic embedder inputs. */
const FIXTURES: readonly string[] = [
  "function add(a: number, b: number): number { return a + b; }",
  "class Foo { constructor(public name: string) {} greet() { return `hi ${this.name}`; } }",
  "const result = await fetch(url).then(r => r.json());",
  "SELECT id, name FROM users WHERE active = true ORDER BY created_at DESC LIMIT 10;",
  "def factorial(n):\n    return 1 if n <= 1 else n * factorial(n - 1)",
  "import { useState } from 'react';\nexport const Counter = () => { const [n,setN] = useState(0); }",
  "for i in range(10):\n    print(i * i)",
  "// Handle the authentication callback by exchanging the code for tokens",
  "ERROR: connection refused at tcp://localhost:5432 — check that Postgres is running",
  "let graph = Graph::new(); graph.add_edge(1, 2); graph.add_edge(2, 3);",
  "pub fn solve(input: &str) -> Result<u64, Error> { Ok(input.lines().count() as u64) }",
  "interface User { readonly id: string; readonly email: string; readonly name: string; }",
  "docker run -p 8080:80 --rm nginx:latest",
  "impl Display for Point { fn fmt(&self, f: &mut Formatter) -> fmt::Result { ... } }",
  "const sum = items.reduce((acc, x) => acc + x.value, 0);",
  "public class LinkedList<T> { private Node<T> head; public void add(T value) { ... } }",
  "git rebase --interactive HEAD~5",
  "try { await fn(); } catch (err) { logger.error({ err }, 'failed'); throw err; }",
  "// TODO: migrate this to the new API once the deprecation window closes",
  "CREATE INDEX CONCURRENTLY idx_users_email ON users (lower(email));",
];

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let an = 0;
  let bn = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    an += av * av;
    bn += bv * bv;
  }
  const denom = Math.sqrt(an) * Math.sqrt(bn);
  return denom === 0 ? 0 : dot / denom;
}

describe("SageMaker vs local ONNX — cosine parity", { skip: skipReason ?? undefined }, () => {
  it("matches local ONNX within cosine ≥ 0.99 per fixture", async () => {
    let onnx: Awaited<ReturnType<typeof openOnnxEmbedder>>;
    try {
      onnx = await openOnnxEmbedder();
    } catch (err) {
      if (err instanceof EmbedderNotSetupError) {
        // Weights missing — skip the rest of this test without failing
        // the suite.
        // eslint-disable-next-line no-console
        console.warn(`[parity] skipping: ${err.message}`);
        return;
      }
      throw err;
    }

    const remote = await openSagemakerEmbedder({
      endpointName: ENDPOINT as string,
      region: REGION,
    });

    try {
      const localVecs = await onnx.embedBatch(FIXTURES);
      const remoteVecs = await remote.embedBatch(FIXTURES);

      const failures: string[] = [];
      let minCos = 1;
      let sumCos = 0;

      for (let i = 0; i < FIXTURES.length; i++) {
        const lv = localVecs[i];
        const rv = remoteVecs[i];
        if (lv === undefined || rv === undefined) {
          failures.push(`row ${i}: vector missing from one backend`);
          continue;
        }
        const c = cosine(lv, rv);
        minCos = Math.min(minCos, c);
        sumCos += c;
        if (c < COSINE_FLOOR) {
          failures.push(
            `row ${i}: cosine=${c.toFixed(4)} < ${COSINE_FLOOR}; text="${FIXTURES[i]?.slice(0, 60)}..."`,
          );
        }
      }

      // eslint-disable-next-line no-console
      console.log(
        `[parity] ${FIXTURES.length} fixtures · min=${minCos.toFixed(4)} · ` +
          `mean=${(sumCos / FIXTURES.length).toFixed(4)}`,
      );
      ok(failures.length === 0, `parity violations:\n  ${failures.join("\n  ")}`);
    } finally {
      await remote.close();
      await onnx.close();
    }
  });
});
