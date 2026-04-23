import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { graphHash, KnowledgeGraph, SCHEMA_VERSION } from "@opencodehub/core-types";
import type { PipelineContext } from "../types.js";
import {
  CACHE_VERSION,
  type CacheEntry,
  cacheFilePath,
  deriveCacheKey,
  readCacheEntry,
  writeCacheEntry,
} from "./content-cache.js";
import { parsePhase } from "./parse.js";
import { SCAN_PHASE_NAME, scanPhase } from "./scan.js";
import { STRUCTURE_PHASE_NAME, structurePhase } from "./structure.js";

async function runThreePhases(repo: string): Promise<{
  readonly graph: KnowledgeGraph;
  readonly parseOut: Awaited<ReturnType<typeof parsePhase.run>>;
}> {
  const ctx: PipelineContext = {
    repoPath: repo,
    options: { skipGit: true },
    graph: new KnowledgeGraph(),
    phaseOutputs: new Map(),
  };
  const scanOut = await scanPhase.run(ctx, new Map());
  const structureOut = await structurePhase.run(
    ctx,
    new Map<string, unknown>([[SCAN_PHASE_NAME, scanOut]]),
  );
  const parseOut = await parsePhase.run(
    ctx,
    new Map<string, unknown>([
      [SCAN_PHASE_NAME, scanOut],
      [STRUCTURE_PHASE_NAME, structureOut],
    ]),
  );
  return { graph: ctx.graph, parseOut };
}

async function runParseWithForce(
  repo: string,
  force: boolean,
): Promise<{
  readonly graph: KnowledgeGraph;
  readonly parseOut: Awaited<ReturnType<typeof parsePhase.run>>;
}> {
  const ctx: PipelineContext = {
    repoPath: repo,
    options: { skipGit: true, force },
    graph: new KnowledgeGraph(),
    phaseOutputs: new Map(),
  };
  const scanOut = await scanPhase.run(ctx, new Map());
  const structureOut = await structurePhase.run(
    ctx,
    new Map<string, unknown>([[SCAN_PHASE_NAME, scanOut]]),
  );
  const parseOut = await parsePhase.run(
    ctx,
    new Map<string, unknown>([
      [SCAN_PHASE_NAME, scanOut],
      [STRUCTURE_PHASE_NAME, structureOut],
    ]),
  );
  return { graph: ctx.graph, parseOut };
}

describe("parsePhase (integration)", () => {
  let repo: string;

  before(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "och-parse-"));
    await fs.writeFile(
      path.join(repo, "a.ts"),
      `export function doThing(): number {\n  return 1;\n}\n`,
    );
    await fs.writeFile(
      path.join(repo, "b.ts"),
      `import { doThing } from "./a.js";\n\nexport function caller(): number {\n  return doThing();\n}\n`,
    );
  });

  after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("emits File + Function nodes and a CALLS edge via import-scoped resolution", async () => {
    const { graph, parseOut } = await runThreePhases(repo);

    assert.equal(parseOut.fileCount, 2);

    const nodes = [...graph.nodes()];
    const files = nodes.filter((n) => n.kind === "File");
    assert.equal(files.length, 2);

    const fns = nodes.filter((n) => n.kind === "Function");
    const fnNames = fns.map((f) => f.name).sort();
    assert.ok(fnNames.includes("doThing"));
    assert.ok(fnNames.includes("caller"));

    const edges = [...graph.edges()];
    const callsEdges = edges.filter((e) => e.type === "CALLS");
    assert.ok(callsEdges.length >= 1, "expected at least one CALLS edge");

    const callerFn = fns.find((f) => f.name === "caller");
    const doThingFn = fns.find((f) => f.name === "doThing");
    assert.ok(callerFn && doThingFn);
    const resolved = callsEdges.find((e) => e.from === callerFn.id && e.to === doThingFn.id);
    assert.ok(resolved !== undefined, "expected CALLS edge caller -> doThing");
    assert.ok(
      resolved.confidence >= 0.9,
      `CALLS confidence should be >= 0.9 (import-scoped), got ${resolved.confidence}`,
    );

    const imports = edges.filter((e) => e.type === "IMPORTS");
    assert.ok(imports.length >= 1, "expected at least one IMPORTS edge from b.ts to a.ts");
  });
});

