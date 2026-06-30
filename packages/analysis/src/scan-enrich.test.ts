/**
 * Tests for `buildScanEnrichment` — the per-result graph-signal map the scan
 * pipeline feeds `enrichWithProperties`.
 *
 * Regression context: `enrichWithProperties` had zero production callers, so
 * `scan.sarif` shipped with no `opencodehub.*` graph signals. These tests pin
 * that the builder maps a result to its File node's signals, keyed by the
 * `primaryLocationLineHash` fingerprint (run-structure-independent).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { SarifLog } from "@opencodehub/sarif";
import { buildScanEnrichment } from "./scan-enrich.js";
import { FakeStore } from "./test-utils.js";

/** Minimal SARIF result with a primary-location uri + fingerprint (+ line). */
function result(uri: string, fingerprint: string, startLine?: number) {
  return {
    ruleId: "demo-rule",
    level: "warning",
    message: { text: "x" },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri },
          ...(startLine !== undefined ? { region: { startLine } } : {}),
        },
      },
    ],
    partialFingerprints: { primaryLocationLineHash: fingerprint },
  };
}

function logWith(results: ReadonlyArray<ReturnType<typeof result>>): SarifLog {
  return {
    version: "2.1.0",
    runs: [{ tool: { driver: { name: "demo", rules: [] } }, results }],
  } as unknown as SarifLog;
}

test("buildScanEnrichment maps a result to its File node signals by fingerprint", async () => {
  const store = new FakeStore();
  store.addNode({
    id: "File:src/a.ts:src/a.ts",
    kind: "File",
    name: "a.ts",
    filePath: "src/a.ts",
    busFactor: 2,
    fixFollowFeatDensity: 0.5,
  });
  const log = logWith([result("src/a.ts", "fp-a")]);

  const enrichment = await buildScanEnrichment(store, log, "/repo");
  const byFp = enrichment.byResultFingerprint;
  assert.ok(byFp !== undefined, "byResultFingerprint must be present");
  assert.deepEqual(byFp?.get("fp-a"), { busFactor: 2, temporalFixDensity: 0.5 });
  // Run-level stamp is deterministic (no clock / run id).
  assert.deepEqual(enrichment.run, { enrichmentVersion: "2", sources: ["graph"] });
});

test("buildScanEnrichment normalizes an absolute result uri to the repo-relative node id", async () => {
  // Scanners (e.g. semgrep) emit absolute uris; the File node id is keyed by
  // the repo-relative path, so the builder must strip the repoPath prefix or
  // it would never match — the bug this normalization fixes.
  const store = new FakeStore();
  store.addNode({
    id: "File:src/a.ts:src/a.ts",
    kind: "File",
    name: "a.ts",
    filePath: "src/a.ts",
    busFactor: 4,
  });
  const log = logWith([result("/repo/src/a.ts", "fp-abs")]);

  const enrichment = await buildScanEnrichment(store, log, "/repo");
  assert.deepEqual(enrichment.byResultFingerprint?.get("fp-abs"), { busFactor: 4 });
});

test("buildScanEnrichment omits results whose file has no materialized signals", async () => {
  const store = new FakeStore();
  store.addNode({
    id: "File:src/bare.ts:src/bare.ts",
    kind: "File",
    name: "bare.ts",
    filePath: "src/bare.ts",
  });
  const log = logWith([result("src/bare.ts", "fp-bare")]);

  const enrichment = await buildScanEnrichment(store, log, "/repo");
  // No signals → no per-result map, but the run-level stamp still returns.
  assert.equal(enrichment.byResultFingerprint, undefined);
  assert.deepEqual(enrichment.run, { enrichmentVersion: "2", sources: ["graph"] });
});

test("buildScanEnrichment is byte-stable across two runs (no clock/run id)", async () => {
  const store = new FakeStore();
  store.addNode({
    id: "File:src/a.ts:src/a.ts",
    kind: "File",
    name: "a.ts",
    filePath: "src/a.ts",
    busFactor: 3,
  });
  const log = logWith([result("src/a.ts", "fp-a")]);

  const a = await buildScanEnrichment(store, log, "/repo");
  const b = await buildScanEnrichment(store, log, "/repo");
  assert.deepEqual(a, b);
});

test("buildScanEnrichment returns only the run stamp for an empty log", async () => {
  const store = new FakeStore();
  const enrichment = await buildScanEnrichment(store, logWith([]), "/repo");
  assert.equal(enrichment.byResultFingerprint, undefined);
  assert.deepEqual(enrichment.run, { enrichmentVersion: "2", sources: ["graph"] });
});

