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

/** Minimal SARIF result with a primary-location uri + fingerprint. */
function result(uri: string, fingerprint: string) {
  return {
    ruleId: "demo-rule",
    level: "warning",
    message: { text: "x" },
    locations: [{ physicalLocation: { artifactLocation: { uri } } }],
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
  assert.deepEqual(enrichment.run, { enrichmentVersion: "1", sources: ["graph"] });
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
  assert.deepEqual(enrichment.run, { enrichmentVersion: "1", sources: ["graph"] });
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
  assert.deepEqual(enrichment.run, { enrichmentVersion: "1", sources: ["graph"] });
});