describe("parsePhase (content-cache replay)", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "och-parse-cache-"));
    await fs.writeFile(
      path.join(repo, "a.ts"),
      `export function doThing(): number {\n  return 1;\n}\n`,
    );
    await fs.writeFile(
      path.join(repo, "b.ts"),
      `import { doThing } from "./a.js";\n\nexport function caller(): number {\n  return doThing();\n}\n`,
    );
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("populates the parse-cache sidecar on first run", async () => {
    await runThreePhases(repo);
    const cacheDir = path.join(repo, ".codehub", "parse-cache");
    const stat = await fs.stat(cacheDir);
    assert.ok(stat.isDirectory(), "cache dir should exist after first run");

    // Walk the shards and confirm at least one entry landed for each source
    // file. Determinism guarantees the shard names are stable across runs
    // regardless of machine.
    const shards = await fs.readdir(cacheDir);
    let totalEntries = 0;
    for (const shard of shards) {
      const shardPath = path.join(cacheDir, shard);
      const entries = await fs.readdir(shardPath);
      totalEntries += entries.length;
      for (const entry of entries) {
        const text = await fs.readFile(path.join(shardPath, entry), "utf8");
        const parsed = JSON.parse(text) as CacheEntry;
        assert.equal(parsed.cacheVersion, CACHE_VERSION);
        assert.equal(parsed.pipelineVersion, SCHEMA_VERSION);
        // Extractions must be present (v2 shape).
        assert.ok(parsed.extractions, "entry missing extractions field");
        assert.ok(Array.isArray(parsed.extractions.definitions));
        assert.ok(Array.isArray(parsed.extractions.calls));
        assert.ok(Array.isArray(parsed.extractions.imports));
        assert.ok(Array.isArray(parsed.extractions.heritage));
      }
    }
    assert.equal(totalEntries, 2, "expected one cache entry per source file");
  });

  it("produces byte-identical graphHash across two runs (cache replay)", async () => {
    const first = await runThreePhases(repo);
    const firstHash = graphHash(first.graph);

    // Second run: every file should hit the cache. Output hash must match.
    const second = await runThreePhases(repo);
    const secondHash = graphHash(second.graph);

    assert.equal(
      firstHash,
      secondHash,
      "graphHash must be identical across cold + warm cache runs",
    );

    // Sanity: both runs see the same fileCount.
    assert.equal(first.parseOut.fileCount, second.parseOut.fileCount);

    // Extraction maps must round-trip cleanly.
    for (const [filePath, defs] of first.parseOut.definitionsByFile) {
      const secondDefs = second.parseOut.definitionsByFile.get(filePath);
      assert.ok(secondDefs, `definitions missing for ${filePath} on warm run`);
      assert.deepEqual(secondDefs, defs);
    }
    for (const [filePath, calls] of first.parseOut.callsByFile) {
      assert.deepEqual(second.parseOut.callsByFile.get(filePath), calls);
    }
    for (const [filePath, imports] of first.parseOut.importsByFile) {
      assert.deepEqual(second.parseOut.importsByFile.get(filePath), imports);
    }
    for (const [filePath, heritage] of first.parseOut.heritageByFile) {
      assert.deepEqual(second.parseOut.heritageByFile.get(filePath), heritage);
    }
  });

  it("--force bypasses cache reads but still writes fresh entries", async () => {
    // Populate the cache with a first run.
    await runThreePhases(repo);
    const cacheDir = path.join(repo, ".codehub", "parse-cache");

    // Poison every cache entry with obviously-wrong extractions. A cache
    // read would pick these up and the resulting graph would mismatch the
    // pristine one — but --force skips the read path entirely, so the
    // pipeline must re-parse and the graphHash must still match.
    const shards = await fs.readdir(cacheDir);
    for (const shard of shards) {
      const shardPath = path.join(cacheDir, shard);
      const entries = await fs.readdir(shardPath);
      for (const entry of entries) {
        const filePath = path.join(shardPath, entry);
        const text = await fs.readFile(filePath, "utf8");
        const parsed = JSON.parse(text) as CacheEntry;
        const poisoned: CacheEntry = {
          ...parsed,
          extractions: {
            definitions: [],
            calls: [],
            imports: [],
            heritage: [],
          },
        };
        await fs.writeFile(filePath, JSON.stringify(poisoned));
      }
    }

    // Baseline without --force: reads poisoned cache → empty extractions.
    const poisonedRun = await runParseWithForce(repo, false);
    const poisonedHash = graphHash(poisonedRun.graph);

    // --force run: cache reads skipped, fresh parse populates the graph.
    const forcedRun = await runParseWithForce(repo, true);
    const forcedHash = graphHash(forcedRun.graph);

    assert.notEqual(poisonedHash, forcedHash, "--force must not read poisoned cache entries");

    // The --force run must also re-populate the cache entries with the
    // correct extractions, so a subsequent non-force run matches.
    const warmRun = await runParseWithForce(repo, false);
    assert.equal(
      graphHash(warmRun.graph),
      forcedHash,
      "--force write-back must produce cache entries the next run can replay",
    );
  });

  it("treats malformed cache entries as a miss (silent re-parse)", async () => {
    // Prime the cache so shards exist, then corrupt the payload of each
    // entry. Cache reads must not throw; they simply return null and the
    // pipeline re-parses.
    await runThreePhases(repo);
    const cacheDir = path.join(repo, ".codehub", "parse-cache");
    const shards = await fs.readdir(cacheDir);
    for (const shard of shards) {
      const shardPath = path.join(cacheDir, shard);
      for (const entry of await fs.readdir(shardPath)) {
        await fs.writeFile(path.join(shardPath, entry), "{ not valid json ]");
      }
    }

    // Should not throw, and should re-populate the cache correctly.
    const rerun = await runThreePhases(repo);
    assert.ok(rerun.parseOut.fileCount > 0);

    // Verify one of the entries is now valid JSON again.
    const rewrittenShards = await fs.readdir(cacheDir);
    for (const shard of rewrittenShards) {
      const shardPath = path.join(cacheDir, shard);
      for (const entry of await fs.readdir(shardPath)) {
        const text = await fs.readFile(path.join(shardPath, entry), "utf8");
        const parsed = JSON.parse(text) as CacheEntry;
        assert.equal(parsed.cacheVersion, CACHE_VERSION);
      }
    }
  });

  it("cache misses when grammarSha in the envelope disagrees with the current key", async () => {
    // Prime the cache, then rewrite each entry to claim a different
    // grammarSha than what scan would produce today. The shape-check in
    // readCacheEntry must reject the stale entry and force a re-parse.
    await runThreePhases(repo);
    const cacheDir = path.join(repo, ".codehub", "parse-cache");
    const shards = await fs.readdir(cacheDir);

    // We can't easily change the filename (which encodes the grammarSha
    // prefix), but writing a mismatched `grammarSha` inside the envelope
    // still triggers the rejection path — the read-time integrity check
    // compares the envelope's grammarSha against the composed key.
    for (const shard of shards) {
      const shardPath = path.join(cacheDir, shard);
      for (const entry of await fs.readdir(shardPath)) {
        const filePath = path.join(shardPath, entry);
        const text = await fs.readFile(filePath, "utf8");
        const parsed = JSON.parse(text) as CacheEntry;
        const staleGrammar: CacheEntry = {
          ...parsed,
          grammarSha: "0".repeat(64), // deliberately wrong
          extractions: {
            definitions: [],
            calls: [],
            imports: [],
            heritage: [],
          },
        };
        await fs.writeFile(filePath, JSON.stringify(staleGrammar));
      }
    }

    // The rerun must NOT replay the stale entries — graph must be the same
    // as a cold run from scratch.
    const rerun = await runThreePhases(repo);
    const coldRepo = await mkdtemp(path.join(tmpdir(), "och-parse-cache-cold-"));
    try {
      await fs.writeFile(
        path.join(coldRepo, "a.ts"),
        `export function doThing(): number {\n  return 1;\n}\n`,
      );
      await fs.writeFile(
        path.join(coldRepo, "b.ts"),
        `import { doThing } from "./a.js";\n\nexport function caller(): number {\n  return doThing();\n}\n`,
      );
      const cold = await runThreePhases(coldRepo);
      assert.equal(
        graphHash(rerun.graph),
        graphHash(cold.graph),
        "stale-grammar entries must be ignored so output matches a cold run",
      );
    } finally {
      await rm(coldRepo, { recursive: true, force: true });
    }
  });

  it("round-trips definitions, calls, imports, and heritage through the cache", async () => {
    // Use a second fixture that exercises heritage (EXTENDS) as well as
    // CALLS/IMPORTS, so every extraction bucket is non-empty.
    await fs.writeFile(
      path.join(repo, "base.ts"),
      `export class Base {\n  protected greet(): string { return "hi"; }\n}\n`,
    );
    await fs.writeFile(
      path.join(repo, "sub.ts"),
      `import { Base } from "./base.js";\n\nexport class Sub extends Base {\n  public run(): string { return this.greet(); }\n}\n`,
    );

    const first = await runThreePhases(repo);
    const firstHash = graphHash(first.graph);

    // Confirm the cache actually captured extractions with each kind.
    const cacheDir = path.join(repo, ".codehub", "parse-cache");
    let sawDefs = false;
    let sawCalls = false;
    let sawImports = false;
    let sawHeritage = false;
    for (const shard of await fs.readdir(cacheDir)) {
      const shardPath = path.join(cacheDir, shard);
      for (const entry of await fs.readdir(shardPath)) {
        const text = await fs.readFile(path.join(shardPath, entry), "utf8");
        const parsed = JSON.parse(text) as CacheEntry;
        if (parsed.extractions.definitions.length > 0) sawDefs = true;
        if (parsed.extractions.calls.length > 0) sawCalls = true;
        if (parsed.extractions.imports.length > 0) sawImports = true;
        if (parsed.extractions.heritage.length > 0) sawHeritage = true;
      }
    }
    assert.ok(sawDefs, "cache should retain at least one definition");
    assert.ok(sawCalls, "cache should retain at least one call");
    assert.ok(sawImports, "cache should retain at least one import");
    assert.ok(sawHeritage, "cache should retain at least one heritage record");

    // Second run: must be byte-identical to the first.
    const second = await runThreePhases(repo);
    assert.equal(firstHash, graphHash(second.graph));
  });

  it("write-back failure warns but does not abort the pipeline", async () => {
    // Force the write path to fail by making the cache dir a *file* the
    // writer cannot mkdir into. This simulates disk-full or permission
    // errors without needing platform-specific tricks.
    const cacheRoot = path.join(repo, ".codehub");
    await fs.mkdir(cacheRoot, { recursive: true });
    await fs.writeFile(path.join(cacheRoot, "parse-cache"), "not a directory");

    const warnings: string[] = [];
    const ctx: PipelineContext = {
      repoPath: repo,
      options: { skipGit: true },
      graph: new KnowledgeGraph(),
      phaseOutputs: new Map(),
      onProgress: (ev) => {
        if (ev.kind === "warn" && ev.message !== undefined) warnings.push(ev.message);
      },
    };
    const scanOut = await scanPhase.run(ctx, new Map());
    const structureOut = await structurePhase.run(
      ctx,
      new Map<string, unknown>([[SCAN_PHASE_NAME, scanOut]]),
    );
    // Must not throw.
    const parseOut = await parsePhase.run(
      ctx,
      new Map<string, unknown>([
        [SCAN_PHASE_NAME, scanOut],
        [STRUCTURE_PHASE_NAME, structureOut],
      ]),
    );
    assert.ok(parseOut.fileCount > 0, "pipeline must still complete despite write failures");
    // And emit at least one warning about the cache write failure.
    assert.ok(
      warnings.some((w) => w.includes("parse-cache")),
      `expected a parse-cache warning; got: ${warnings.join(" | ")}`,
    );
  });
});

