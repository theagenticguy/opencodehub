/**
 * Tests for `codehub replay --compare` (decision-equivalence).
 *
 * Strategy: the comparator (`runReplayCompare`) is exercised via the
 * `_loadPack` seam with hand-built `LoadedPack`s — no filesystem. `loadPack`
 * itself is tested against a real on-disk pack directory (manifest +
 * ast-chunks + context-bom) so the snake_case parsing + integrity tier + the
 * JSONL/CycloneDX parsers are covered end-to-end.
 */

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  type LoadedPack,
  loadPack,
  packDecisionSet,
  replayVerdictLine,
  runReplayCompare,
  serializeReplayRecord,
} from "./replay.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Build a LoadedPack with given chunks; manifest packHash defaults distinct. */
function pack(over: Partial<LoadedPack> & { packHash: string; budget: number }): LoadedPack {
  return {
    dir: `/fake/${over.packHash}`,
    manifest: {
      packHash: over.packHash,
      budgetTokens: over.budget,
      commit: "c0ffee",
      files: [],
    },
    chunks: over.chunks ?? [],
    byteRangesByPath: over.byteRangesByPath ?? new Map(),
    integrityDrift: over.integrityDrift ?? [],
  };
}

const chunk = (path: string, startByte: number, endByte: number) => ({ path, startByte, endByte });

describe("runReplayCompare (seamed)", () => {
  async function compare(a: LoadedPack, b: LoadedPack) {
    // `runReplayCompare` calls `resolve(dir)` before the loader, so the
    // resolved path is platform-dependent (POSIX vs Windows). It always loads
    // A then B sequentially, so the fake serves packs in call order rather than
    // keying on the (unstable) resolved path.
    const queue = [a, b];
    return runReplayCompare(a.dir, b.dir, {
      _loadPack: async () => {
        const p = queue.shift();
        if (p === undefined) throw new Error("fake loader called more than twice");
        return p;
      },
    });
  }

  it("EQUIVALENT via packHash fast path when hashes match (no projection needed)", async () => {
    const a = pack({ packHash: "same", budget: 100, chunks: [chunk("a.ts", 0, 10)] });
    const b = pack({ packHash: "same", budget: 100, chunks: [chunk("a.ts", 0, 99)] });
    const r = await compare(a, b);
    assert.equal(r.verdict, "EQUIVALENT");
    assert.equal(r.decisionHashA, undefined, "fast path skips the projection");
  });

  it("EQUIVALENT when packHashes differ but the decision set matches (the contract)", async () => {
    // Same selection, different incidental bytes → different packHash, same decision.
    const a = pack({ packHash: "hashA", budget: 100, chunks: [chunk("a.ts", 0, 10)] });
    const b = pack({ packHash: "hashB", budget: 100, chunks: [chunk("a.ts", 0, 10)] });
    const r = await compare(a, b);
    assert.equal(r.verdict, "EQUIVALENT");
    assert.equal(r.decisionHashA, r.decisionHashB, "decision hashes match");
  });

  it("DIVERGED with a structured diff when selections differ", async () => {
    const a = pack({ packHash: "hashA", budget: 100, chunks: [chunk("a.ts", 0, 10)] });
    const b = pack({ packHash: "hashB", budget: 100, chunks: [chunk("a.ts", 0, 20)] });
    const r = await compare(a, b);
    assert.equal(r.verdict, "DIVERGED");
    assert.ok(r.diff !== undefined);
    assert.equal(r.diff?.rangeDeltas[0]?.path, "a.ts");
    assert.notEqual(r.decisionHashA, r.decisionHashB);
  });

  it("BUDGET_MISMATCH when budgets differ (reported distinctly, not DIVERGED)", async () => {
    const a = pack({ packHash: "hashA", budget: 100, chunks: [chunk("a.ts", 0, 10)] });
    const b = pack({ packHash: "hashB", budget: 200, chunks: [chunk("a.ts", 0, 10)] });
    const r = await compare(a, b);
    assert.equal(r.verdict, "BUDGET_MISMATCH");
    assert.equal(r.budgetA, 100);
    assert.equal(r.budgetB, 200);
  });

  it("CORRUPT when either pack has integrity drift (refuses to compare)", async () => {
    const a = pack({ packHash: "hashA", budget: 100, integrityDrift: ["ast-chunks.jsonl"] });
    const b = pack({ packHash: "hashB", budget: 100, chunks: [chunk("a.ts", 0, 10)] });
    const r = await compare(a, b);
    assert.equal(r.verdict, "CORRUPT");
    assert.deepEqual(r.corruptItems, ["ast-chunks.jsonl"]);
  });

  it("falls back to context-bom byteRanges when ast-chunks is empty (R7)", async () => {
    const a = pack({
      packHash: "hashA",
      budget: 100,
      byteRangesByPath: new Map([["a.ts", [{ start: 0, end: 10 }]]]),
    });
    const b = pack({ packHash: "hashB", budget: 100, chunks: [chunk("a.ts", 0, 10)] });
    const r = await compare(a, b);
    assert.equal(r.verdict, "EQUIVALENT", "byteRanges fallback == equivalent chunks");
  });
});

