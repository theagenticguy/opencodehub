import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { runIngestion, shouldTripZeroSymbolGuard } from "./orchestrator.js";
import type { PipelineContext, PipelineOptions, PipelinePhase, PreviousGraph } from "./types.js";

describe("runIngestion (end-to-end)", () => {
  let repo: string;

  before(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "och-orch-"));
    await fs.writeFile(
      path.join(repo, "greeter.ts"),
      `export interface Greeting {\n  text: string;\n}\n\nexport function greet(name: string): Greeting {\n  return { text: "hello " + name };\n}\n`,
    );
    await fs.writeFile(
      path.join(repo, "main.ts"),
      `import { greet } from "./greeter.js";\n\nexport function run(): void {\n  const g = greet("world");\n  console.log(g.text);\n}\n`,
    );
    await fs.writeFile(path.join(repo, "README.md"), "# sample repo\n");
  });

  after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("runs scan + structure + parse and returns a hashed graph", async () => {
    const result = await runIngestion(repo, { skipGit: true });
    assert.ok(result.graphHash.length === 64, "graphHash must be sha256 hex");
    assert.ok(result.stats.nodeCount >= 2, "should have File + definition nodes");
    assert.ok(result.stats.edgeCount >= 1);
    // Topological order with alphabetic tiebreak. `profile` now depends on
    // `parse` (so framework-detection stage 5 sees the parse-emitted IMPORTS
    // edges), which lands it — plus its dependents `dependencies`/`repo-node`/
    // `coverage`/`sbom` — after `parse`/`complexity`/`orm`.
    assert.deepEqual(
      result.stats.phases.map((p) => p.name),
      [
        "scan",
        "incremental-scope",
        "structure",
        "markdown",
        "parse",
        "business-logic",
        "complexity",
        "orm",
        "profile",
        "coverage",
        "dependencies",
        "repo-node",
        "routes",
        "fetches",
        "openapi",
        "sbom",
        "temporal",
        "cochange",
        "tools",
        "crossFile",
        "accesses",
        "mro",
        "communities",
        "dead-code",
        "ownership",
        "processes",
        "annotate",
        "risk-snapshot",
        "scip-index",
        "confidence-demote",
        "summarize",
        "embeddings",
      ],
    );
  });

  it("produces a byte-identical graphHash across two runs on the same repo", async () => {
    const one = await runIngestion(repo, { skipGit: true });
    const two = await runIngestion(repo, { skipGit: true });
    assert.equal(one.graphHash, two.graphHash);
    assert.equal(one.stats.nodeCount, two.stats.nodeCount);
    assert.equal(one.stats.edgeCount, two.stats.edgeCount);
  });
});

describe("runIngestion option normalization", () => {
  let repo: string;

  before(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "och-opts-"));
    await fs.writeFile(path.join(repo, "README.md"), "# opts\n");
  });

  after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("threads every PipelineOptions field through to ctx.options", async () => {
    // A probe phase captures the normalized per-phase options bag. Running it
    // as the sole phase keeps the assertion fast and isolated from the real
    // DAG while still exercising the orchestrator's option normalization.
    let seen: PipelineOptions | undefined;
    const probe: PipelinePhase = {
      name: "probe",
      deps: [],
      run(ctx: PipelineContext): Promise<undefined> {
        seen = ctx.options;
        return Promise.resolve(undefined);
      },
    };

    // One representative non-default value per declared PipelineOptions field,
    // so a dropped field surfaces as a missing/undefined value below.
    const prior: PreviousGraph = { files: [], importEdges: [], heritageEdges: [] };
    const options: Required<PipelineOptions> = {
      force: true,
      incrementalFrom: prior,
      offline: true,
      verbose: true,
      skipGit: true,
      byteCapPerFile: 12_345,
      maxTotalFiles: 678,
      embeddings: true,
      embeddingsVariant: "int8",
      embeddingsModelDir: "/tmp/model-dir",
      embeddingsGranularity: ["symbol", "file", "community"],
      embeddingsWorkers: 4,
      embeddingsBatchSize: 16,
      sbom: true,
      reproducibleSbom: false,
      coverage: true,
      summaries: true,
      maxSummariesPerRun: 7,
      summaryModel: "model-x",
      strictDetectors: true,
      allowBuildScripts: ["proleap"],
    };

    await runIngestion(repo, { ...options, phases: [probe] });

    assert.ok(seen !== undefined, "probe phase did not run");
    // Every declared field must survive stripPhaseKeys. This is the
    // regression guard: the prior allowlist silently dropped
    // embeddingsWorkers / embeddingsBatchSize / coverage / strictDetectors.
    for (const key of Object.keys(options) as (keyof PipelineOptions)[]) {
      assert.deepEqual(
        seen[key],
        options[key],
        `PipelineOptions.${String(key)} must round-trip into ctx.options`,
      );
    }
    // The four previously dropped fields, asserted explicitly so a future
    // regression names them directly.
    assert.equal(seen.embeddingsWorkers, 4);
    assert.equal(seen.embeddingsBatchSize, 16);
    assert.equal(seen.coverage, true);
    assert.equal(seen.strictDetectors, true);
    assert.deepEqual(seen.allowBuildScripts, ["proleap"]);
  });

  it("drops orchestrator-only keys from ctx.options", async () => {
    let seen: Record<string, unknown> | undefined;
    const probe: PipelinePhase = {
      name: "probe",
      deps: [],
      run(ctx: PipelineContext): Promise<undefined> {
        seen = ctx.options as Record<string, unknown>;
        return Promise.resolve(undefined);
      },
    };

    await runIngestion(repo, {
      skipGit: true,
      phases: [probe],
      onProgress: () => {},
      summaryCacheAdapter: { lookup: () => Promise.resolve(undefined) },
      embeddingHashCacheAdapter: { list: () => Promise.resolve(new Map()) },
    });

    assert.ok(seen !== undefined);
    assert.equal(seen["phases"], undefined, "phases must not leak into ctx.options");
    assert.equal(seen["onProgress"], undefined, "onProgress must not leak into ctx.options");
  });
});