describe("parsePhase (cache-hit timing)", () => {
  // This guard quantifies the warm-cache win: once every file has a valid
  // parse-cache entry, re-running the parse phase must be materially faster
  // than the cold baseline. We assert a loose "<=80% of cold" ceiling so CI
  // variance doesn't cause flakes.
  //
  // Skipped in CI envs that set CI=1 because container runners frequently
  // exhibit enough noise to violate even generous thresholds.
  const skipOnCI = process.env["CI"] === "true" || process.env["CI"] === "1";
  let repo: string;

  before(async () => {
    if (skipOnCI) return;
    repo = await mkdtemp(path.join(tmpdir(), "och-parse-timing-"));
    // 40 files keeps the run under a second on warm; 100 as in the plan
    // pushes the tmpdir / provider reuse without adding signal. Each file
    // is a standalone module with a single export so there are real
    // captures to extract (not a zero-work benchmark).
    for (let i = 0; i < 40; i += 1) {
      const lines = [
        `export function fn${i}(a: number, b: number): number {`,
        "  let acc = 0;",
        "  for (let j = 0; j < a; j += 1) acc += j * b;",
        "  return acc;",
        "}",
        "",
      ].join("\n");
      await fs.writeFile(path.join(repo, `mod${i}.ts`), lines);
    }
  });

  after(async () => {
    if (skipOnCI) return;
    await rm(repo, { recursive: true, force: true });
  });

  it("warm cache run completes within 80% of cold baseline", async (t) => {
    if (skipOnCI) {
      t.skip("timing test is noisy on CI; gating locally only");
      return;
    }
    // Cold: ensure the cache directory is empty before the first run.
    await rm(path.join(repo, ".codehub"), { recursive: true, force: true });
    const coldStart = Date.now();
    const cold = await runThreePhases(repo);
    const coldMs = Date.now() - coldStart;
    assert.equal(cold.parseOut.cacheHits, 0, "cold run should have zero hits");

    // Warm: cache is populated; subsequent runs should hit 100%.
    const warmStart = Date.now();
    const warm = await runThreePhases(repo);
    const warmMs = Date.now() - warmStart;
    assert.equal(warm.parseOut.cacheMisses, 0, "warm run should hit every file in the cache");
    assert.equal(warm.parseOut.cacheHits, warm.parseOut.fileCount);

    // Even with a tiny 40-file fixture the warm path skips the worker
    // pool and provider recomputation — we expect a >20% wall-clock win.
    // The lenient threshold accounts for noisy laptops; failure here is
    // a regression signal, not a precise SLA.
    assert.ok(warmMs < coldMs * 0.8, `warm ${warmMs}ms should be < 80% of cold ${coldMs}ms`);
  });
});

