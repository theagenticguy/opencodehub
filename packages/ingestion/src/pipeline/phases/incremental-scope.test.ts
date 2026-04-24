/**
 * Unit tests for the incremental-scope phase.
 *
 * The tests synthesize a `ScanOutput` and a matching `PreviousGraph` in memory
 * — no real repo needed. They cover:
 *   - full-reindex fallback when no prior graph is supplied,
 *   - full-reindex fallback when `--force` is set,
 *   - forward + backward IMPORTS BFS depth 2,
 *   - 1-hop heritage ancestor/descendant expansion,
 *   - 30% safety valve forcing a full reindex,
 *   - deletion-tolerant pruning (closure files missing in current scan drop),
 *   - empty-change-set short-circuit.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { KnowledgeGraph } from "@opencodehub/core-types";
import type { PipelineContext, PreviousGraph } from "../types.js";
import { INCREMENTAL_SCOPE_PHASE_NAME, incrementalScopePhase } from "./incremental-scope.js";
import { SCAN_PHASE_NAME, type ScannedFile, type ScanOutput } from "./scan.js";

interface FakeFileSpec {
  readonly relPath: string;
  readonly contentSha: string;
}

function makeScanOutput(files: readonly FakeFileSpec[]): ScanOutput {
  const entries: ScannedFile[] = files.map((f) => ({
    absPath: `/abs/${f.relPath}`,
    relPath: f.relPath,
    byteSize: 0,
    sha256: f.contentSha,
    grammarSha: null,
  }));
  entries.sort((a, b) => (a.relPath < b.relPath ? -1 : 1));
  return { files: entries, totalBytes: 0, submodulePaths: [] };
}

function makeCtx(options: PipelineContext["options"]): PipelineContext {
  return {
    repoPath: "/tmp/fake-repo",
    options,
    graph: new KnowledgeGraph(),
    phaseOutputs: new Map(),
  };
}

async function runPhase(scan: ScanOutput, ctx: PipelineContext) {
  return incrementalScopePhase.run(ctx, new Map<string, unknown>([[SCAN_PHASE_NAME, scan]]));
}

describe("incremental-scope / fallbacks", () => {
  it("falls back to full reindex when no prior graph is supplied", async () => {
    const scan = makeScanOutput([
      { relPath: "a.ts", contentSha: "aa" },
      { relPath: "b.ts", contentSha: "bb" },
    ]);
    const ctx = makeCtx({ skipGit: true });
    const out = await runPhase(scan, ctx);
    assert.equal(out.mode, "full");
    assert.equal(out.fullReindexBecause, "no-prior-graph");
    assert.deepEqual([...out.closureFiles].sort(), ["a.ts", "b.ts"]);
    assert.equal(out.changedFiles.length, 0);
    assert.equal(out.totalFiles, 2);
    assert.equal(out.closureRatio, 1);
  });

  it("falls back to full reindex under --force even with a prior graph", async () => {
    const scan = makeScanOutput([
      { relPath: "a.ts", contentSha: "aa" },
      { relPath: "b.ts", contentSha: "bb" },
    ]);
    const prior: PreviousGraph = {
      files: [
        { relPath: "a.ts", contentSha: "aa" },
        { relPath: "b.ts", contentSha: "bb" },
      ],
      importEdges: [],
      heritageEdges: [],
    };
    const ctx = makeCtx({ skipGit: true, force: true, incrementalFrom: prior });
    const out = await runPhase(scan, ctx);
    assert.equal(out.mode, "full");
    assert.equal(out.fullReindexBecause, "force-flag");
  });

  it("emits mode=incremental with empty closure when nothing changed", async () => {
    const scan = makeScanOutput([
      { relPath: "a.ts", contentSha: "aa" },
      { relPath: "b.ts", contentSha: "bb" },
    ]);
    const prior: PreviousGraph = {
      files: [
        { relPath: "a.ts", contentSha: "aa" },
        { relPath: "b.ts", contentSha: "bb" },
      ],
      importEdges: [{ importer: "b.ts", target: "a.ts" }],
      heritageEdges: [],
    };
    const ctx = makeCtx({ skipGit: true, incrementalFrom: prior });
    const out = await runPhase(scan, ctx);
    assert.equal(out.mode, "incremental");
    assert.equal(out.changedFiles.length, 0);
    assert.equal(out.closureFiles.length, 0);
  });
});

describe("incremental-scope / BFS closure", () => {
  // 5-file chain (a → b → c → d → e) embedded inside 20 unrelated files so
  // the closure stays < 30% of the total scan (5/25 = 20%). Changing `c`
  // should pull in depth-2 forward (d, e) and depth-2 backward (b, a) plus
  // `c` itself — exactly 5 files.
  function padding(): FakeFileSpec[] {
    const out: FakeFileSpec[] = [];
    for (let i = 0; i < 20; i += 1) {
      out.push({ relPath: `pad${i.toString().padStart(2, "0")}.ts`, contentSha: `p${i}` });
    }
    return out;
  }
  function chainScan(cHash: string): ScanOutput {
    return makeScanOutput([
      { relPath: "a.ts", contentSha: "aa" },
      { relPath: "b.ts", contentSha: "bb" },
      { relPath: "c.ts", contentSha: cHash },
      { relPath: "d.ts", contentSha: "dd" },
      { relPath: "e.ts", contentSha: "ee" },
      ...padding(),
    ]);
  }
  const priorChain: PreviousGraph = {
    files: [
      { relPath: "a.ts", contentSha: "aa" },
      { relPath: "b.ts", contentSha: "bb" },
      { relPath: "c.ts", contentSha: "cc" },
      { relPath: "d.ts", contentSha: "dd" },
      { relPath: "e.ts", contentSha: "ee" },
      ...padding(),
    ],
    importEdges: [
      { importer: "a.ts", target: "b.ts" },
      { importer: "b.ts", target: "c.ts" },
      { importer: "c.ts", target: "d.ts" },
      { importer: "d.ts", target: "e.ts" },
    ],
    heritageEdges: [],
  };

  it("changing a middle node pulls 2 hops forward + 2 hops backward", async () => {
    const scan = chainScan("c-mutated");
    const ctx = makeCtx({ skipGit: true, incrementalFrom: priorChain });
    const out = await runPhase(scan, ctx);
    assert.equal(out.mode, "incremental");
    assert.deepEqual(out.changedFiles, ["c.ts"]);
    // Depth-2 forward reaches d,e; depth-2 backward reaches b,a. Including
    // c itself, we expect exactly 5 files.
    assert.deepEqual([...out.closureFiles].sort(), ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
  });

  it("closure files are emitted in sorted order (determinism)", async () => {
    const scan = chainScan("c-mutated");
    const ctx = makeCtx({ skipGit: true, incrementalFrom: priorChain });
    const out = await runPhase(scan, ctx);
    const sorted = [...out.closureFiles].sort();
    assert.deepEqual(out.closureFiles, sorted);
  });

  it("1-hop heritage ancestors + descendants are pulled in", async () => {
    // Change base.ts; we expect sub.ts to be pulled in via heritage even
    // though they have no IMPORTS edge between them. Pad the scan so the
    // safety valve (30%) does not trip on the small fixture.
    const scan = makeScanOutput([
      { relPath: "base.ts", contentSha: "new" },
      { relPath: "sub.ts", contentSha: "sub" },
      { relPath: "unrelated.ts", contentSha: "unrelated" },
      ...padding(),
    ]);
    const prior: PreviousGraph = {
      files: [
        { relPath: "base.ts", contentSha: "old" },
        { relPath: "sub.ts", contentSha: "sub" },
        { relPath: "unrelated.ts", contentSha: "unrelated" },
        ...padding(),
      ],
      importEdges: [],
      heritageEdges: [{ childFile: "sub.ts", parentFile: "base.ts" }],
    };
    const ctx = makeCtx({ skipGit: true, incrementalFrom: prior });
    const out = await runPhase(scan, ctx);
    assert.equal(out.mode, "incremental");
    assert.deepEqual(out.changedFiles, ["base.ts"]);
    // Closure should include base.ts (changed) + sub.ts (heritage neighbour).
    // unrelated.ts must NOT be in the closure.
    assert.ok(out.closureFiles.includes("base.ts"));
    assert.ok(out.closureFiles.includes("sub.ts"));
    assert.ok(!out.closureFiles.includes("unrelated.ts"));
  });

  it("newly added files are treated as changed", async () => {
    // Pad so one new file is < 30% of the scan.
    const scan = makeScanOutput([
      { relPath: "a.ts", contentSha: "aa" },
      { relPath: "b.ts", contentSha: "bb" },
      { relPath: "new.ts", contentSha: "new" },
      ...padding(),
    ]);
    const prior: PreviousGraph = {
      files: [
        { relPath: "a.ts", contentSha: "aa" },
        { relPath: "b.ts", contentSha: "bb" },
        ...padding(),
      ],
      importEdges: [],
      heritageEdges: [],
    };
    const ctx = makeCtx({ skipGit: true, incrementalFrom: prior });
    const out = await runPhase(scan, ctx);
    assert.equal(out.mode, "incremental");
    assert.deepEqual(out.changedFiles, ["new.ts"]);
  });

  it("deleted files vanish from the closure (cannot re-process what is gone)", async () => {
    // Prior graph has gone.ts; current scan does not. gone.ts imports
    // a.ts, but since gone.ts no longer exists the closure walk from a.ts
    // must not include it.
    const scan = makeScanOutput([{ relPath: "a.ts", contentSha: "aa-new" }, ...padding()]);
    const prior: PreviousGraph = {
      files: [
        { relPath: "a.ts", contentSha: "aa" },
        { relPath: "gone.ts", contentSha: "gone" },
        ...padding(),
      ],
      importEdges: [{ importer: "gone.ts", target: "a.ts" }],
      heritageEdges: [],
    };
    const ctx = makeCtx({ skipGit: true, incrementalFrom: prior });
    const out = await runPhase(scan, ctx);
    assert.equal(out.mode, "incremental");
    assert.deepEqual(out.changedFiles, ["a.ts"]);
    assert.deepEqual([...out.closureFiles].sort(), ["a.ts"]);
    assert.ok(!out.closureFiles.includes("gone.ts"));
  });
});

describe("incremental-scope / 30% safety valve", () => {
  it("closure > 30% of total falls back to full reindex", async () => {
    // 100 files; change 40 of them (all independent, no edges). Closure =
    // 40 / 100 = 40% → must fall back to mode="full".
    const files: FakeFileSpec[] = [];
    for (let i = 0; i < 100; i += 1) {
      const path = `f${String(i).padStart(3, "0")}.ts`;
      // First 40 files get a NEW hash; remaining 60 keep the old one.
      const hash = i < 40 ? `new-${i}` : `h${i}`;
      files.push({ relPath: path, contentSha: hash });
    }
    const prior: PreviousGraph = {
      files: files.map((f, i) => ({ relPath: f.relPath, contentSha: `h${i}` })),
      importEdges: [],
      heritageEdges: [],
    };
    const ctx = makeCtx({ skipGit: true, incrementalFrom: prior });
    const scan = makeScanOutput(files);
    const out = await runPhase(scan, ctx);
    assert.equal(out.mode, "full");
    assert.equal(out.fullReindexBecause, "closure-too-large");
    // When falling back to full, closureFiles mirrors the entire scan set.
    assert.equal(out.closureFiles.length, 100);
    // And closureRatio reports the pre-fallback ratio so operators see the trigger.
    assert.ok(out.closureRatio > 0.3);
  });

  it("closure at exactly 30% does NOT trigger fallback (strict greater-than)", async () => {
    const files: FakeFileSpec[] = [];
    for (let i = 0; i < 10; i += 1) {
      const hash = i < 3 ? `new-${i}` : `h${i}`;
      files.push({ relPath: `f${i}.ts`, contentSha: hash });
    }
    const prior: PreviousGraph = {
      files: files.map((f, i) => ({ relPath: f.relPath, contentSha: `h${i}` })),
      importEdges: [],
      heritageEdges: [],
    };
    const ctx = makeCtx({ skipGit: true, incrementalFrom: prior });
    const scan = makeScanOutput(files);
    const out = await runPhase(scan, ctx);
    // 3/10 = 0.30 exactly → stays incremental (threshold is strictly >30%).
    assert.equal(out.mode, "incremental");
    assert.equal(out.changedFiles.length, 3);
  });

  it("safety valve trigger is reported via ctx.onProgress as a note event", async () => {
    const files: FakeFileSpec[] = [];
    for (let i = 0; i < 100; i += 1) {
      const hash = i < 40 ? `new-${i}` : `h${i}`;
      files.push({ relPath: `f${i}.ts`, contentSha: hash });
    }
    const prior: PreviousGraph = {
      files: files.map((f, i) => ({ relPath: f.relPath, contentSha: `h${i}` })),
      importEdges: [],
      heritageEdges: [],
    };
    const notes: string[] = [];
    const ctx: PipelineContext = {
      ...makeCtx({ skipGit: true, incrementalFrom: prior }),
      onProgress: (ev) => {
        if (ev.kind === "note" && ev.message !== undefined) notes.push(ev.message);
      },
    };
    const scan = makeScanOutput(files);
    await runPhase(scan, ctx);
    assert.ok(
      notes.some((n) => n.includes("exceeds")),
      `expected safety-valve note; got: ${notes.join(" | ")}`,
    );
  });
});

describe("incremental-scope / phase metadata", () => {
  it("has correct name + dependency list", () => {
    assert.equal(incrementalScopePhase.name, INCREMENTAL_SCOPE_PHASE_NAME);
    assert.deepEqual([...incrementalScopePhase.deps], [SCAN_PHASE_NAME]);
  });

  it("throws when scan output is missing from the dep map", async () => {
    const ctx = makeCtx({ skipGit: true });
    await assert.rejects(incrementalScopePhase.run(ctx, new Map()), /scan output missing/);
  });
});
