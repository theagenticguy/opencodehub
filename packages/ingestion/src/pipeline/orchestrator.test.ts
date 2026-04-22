import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { runIngestion } from "./orchestrator.js";

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
    // Topological order with alphabetic tiebreak — parse's descendants
    // (orm/routes/tools) sort lexicographically, and crossFile/mro/
    // communities/processes/annotate follow.
    assert.deepEqual(
      result.stats.phases.map((p) => p.name),
      [
        "scan",
        "incremental-scope",
        "profile",
        "dependencies",
        "sbom",
        "structure",
        "markdown",
        "parse",
        "complexity",
        "orm",
        "routes",
        "fetches",
        "openapi",
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
        "embeddings",
        "risk-snapshot",
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
    // Prisma + Supabase calls
    await fs.writeFile(
      path.join(repo, "repo.ts"),
      [
        "import { prisma } from './client.js';",
        "import { supabase } from './sb.js';",
        "export async function load() {",
        "  await prisma.User.findMany();",
        "  return supabase.from('posts').select('*');",
        "}",
        "",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(repo, "client.ts"),
      ["export const prisma = { User: {} };", ""].join("\n"),
    );
    await fs.writeFile(
      path.join(repo, "sb.ts"),
      [
        "export const supabase = { from: (_t: string) => ({ select: (_c: string) => null }) };",
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
});