describe("parsePhase (cache-hit stats)", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "och-parse-stats-"));
    for (let i = 0; i < 3; i += 1) {
      await fs.writeFile(path.join(repo, `m${i}.ts`), `export const v${i} = ${i};\n`);
    }
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("cold run reports cacheHits=0, cacheMisses=fileCount", async () => {
    const { parseOut } = await runThreePhases(repo);
    assert.equal(parseOut.cacheHits, 0);
    assert.equal(parseOut.cacheMisses, parseOut.fileCount);
  });

  it("warm run reports cacheHits=fileCount, cacheMisses=0", async () => {
    await runThreePhases(repo);
    const { parseOut } = await runThreePhases(repo);
    assert.equal(parseOut.cacheHits, parseOut.fileCount);
    assert.equal(parseOut.cacheMisses, 0);
  });

  it("--force reports cacheHits=0 even when the cache is populated", async () => {
    await runThreePhases(repo);
    const { parseOut } = await runParseWithForce(repo, true);
    assert.equal(parseOut.cacheHits, 0);
    assert.equal(parseOut.cacheMisses, parseOut.fileCount);
  });
});

describe("parsePhase (cache key determinism)", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "och-parse-cachekey-"));
    await fs.writeFile(
      path.join(repo, "only.ts"),
      `export function onlyFn(): number {\n  return 42;\n}\n`,
    );
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("replay round-trip via direct cache helpers is deep-equal to a live parse", async () => {
    // Run once to populate the cache.
    const first = await runThreePhases(repo);

    // Scan the file to get its sha256 + grammarSha, then manually read back
    // the entry via readCacheEntry. The extractions must match what the
    // live run produced.
    const ctx: PipelineContext = {
      repoPath: repo,
      options: { skipGit: true },
      graph: new KnowledgeGraph(),
      phaseOutputs: new Map(),
    };
    const scanOut = await scanPhase.run(ctx, new Map());
    const file = scanOut.files.find((f) => f.relPath === "only.ts");
    assert.ok(file !== undefined);
    assert.ok(file.grammarSha !== null);

    const key = deriveCacheKey(file.sha256, file.grammarSha, SCHEMA_VERSION);
    const cacheDir = path.join(repo, ".codehub", "parse-cache");
    const entry = await readCacheEntry(cacheDir, key);
    assert.ok(entry !== null, "cache entry must be readable via derived key");

    const liveDefs = first.parseOut.definitionsByFile.get("only.ts");
    assert.deepEqual(entry.extractions.definitions, liveDefs);

    // Round-trip: rewrite the entry and read it back — must equal the
    // original.
    const rewrite: CacheEntry = { ...entry };
    await writeCacheEntry(cacheDir, key, rewrite);
    const reread = await readCacheEntry(cacheDir, key);
    assert.deepEqual(reread, entry);

    // Sanity: cacheFilePath is stable across calls.
    assert.equal(cacheFilePath(cacheDir, key), cacheFilePath(cacheDir, key));
  });
});