describe("replayVerdictLine exit codes", () => {
  const base = { packHashA: "a", packHashB: "b", budgetA: 100, budgetB: 100 } as const;

  it("EQUIVALENT → exit 0", () => {
    assert.equal(replayVerdictLine({ verdict: "EQUIVALENT", ...base }, false).exitCode, 0);
  });
  it("DIVERGED → exit 1", () => {
    assert.equal(replayVerdictLine({ verdict: "DIVERGED", ...base }, false).exitCode, 1);
  });
  it("CORRUPT → exit 1", () => {
    assert.equal(
      replayVerdictLine({ verdict: "CORRUPT", ...base, corruptItems: ["x"] }, false).exitCode,
      1,
    );
  });
  it("BUDGET_MISMATCH → exit 0 by default, 1 under --budget-strict", () => {
    const r = { verdict: "BUDGET_MISMATCH", ...base, budgetB: 200 } as const;
    assert.equal(replayVerdictLine(r, false).exitCode, 0);
    assert.equal(replayVerdictLine(r, true).exitCode, 1);
  });
});

describe("serializeReplayRecord (R6 determinism)", () => {
  it("is byte-identical across calls and carries no clock/run-id", () => {
    const r = {
      verdict: "DIVERGED" as const,
      packHashA: "a",
      packHashB: "b",
      decisionHashA: "da",
      decisionHashB: "db",
      budgetA: 100,
      budgetB: 100,
      diff: { equivalent: false, onlyInA: ["x.ts"], onlyInB: [], rangeDeltas: [] },
    };
    const j1 = serializeReplayRecord(r);
    const j2 = serializeReplayRecord(r);
    assert.equal(j1, j2);
    assert.ok(!j1.includes("timestamp") && !j1.includes("Date"));
  });
});

describe("packDecisionSet (projection precedence)", () => {
  it("prefers ast-chunks over context-bom byteRanges", () => {
    const p = pack({
      packHash: "h",
      budget: 100,
      chunks: [chunk("a.ts", 0, 10)],
      byteRangesByPath: new Map([["zzz.ts", [{ start: 0, end: 999 }]]]),
    });
    const set = packDecisionSet(p);
    assert.deepEqual(
      set.selections.map((s) => s.path),
      ["a.ts"],
      "ast-chunks wins; context-bom ignored when chunks present",
    );
  });
});

describe("loadPack (real on-disk)", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "och-replay-pack-"));
    // ast-chunks.jsonl — one canonical-JSON AstChunk per line.
    const astChunks = [
      JSON.stringify({ path: "a.ts", startByte: 0, endByte: 10, tokenCount: 3 }),
      JSON.stringify({ path: "a.ts", startByte: 10, endByte: 20, tokenCount: 2 }),
      "",
    ].join("\n");
    await writeFile(join(dir, "ast-chunks.jsonl"), astChunks, "utf8");
    // context-bom.json — CycloneDX with an opencodehub:byteRanges property.
    const contextBom = JSON.stringify({
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      components: [
        {
          type: "file",
          name: "a.ts",
          properties: [{ name: "opencodehub:byteRanges", value: JSON.stringify([[0, 20]]) }],
        },
      ],
    });
    await writeFile(join(dir, "context-bom.json"), contextBom, "utf8");
    // manifest.json — snake_case wire form. fileHashes match the bodies above.
    const manifest = JSON.stringify({
      budget_tokens: 100,
      commit: "c0ffee",
      determinism_class: "strict",
      files: [
        { kind: "ast-chunks", path: "ast-chunks.jsonl", file_hash: sha(astChunks) },
        { kind: "context-bom", path: "context-bom.json", file_hash: sha(contextBom) },
      ],
      pack_hash: "deadbeef",
      schema_version: 2,
    });
    await writeFile(join(dir, "manifest.json"), manifest, "utf8");
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("parses manifest (schema 2, no duckdb pin), ast-chunks, and context-bom ranges", async () => {
    const loaded = await loadPack(dir);
    assert.equal(loaded.manifest.packHash, "deadbeef");
    assert.equal(loaded.manifest.budgetTokens, 100);
    assert.equal(loaded.chunks.length, 2, "two ast-chunk rows parsed (blank line skipped)");
    assert.equal(loaded.byteRangesByPath.get("a.ts")?.[0]?.end, 20);
    assert.equal(loaded.integrityDrift.length, 0, "on-disk bytes match attested fileHashes");
  });

  it("flags integrity drift when a body's bytes don't match its attested hash", async () => {
    // Rewrite the manifest with a wrong fileHash for ast-chunks.
    const badManifest = JSON.stringify({
      budget_tokens: 100,
      commit: "c0ffee",
      determinism_class: "strict",
      files: [{ kind: "ast-chunks", path: "ast-chunks.jsonl", file_hash: "0".repeat(64) }],
      pack_hash: "deadbeef",
      schema_version: 2,
    });
    const badDir = await mkdtemp(join(tmpdir(), "och-replay-bad-"));
    try {
      await writeFile(
        join(badDir, "ast-chunks.jsonl"),
        '{"path":"a.ts","startByte":0,"endByte":1}',
        "utf8",
      );
      await writeFile(join(badDir, "manifest.json"), badManifest, "utf8");
      const loaded = await loadPack(badDir);
      assert.deepEqual(loaded.integrityDrift, ["ast-chunks.jsonl"]);
    } finally {
      await rm(badDir, { recursive: true, force: true });
    }
  });

  it("throws a clear error when the pack dir has no manifest", async () => {
    await assert.rejects(() => loadPack(join(tmpdir(), "no-such-pack-dir")), /no pack at/);
  });
});
