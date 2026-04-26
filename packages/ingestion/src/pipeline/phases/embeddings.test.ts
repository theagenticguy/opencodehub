/**
 * Tests for the `embeddings` pipeline phase.
 *
 * We don't have ONNX weights in CI so every test here drives the phase with
 * an in-memory KnowledgeGraph and verifies:
 *   - flag off → phase is a silent no-op (empty rows, embeddingsModelId="")
 *   - flag on with no weights present → phase warns and returns empty rows
 *   - rows are sorted by (nodeId, chunkIndex)
 *   - embeddingsHash is stable across runs with identical inputs
 *   - hierarchical tiers (P03): symbol/file/community granularities emit
 *     independent rows with tier-scoped content hashes, using a fake HTTP
 *     embedder stood up via `CODEHUB_EMBEDDING_URL` + a stubbed `fetch`.
 *
 * The real-embedder path is exercised by the integration test in
 * `embeddings.integration.test.ts` when `CODEHUB_TEST_WEIGHTS_DIR` is set.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { type GraphNode, KnowledgeGraph, makeNodeId } from "@opencodehub/core-types";
import type { SymbolSummaryRow } from "@opencodehub/storage";

import type { PipelineContext, PipelineOptions, ProgressEvent } from "../types.js";
import { embeddingsPhase } from "./embeddings.js";
import { SCAN_PHASE_NAME } from "./scan.js";
import { SUMMARIZE_PHASE_NAME } from "./summarize.js";

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

  it("is registered with annotate/summarize/communities as its dependencies", () => {
    // `communities` was added in P03 so the community tier observes the
    // emitted Community nodes + MEMBER_OF edges.
    assert.deepEqual([...embeddingsPhase.deps], ["annotate", "summarize", "communities"]);
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

// ---------------------------------------------------------------------------
// P03 hierarchical-tier tests
//
// We install a minimal HTTP-embedder stub (CODEHUB_EMBEDDING_URL +
// CODEHUB_EMBEDDING_MODEL + a stubbed `fetch`) so the phase's tier emission
// can be verified end-to-end without ONNX weights. The stub returns a
// deterministic vector derived from the input text so identical inputs
// across runs produce identical embeddings.
// ---------------------------------------------------------------------------

const HTTP_DIM = 768;

/**
 * Hash-derived deterministic embedding. Stable across runs given the same
 * text so the embeddingsHash stays stable too. Not designed to be
 * mathematically meaningful — the tests assert shape and tier semantics,
 * not retrieval quality.
 */
function fakeVector(text: string): number[] {
  const out = new Array(HTTP_DIM).fill(0);
  let h = 0;
  for (let i = 0; i < text.length; i += 1) {
    h = (h * 31 + text.charCodeAt(i)) & 0xffffffff;
    out[h % HTTP_DIM] += 1;
  }
  // Normalize to unit length so all embeddings have a similar magnitude.
  let mag = 0;
  for (const x of out) mag += x * x;
  const scale = mag === 0 ? 1 : 1 / Math.sqrt(mag);
  for (let i = 0; i < out.length; i += 1) out[i] *= scale;
  return out;
}

/**
 * Install a global `fetch` stub that handles `/v1/embeddings` requests.
 * Returns a restore fn.
 */
