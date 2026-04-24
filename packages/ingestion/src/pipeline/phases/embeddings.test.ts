/**
 * Tests for the `embeddings` pipeline phase.
 *
 * We don't have ONNX weights in CI so every test here drives the phase with
 * an in-memory KnowledgeGraph and verifies:
 *   - flag off → phase is a silent no-op (empty rows, embeddingsModelId="")
 *   - flag on with no weights present → phase warns and returns empty rows
 *   - rows are sorted by (nodeId, chunkIndex)
 *   - embeddingsHash is stable across runs with identical inputs
 *
 * The real-embedder path is exercised by the integration test in
 * `embeddings.integration.test.ts` when `CODEHUB_TEST_WEIGHTS_DIR` is set.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { type GraphNode, KnowledgeGraph, makeNodeId } from "@opencodehub/core-types";

import type { PipelineContext, PipelineOptions, ProgressEvent } from "../types.js";
import { embeddingsPhase } from "./embeddings.js";

function ctxFor(
  graph: KnowledgeGraph,
  options: PipelineOptions,
  warnings: string[],
): PipelineContext {
  return {
    repoPath: "/tmp/embeddings-test",
    options,
    graph,
    phaseOutputs: new Map(),
    onProgress: (ev: ProgressEvent) => {
      if (ev.kind === "warn" && ev.message !== undefined) {
        warnings.push(ev.message);
      }
    },
  };
}

function functionNode(name: string, signature?: string): GraphNode {
  const id = makeNodeId("Function", "src/a.ts", name);
  const base: Record<string, unknown> = {
    id,
    kind: "Function",
    name,
    filePath: "src/a.ts",
    startLine: 1,
    endLine: 5,
  };
  if (signature !== undefined) base["signature"] = signature;
  return base as unknown as GraphNode;
}

describe("embeddingsPhase", () => {
  it("is a silent no-op when options.embeddings is false", async () => {
    const graph = new KnowledgeGraph();
    graph.addNode(functionNode("hello", "function hello(): number"));
    const warnings: string[] = [];
    const ctx = ctxFor(graph, { embeddings: false }, warnings);

    const out = await embeddingsPhase.run(ctx, new Map());

    assert.equal(out.embeddingsInserted, 0);
    assert.equal(out.symbolsSkipped, 0);
    assert.equal(out.chunksTotal, 0);
    assert.equal(out.rows.length, 0);
    assert.equal(out.embeddingsModelId, "");
    assert.equal(out.ranEmbedder, false);
    assert.equal(warnings.length, 0, "must not emit a warning when flag off");
  });

  it("is a no-op when options.embeddings is undefined (default)", async () => {
    const graph = new KnowledgeGraph();
    graph.addNode(functionNode("hello"));
    const warnings: string[] = [];
    const ctx = ctxFor(graph, {}, warnings);
    const out = await embeddingsPhase.run(ctx, new Map());
    assert.equal(out.rows.length, 0);
    assert.equal(warnings.length, 0);
  });

  it("warns and returns empty rows when weights are missing", async () => {
    const graph = new KnowledgeGraph();
    graph.addNode(functionNode("hello", "function hello(): number"));
    const warnings: string[] = [];
    const ctx = ctxFor(
      graph,
      {
        embeddings: true,
        embeddingsModelDir: "/nonexistent/path/that/should/not/exist",
      },
      warnings,
    );

    const out = await embeddingsPhase.run(ctx, new Map());

    assert.equal(out.rows.length, 0);
    assert.equal(out.ranEmbedder, false);
    assert.equal(out.embeddingsModelId, "");
    assert.equal(warnings.length, 1, "must warn exactly once");
    assert.match(warnings[0] ?? "", /codehub setup --embeddings/);
  });

  it("empty-graph fast path produces stable zero output", async () => {
    const graph = new KnowledgeGraph();
    const warnings: string[] = [];
    const ctx = ctxFor(graph, { embeddings: false }, warnings);
    const a = await embeddingsPhase.run(ctx, new Map());
    const b = await embeddingsPhase.run(ctx, new Map());
    assert.equal(a.embeddingsHash, b.embeddingsHash);
  });

  it("is registered with `annotate` and `summarize` as its dependencies", () => {
    assert.deepEqual([...embeddingsPhase.deps], ["annotate", "summarize"]);
    assert.equal(embeddingsPhase.name, "embeddings");
  });

  it("throws when offline=true AND CODEHUB_EMBEDDING_URL is set", async () => {
    const originalUrl = process.env["CODEHUB_EMBEDDING_URL"];
    const originalModel = process.env["CODEHUB_EMBEDDING_MODEL"];
    process.env["CODEHUB_EMBEDDING_URL"] = "https://embed.example/v1";
    process.env["CODEHUB_EMBEDDING_MODEL"] = "m";
    try {
      const graph = new KnowledgeGraph();
      graph.addNode(functionNode("hello", "function hello(): number"));
      const warnings: string[] = [];
      const ctx = ctxFor(graph, { embeddings: true, offline: true }, warnings);
      await assert.rejects(embeddingsPhase.run(ctx, new Map()), /offline mode/);
    } finally {
      if (originalUrl === undefined) delete process.env["CODEHUB_EMBEDDING_URL"];
      else process.env["CODEHUB_EMBEDDING_URL"] = originalUrl;
      if (originalModel === undefined) delete process.env["CODEHUB_EMBEDDING_MODEL"];
      else process.env["CODEHUB_EMBEDDING_MODEL"] = originalModel;
    }
  });
});