describe("runIngestion coverage overlay", () => {
  let repo: string;

  before(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "och-cov-e2e-"));
    await fs.mkdir(path.join(repo, "src"), { recursive: true });
    await fs.writeFile(
      path.join(repo, "src", "foo.ts"),
      "export function foo(): number {\n  return 1;\n}\n",
    );
    await fs.mkdir(path.join(repo, "coverage"), { recursive: true });
    await fs.writeFile(
      path.join(repo, "coverage", "lcov.info"),
      ["TN:", "SF:src/foo.ts", "DA:1,1", "DA:2,0", "end_of_record", ""].join("\n"),
    );
  });

  after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("annotates a File node when --coverage is enabled and an lcov report is present", async () => {
    // Regression guard: the coverage phase used to be absent from
    // DEFAULT_PHASES, so `coverage: true` was inert under the default
    // pipeline. This drives the full DAG and asserts the File node gains
    // coverage fields.
    const result = await runIngestion(repo, { skipGit: true, coverage: true });

    const coverageRan = result.stats.phases.some((p) => p.name === "coverage");
    assert.ok(coverageRan, "coverage phase must run in the default pipeline");

    const foo = [...result.graph.nodes()].find(
      (n) => n.kind === "File" && n.filePath === "src/foo.ts",
    ) as { coveragePercent?: number; coveredLines?: readonly number[] } | undefined;
    assert.ok(foo !== undefined, "src/foo.ts File node missing");
    assert.equal(foo.coveragePercent, 0.5, "coveragePercent must reflect the lcov report");
    assert.deepEqual(foo.coveredLines, [1], "coveredLines must reflect the lcov report");
  });

  it("leaves File nodes unannotated when --coverage is not passed", async () => {
    const result = await runIngestion(repo, { skipGit: true });
    const foo = [...result.graph.nodes()].find(
      (n) => n.kind === "File" && n.filePath === "src/foo.ts",
    ) as { coveragePercent?: number } | undefined;
    assert.ok(foo !== undefined);
    assert.equal(foo.coveragePercent, undefined, "coverage must stay off by default");
  });
});

