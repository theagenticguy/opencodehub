/**
 *— incremental determinism gate.
 *
 * Proves that `--full` and `--incremental` analyses of the same commit
 * produce byte-identical graph hashes. Without this test the four
 * consumers (crossFile/mro/communities/processes) could silently drift on
 * the carry-forward path the moment a phase author changed the order in
 * which they emit edges, and the drift would only show up in consumers of
 * the persisted graph (diffs, wikis, AI context) — far from the root
 * cause. We assert the hash-level invariant here so CI catches any
 * regression immediately.
 *
 * Test matrix:
 *   A. Full(commit A)  ≡  Full(commit A)           [v1.0 baseline smoke]
 *   B. Full(commit A)  ≡  Incremental(commit A + touch)  [carry-forward
 *                                                           under no semantic
 *                                                           change]
 *   C. Full(commit A)  ≡  Incremental(commit A, closure empty)
 */

import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { runIngestion } from "./orchestrator.js";
import type { PreviousGraph } from "./types.js";

/**
 * Lift a run's graph + scan output into a {@link PreviousGraph} suitable
 * for the next run's `incrementalFrom`. We materialise the full node /
 * edge snapshot here soconsumers can carry forward non-closure
 * contributions verbatim; the minimal projection (files / importEdges /
 * heritageEdges) still drives the closure walk.
 */
function previousGraphFromResult(result: Awaited<ReturnType<typeof runIngestion>>): PreviousGraph {
  const scanFiles = result.scan?.files ?? [];
  const files = scanFiles.map((f) => ({ relPath: f.relPath, contentSha: f.sha256 }));
  const importEdges: { readonly importer: string; readonly target: string }[] = [];
  const heritageEdges: { readonly childFile: string; readonly parentFile: string }[] = [];
  // File-path recovery from File:<path>:<path> node ids.
  const fileIdToPath = new Map<string, string>();
  for (const n of result.graph.nodes()) {
    if (n.kind === "File") fileIdToPath.set(n.id, n.filePath);
  }
  for (const e of result.graph.edges()) {
    if (e.type === "IMPORTS") {
      const from = fileIdToPath.get(e.from as string);
      const to = fileIdToPath.get(e.to as string);
      if (from !== undefined && to !== undefined) {
        importEdges.push({ importer: from, target: to });
      }
    } else if (e.type === "EXTENDS" || e.type === "IMPLEMENTS") {
      // Heritage edges connect symbols; we project them down to their
      // defining-file pair for the closure walk.
      const fromNode = result.graph.getNode(e.from);
      const toNode = result.graph.getNode(e.to);
      if (fromNode !== undefined && toNode !== undefined) {
        heritageEdges.push({
          childFile: fromNode.filePath,
          parentFile: toNode.filePath,
        });
      }
    }
  }
  return {
    files,
    importEdges,
    heritageEdges,
    nodes: [...result.graph.nodes()],
    edges: [...result.graph.edges()],
  };
}

async function writeFixture(repo: string): Promise<void> {
  // A non-trivial repo with enough files that touching a single one keeps
  // the closure well below incremental-scope's 30% safety valve. The
  // heritage chain + cross-file calls ensure everyconsumer has
  // real work to do.
  await fs.writeFile(
    path.join(repo, "base.ts"),
    ["export class Base {", "  hello(): string { return 'base'; }", "}", ""].join("\n"),
  );
  await fs.writeFile(
    path.join(repo, "child.ts"),
    [
      "import { Base } from './base.js';",
      "export class Child extends Base {",
      "  override hello(): string { return 'child'; }",
      "  greet(): string { return this.hello(); }",
      "}",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(repo, "entry.ts"),
    [
      "import { Child } from './child.js';",
      "export function handleRequest(): string {",
      "  const c = new Child();",
      "  return step1(c);",
      "}",
      "function step1(c: Child): string {",
      "  return step2(c);",
      "}",
      "function step2(c: Child): string {",
      "  return c.greet();",
      "}",
      "",
    ].join("\n"),
  );
  // Padding: 20 unrelated leaf files keep the total count high enough
  // that a single-file touch's closure stays well under the 30% valve.
  for (let i = 0; i < 20; i += 1) {
    const name = `pad${i.toString().padStart(2, "0")}.ts`;
    await fs.writeFile(
      path.join(repo, name),
      [`export function pad${i}(): number { return ${i}; }`, ""].join("\n"),
    );
  }
}

describe("incremental-determinism", () => {
  it("Test A: full run twice at the same commit produces identical hashes", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-inc-det-a-"));
    try {
      await writeFixture(repo);
      const one = await runIngestion(repo, { skipGit: true });
      const two = await runIngestion(repo, { skipGit: true });
      assert.equal(one.graphHash, two.graphHash, "two full runs drifted");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("Test C: incremental with no closure (prior graph same commit) equals full hash", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-inc-det-c-"));
    try {
      await writeFixture(repo);
      const fullRun = await runIngestion(repo, { skipGit: true });
      const prior = previousGraphFromResult(fullRun);
      // Second run: same files, same hashes → closure is empty;
      // consumers must carry forward the prior graph verbatim.
      const incRun = await runIngestion(repo, {
        skipGit: true,
        incrementalFrom: prior,
      });
      assert.equal(
        incRun.incrementalScope?.mode,
        "incremental",
        "expected incremental mode when prior graph is supplied",
      );
      assert.equal(
        incRun.incrementalScope?.closureFiles.length,
        0,
        "expected empty closure when nothing changed",
      );
      assert.equal(
        incRun.graphHash,
        fullRun.graphHash,
        "incremental hash drifted from full hash under zero-change",
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("Test B: touch one file with no semantic change → incremental hash equals full hash", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-inc-det-b-"));
    try {
      await writeFixture(repo);
      const fullRun = await runIngestion(repo, { skipGit: true });
      const prior = previousGraphFromResult(fullRun);

      // "Touch" entry.ts with an mtime-only bump — same content bytes, so
      // sha256 is unchanged and the File node's `contentHash` field still
      // matches the prior run. In the incremental-scope phase the file is
      // unchanged so the closure stays empty; determinism collapses to
      // Test C's shape but via a real mtime touch instead of a no-op
      // rebuild. This matches the scope's contract: byte-identical inputs
      // produce byte-identical graph hashes.
      //
      // We intentionally do NOT test a content-diff touch here: the File
      // node persists `contentHash` (structure.ts line 101), so any content
      // drift changes the graph hash by design. The determinism gate is
      // about the *pipeline* being pure, not about content-oblivious
      // hashing — that is a product decision pinned in
      const entryPath = path.join(repo, "entry.ts");
      const now = new Date();
      await fs.utimes(entryPath, now, now);

      const incRun = await runIngestion(repo, {
        skipGit: true,
        incrementalFrom: prior,
      });
      assert.equal(incRun.incrementalScope?.mode, "incremental");
      assert.equal(
        incRun.graphHash,
        fullRun.graphHash,
        "incremental hash drifted from full hash after an mtime-only touch",
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