function installFetchStub(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const bodyText = typeof init?.body === "string" ? init.body : "";
    let inputs: string[] = [];
    try {
      const parsed = JSON.parse(bodyText) as { input?: string[] | string };
      if (Array.isArray(parsed.input)) inputs = parsed.input;
      else if (typeof parsed.input === "string") inputs = [parsed.input];
    } catch {
      inputs = [];
    }
    const data = inputs.map((t, i) => ({
      object: "embedding",
      index: i,
      embedding: fakeVector(t),
    }));
    const body = JSON.stringify({
      object: "list",
      data,
      model: "stub",
      usage: { prompt_tokens: 0, total_tokens: 0 },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe("embeddingsPhase — hierarchical tiers (P03)", () => {
  const originalUrl = process.env["CODEHUB_EMBEDDING_URL"];
  const originalModel = process.env["CODEHUB_EMBEDDING_MODEL"];
  const originalDims = process.env["CODEHUB_EMBEDDING_DIMS"];
  let restoreFetch: () => void = () => {};

  before(() => {
    process.env["CODEHUB_EMBEDDING_URL"] = "https://stub.example/v1";
    process.env["CODEHUB_EMBEDDING_MODEL"] = "stub-model";
    process.env["CODEHUB_EMBEDDING_DIMS"] = String(HTTP_DIM);
    restoreFetch = installFetchStub();
  });

  after(() => {
    restoreFetch();
    if (originalUrl === undefined) delete process.env["CODEHUB_EMBEDDING_URL"];
    else process.env["CODEHUB_EMBEDDING_URL"] = originalUrl;
    if (originalModel === undefined) delete process.env["CODEHUB_EMBEDDING_MODEL"];
    else process.env["CODEHUB_EMBEDDING_MODEL"] = originalModel;
    if (originalDims === undefined) delete process.env["CODEHUB_EMBEDDING_DIMS"];
    else process.env["CODEHUB_EMBEDDING_DIMS"] = originalDims;
  });

  function makeRepo(): { repoPath: string; filePath: string; relPath: string } {
    const repoPath = mkdtempSync(join(tmpdir(), "emb-tiers-"));
    const relPath = "src/a.ts";
    mkdirSync(join(repoPath, "src"), { recursive: true });
    const filePath = join(repoPath, relPath);
    writeFileSync(
      filePath,
      `export function hello(): number {\n  return 42; // meaning of life\n}\n`,
      "utf8",
    );
    return { repoPath, filePath, relPath };
  }

  function buildGraph(relPath: string): KnowledgeGraph {
    const g = new KnowledgeGraph();
    // File node (file-tier source).
    const fileId = makeNodeId("File", relPath, relPath);
    g.addNode({
      id: fileId,
      kind: "File",
      name: "a.ts",
      filePath: relPath,
    } as unknown as GraphNode);
    // Three functions so the community has ≥3 members (the phase does not
    // invoke Leiden here; we emit the Community node directly).
    const fids: string[] = [];
    for (const name of ["hello", "world", "kthxbye"]) {
      const id = makeNodeId("Function", relPath, name);
      fids.push(id);
      g.addNode({
        id,
        kind: "Function",
        name,
        filePath: relPath,
        startLine: 1,
        endLine: 3,
        signature: `function ${name}(): number`,
      } as unknown as GraphNode);
    }
    const cid = makeNodeId("Community", "<global>", "community-0");
    g.addNode({
      id: cid,
      kind: "Community",
      name: "community-0",
      filePath: "<global>",
      symbolCount: fids.length,
      cohesion: 1,
      inferredLabel: "ingestion-pipeline",
      keywords: ["ingestion", "pipeline", "phase"],
    } as unknown as GraphNode);
    for (const fid of fids) {
      g.addEdge({
        from: fid as ReturnType<typeof makeNodeId>,
        to: cid,
        type: "MEMBER_OF",
        confidence: 1,
        reason: "leiden",
      });
    }
    return g;
  }

  it("emits one row per tier when all three tiers are requested", async () => {
    const { repoPath, relPath } = makeRepo();
    const graph = buildGraph(relPath);
    const ctx: PipelineContext = {
      repoPath,
      options: {
        embeddings: true,
        embeddingsGranularity: ["symbol", "file", "community"],
      } as unknown as PipelineOptions,
      graph,
      phaseOutputs: new Map<string, unknown>([
        [
          SCAN_PHASE_NAME,
          { files: [{ absPath: "", relPath, byteSize: 1, sha256: "h", grammarSha: null }] },
        ],
      ]),
    };

    const out = await embeddingsPhase.run(ctx, new Map());
    assert.equal(out.ranEmbedder, true);
    assert.ok(out.byGranularity["symbol"] > 0, "must emit symbol rows");
    assert.equal(out.byGranularity["file"], 1, "exactly one file-tier row");
    assert.equal(out.byGranularity["community"], 1, "exactly one community-tier row");

    const tiers = new Set(out.rows.map((r) => r.granularity ?? "symbol"));
    assert.deepEqual([...tiers].sort(), ["community", "file", "symbol"]);
  });

  it("defaults to symbol-only when granularity option is omitted", async () => {
    const { repoPath, relPath } = makeRepo();
    const graph = buildGraph(relPath);
    const ctx: PipelineContext = {
      repoPath,
      options: { embeddings: true } as unknown as PipelineOptions,
      graph,
      phaseOutputs: new Map(),
    };
    const out = await embeddingsPhase.run(ctx, new Map());
    assert.equal(out.byGranularity["file"], 0);
    assert.equal(out.byGranularity["community"], 0);
    assert.ok(out.byGranularity["symbol"] >= 3);
    for (const r of out.rows) assert.equal(r.granularity ?? "symbol", "symbol");
  });

  it("fuses summary text into the symbol-tier input when a summary is present", async () => {
    const { repoPath, relPath } = makeRepo();
    const graph = buildGraph(relPath);
    const fnId = makeNodeId("Function", relPath, "hello");
    const summary: SymbolSummaryRow = {
      nodeId: fnId,
      contentHash: "h",
      promptVersion: "v1",
      modelId: "m",
      summaryText: "Returns the meaning of life.",
      signatureSummary: "hello() -> number",
      returnsTypeSummary: "number",
      createdAt: new Date().toISOString(),
    };
    const ctx: PipelineContext = {
      repoPath,
      options: {
        embeddings: true,
        embeddingsGranularity: ["symbol"],
      } as unknown as PipelineOptions,
      graph,
      phaseOutputs: new Map<string, unknown>([[SUMMARIZE_PHASE_NAME, { rows: [summary] }]]),
    };
    const out = await embeddingsPhase.run(ctx, new Map());
    assert.equal(out.summaryFused, true, "phase flags that summaries fused");
  });

  it("embeds identical inputs deterministically (stable embeddingsHash)", async () => {
    const { repoPath, relPath } = makeRepo();
    const ctxA: PipelineContext = {
      repoPath,
      options: {
        embeddings: true,
        embeddingsGranularity: ["symbol", "file", "community"],
      } as unknown as PipelineOptions,
      graph: buildGraph(relPath),
      phaseOutputs: new Map<string, unknown>([
        [
          SCAN_PHASE_NAME,
          { files: [{ absPath: "", relPath, byteSize: 1, sha256: "h", grammarSha: null }] },
        ],
      ]),
    };
    const ctxB: PipelineContext = {
      repoPath,
      options: ctxA.options,
      graph: buildGraph(relPath),
      phaseOutputs: new Map<string, unknown>([
        [
          SCAN_PHASE_NAME,
          { files: [{ absPath: "", relPath, byteSize: 1, sha256: "h", grammarSha: null }] },
        ],
      ]),
    };
    const a = await embeddingsPhase.run(ctxA, new Map());
    const b = await embeddingsPhase.run(ctxB, new Map());
    assert.equal(a.embeddingsHash, b.embeddingsHash, "hash is stable across runs");
  });

  it("scopes content hashes per tier so cross-tier collisions are impossible", async () => {
    const { repoPath, relPath } = makeRepo();
    const graph = buildGraph(relPath);
    const ctx: PipelineContext = {
      repoPath,
      options: {
        embeddings: true,
        embeddingsGranularity: ["symbol", "file", "community"],
      } as unknown as PipelineOptions,
      graph,
      phaseOutputs: new Map<string, unknown>([
        [
          SCAN_PHASE_NAME,
          { files: [{ absPath: "", relPath, byteSize: 1, sha256: "h", grammarSha: null }] },
        ],
      ]),
    };
    const out = await embeddingsPhase.run(ctx, new Map());
    const hashesByTier = new Map<string, Set<string>>();
    for (const r of out.rows) {
      const t = r.granularity ?? "symbol";
      if (!hashesByTier.has(t)) hashesByTier.set(t, new Set());
      hashesByTier.get(t)?.add(r.contentHash);
    }
    // No content hash should appear in more than one tier — the hash key
    // now includes the granularity label.
    const seen = new Set<string>();
    for (const set of hashesByTier.values()) {
      for (const h of set) {
        assert.ok(!seen.has(h), `hash ${h} collides across tiers`);
        seen.add(h);
      }
    }
  });
});