describe("runIngestion (determinism with routes + ORM)", () => {
  let repo: string;

  before(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "och-det-"));
    // Next.js App Router endpoint
    await fs.mkdir(path.join(repo, "app", "api", "users"), { recursive: true });
    await fs.writeFile(
      path.join(repo, "app", "api", "users", "route.ts"),
      [
        "export async function GET(): Promise<Response> { return new Response(); }",
        "export async function POST(): Promise<Response> { return new Response(); }",
        "",
      ].join("\n"),
    );
    // Express handler
    await fs.writeFile(
      path.join(repo, "server.ts"),
      [
        "const app = require('express')();",
        "app.get('/health', (_req, res) => res.json({ ok: true }));",
        "",
      ].join("\n"),
    );
    // Prisma + Supabase calls. Imports point at the real ORM modules so
    // the P06 receiver check recognises them as confirmed client calls.
    await fs.writeFile(
      path.join(repo, "repo.ts"),
      [
        "import { PrismaClient } from '@prisma/client';",
        "import { createClient } from '@supabase/supabase-js';",
        "const prisma = new PrismaClient();",
        "const supabase = createClient('', '');",
        "export async function load() {",
        "  await prisma.User.findMany();",
        "  return supabase.from('posts').select('*');",
        "}",
        "",
      ].join("\n"),
    );
    // Markdown with links
    await fs.writeFile(
      path.join(repo, "README.md"),
      ["# Docs", "", "See [guide](./guide.md).", ""].join("\n"),
    );
    await fs.writeFile(path.join(repo, "guide.md"), "# Guide\n");
  });

  after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("yields identical graphHash across three full-pipeline runs", async () => {
    const one = await runIngestion(repo, { skipGit: true });
    const two = await runIngestion(repo, { skipGit: true });
    const three = await runIngestion(repo, { skipGit: true });
    assert.equal(one.graphHash, two.graphHash, "full pipeline must be byte-deterministic");
    assert.equal(two.graphHash, three.graphHash, "full pipeline must be byte-deterministic");
    assert.equal(one.stats.nodeCount, two.stats.nodeCount);
    assert.equal(two.stats.nodeCount, three.stats.nodeCount);
    assert.equal(one.stats.edgeCount, two.stats.edgeCount);
    assert.equal(two.stats.edgeCount, three.stats.edgeCount);

    // Sanity: all phases ran
    const phaseNames = one.stats.phases.map((p) => p.name);
    assert.ok(phaseNames.includes("markdown"));
    assert.ok(phaseNames.includes("routes"));
    assert.ok(phaseNames.includes("tools"));
    assert.ok(phaseNames.includes("orm"));
    assert.ok(phaseNames.includes("crossFile"));
    assert.ok(phaseNames.includes("mro"));
    assert.ok(phaseNames.includes("communities"));
    assert.ok(phaseNames.includes("processes"));
    assert.ok(phaseNames.includes("annotate"));

    // And the right shape of graph landed.
    const hasRoute = [...one.graph.nodes()].some((n) => n.kind === "Route");
    const hasQueries = [...one.graph.edges()].some((e) => e.type === "QUERIES");
    const hasRef = [...one.graph.edges()].some((e) => e.type === "REFERENCES");
    assert.ok(hasRoute, "Route node missing");
    assert.ok(hasQueries, "QUERIES edge missing");
    assert.ok(hasRef, "REFERENCES edge missing");
  });
});

describe("runIngestion (determinism with communities + processes)", () => {
  let repo: string;

  before(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "och-comm-proc-det-"));
    // Several tightly coupled functions — a clustering seed.
    // Each file is a densely connected clique so Leiden produces a
    // cluster with >= 3 members (the `communities` phase drops smaller
    // degenerate partitions as unclustered).
    await fs.writeFile(
      path.join(repo, "auth.ts"),
      [
        "export function login() { hash(); token(); verify(); }",
        "export function logout() { token(); verify(); }",
        "function hash() { token(); verify(); return 1; }",
        "function token() { hash(); verify(); return 2; }",
        "function verify() { hash(); token(); return true; }",
        "",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(repo, "handler.ts"),
      [
        "export function handleRequest() { return validate(); }",
        "function validate() { return parse() && normalize(); }",
        "function parse() { normalize(); return true; }",
        "function normalize() { parse(); return 'ok'; }",
        "function finalize() { parse(); normalize(); validate(); return 0; }",
        "",
      ].join("\n"),
    );
  });

  after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("produces byte-identical graphHash across three runs with the full 12-phase DAG", async () => {
    const one = await runIngestion(repo, { skipGit: true });
    const two = await runIngestion(repo, { skipGit: true });
    const three = await runIngestion(repo, { skipGit: true });
    assert.equal(one.graphHash, two.graphHash);
    assert.equal(two.graphHash, three.graphHash);

    // At least one Community and at least one Process must land.
    const hasCommunity = [...one.graph.nodes()].some((n) => n.kind === "Community");
    const hasProcess = [...one.graph.nodes()].some((n) => n.kind === "Process");
    assert.ok(hasCommunity, "Community node missing");
    assert.ok(hasProcess, "Process node missing");
  });

  it("does NOT trip the zero-symbol guard on a healthy repo with real symbols", async () => {
    const result = await runIngestion(repo, { skipGit: true });
    assert.notEqual(
      result.zeroSymbolGuardTripped,
      true,
      "guard must stay quiet when symbols extracted",
    );
    const fnCount = [...result.graph.nodes()].filter((n) => n.kind === "Function").length;
    assert.ok(fnCount >= 1, "the TS fixture must yield at least one Function node");
  });
});

describe("shouldTripZeroSymbolGuard", () => {
  it("trips only when enough tree-sitter files yielded zero symbols", () => {
    // A globally-broken parser: many files, zero symbols.
    assert.equal(shouldTripZeroSymbolGuard(100, 0), true);
    assert.equal(shouldTripZeroSymbolGuard(5, 0), true);
    // Below the floor — a tiny repo is too small to distinguish broken-vs-sparse.
    assert.equal(shouldTripZeroSymbolGuard(4, 0), false);
    // Healthy — symbols were extracted.
    assert.equal(shouldTripZeroSymbolGuard(5, 3), false);
    assert.equal(shouldTripZeroSymbolGuard(100, 1), false);
    // Legitimately-empty (configs-only / cobol-only / unsupported) — no
    // tree-sitter files at all, so the guard never fires.
    assert.equal(shouldTripZeroSymbolGuard(0, 0), false);
  });
});