// ---------------------------------------------------------------------------
// Symbol-level signals: blastRadius (upstream runImpact) + community.
// ---------------------------------------------------------------------------

/** Add a File + an enclosing Function spanning lines 1-20 in one helper. */
function addFileWithFn(store: FakeStore, file: string, fnId: string): void {
  store.addNode({ id: `File:${file}:${file}`, kind: "File", name: file, filePath: file });
  store.addNode({
    id: fnId,
    kind: "Function",
    name: "target",
    filePath: file,
    startLine: 1,
    endLine: 20,
  });
}

test("buildScanEnrichment attaches blastRadius from the finding's enclosing symbol", async () => {
  const store = new FakeStore();
  addFileWithFn(store, "src/a.ts", "Function:src/a.ts:target#0");
  // One caller → upstream blast radius of 1 for the target.
  store.addNode({
    id: "Function:src/b.ts:caller#0",
    kind: "Function",
    name: "caller",
    filePath: "src/b.ts",
    startLine: 1,
    endLine: 5,
  });
  store.addEdge({
    fromId: "Function:src/b.ts:caller#0",
    toId: "Function:src/a.ts:target#0",
    type: "CALLS",
    confidence: 0.9,
  });

  // Finding on line 10 → inside target (1-20).
  const enrichment = await buildScanEnrichment(
    store,
    logWith([result("src/a.ts", "fp-x", 10)]),
    "/repo",
  );
  assert.equal(enrichment.byResultFingerprint?.get("fp-x")?.blastRadius, 1);
});

test("buildScanEnrichment attaches community label from MEMBER_OF", async () => {
  const store = new FakeStore();
  addFileWithFn(store, "src/a.ts", "Function:src/a.ts:target#0");
  store.addNode({
    id: "Community:1",
    kind: "Community",
    name: "auth",
    filePath: "<communities>",
    inferredLabel: "auth-core",
  });
  store.addEdge({
    fromId: "Function:src/a.ts:target#0",
    toId: "Community:1",
    type: "MEMBER_OF",
    confidence: 1,
  });

  const enrichment = await buildScanEnrichment(
    store,
    logWith([result("src/a.ts", "fp-x", 10)]),
    "/repo",
  );
  assert.equal(enrichment.byResultFingerprint?.get("fp-x")?.community, "auth-core");
});

test("buildScanEnrichment merges file + symbol signals on one result", async () => {
  const store = new FakeStore();
  store.addNode({
    id: "File:src/a.ts:src/a.ts",
    kind: "File",
    name: "a.ts",
    filePath: "src/a.ts",
    busFactor: 3,
  });
  store.addNode({
    id: "Function:src/a.ts:target#0",
    kind: "Function",
    name: "target",
    filePath: "src/a.ts",
    startLine: 1,
    endLine: 20,
  });
  store.addNode({
    id: "Community:1",
    kind: "Community",
    name: "auth",
    filePath: "<communities>",
    inferredLabel: "auth-core",
  });
  store.addEdge({
    fromId: "Function:src/a.ts:target#0",
    toId: "Community:1",
    type: "MEMBER_OF",
    confidence: 1,
  });

  const enrichment = await buildScanEnrichment(
    store,
    logWith([result("src/a.ts", "fp-x", 10)]),
    "/repo",
  );
  // busFactor (file) + community (symbol) + blastRadius 0 (symbol resolved, no
  // callers — a real "nothing depends on this" signal, not "not computed").
  assert.deepEqual(enrichment.byResultFingerprint?.get("fp-x"), {
    busFactor: 3,
    blastRadius: 0,
    community: "auth-core",
  });
});

test("buildScanEnrichment leaves a finding with no enclosing symbol at file signals only", async () => {
  const store = new FakeStore();
  store.addNode({
    id: "File:src/a.ts:src/a.ts",
    kind: "File",
    name: "a.ts",
    filePath: "src/a.ts",
    busFactor: 2,
  });
  store.addNode({
    id: "Function:src/a.ts:target#0",
    kind: "Function",
    name: "target",
    filePath: "src/a.ts",
    startLine: 1,
    endLine: 5,
  });
  // Finding on line 99 → outside the function → no symbol-level signals.
  const enrichment = await buildScanEnrichment(
    store,
    logWith([result("src/a.ts", "fp-x", 99)]),
    "/repo",
  );
  assert.deepEqual(enrichment.byResultFingerprint?.get("fp-x"), { busFactor: 2 });
});
