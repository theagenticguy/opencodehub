/**
 * Regression test for the incremental-analyze findings-wipe bug.
 *
 * `runAnalyze` rebuilds the graph with a replace-mode `bulkLoad` (ADR 0019),
 * which truncates EVERY node — including the `Finding` nodes and `FOUND_IN`
 * edges that a prior `codehub scan` ingested. On the scan-skip fast-path
 * (fingerprint match + `scan.sarif` present) the scanners do NOT re-run, so
 * before the fix nothing re-populated those findings and the freshly-rebuilt
 * graph reported zero findings — `list_findings`, `list_findings_delta`, and
 * `verdict` all silently saw a clean scan.
 *
 * The fix re-ingests the cached `scan.sarif` on the skip path. `runIngestSarif`
 * is idempotent (fingerprint-stable enrichment + upsert-mode bulkLoad), so it
 * restores exactly the findings the wipe removed.
 *
 * These tests exercise the store-level composition directly — seed findings,
 * simulate the replace-mode graph wipe, then run the skip-path re-ingest — so
 * the regression is caught without driving a full git+scanner analyze run
 * (which the determinism suite never exercised, which is why the bug shipped).
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeGraph } from "@opencodehub/core-types";
import type { SarifLog } from "@opencodehub/sarif";
import { openStore, resolveGraphPath, resolveRepoMetaDir } from "@opencodehub/storage";
import { runIngestSarif } from "./ingest-sarif.js";

/** A SARIF log with two findings on two files — the cached `scan.sarif`. */
function scanLog(): SarifLog {
  return {
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "semgrep", version: "1.0.0" } },
        results: [
          {
            ruleId: "r.xss",
            message: { text: "XSS risk" },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: "web/a.ts" },
                  region: { startLine: 10 },
                },
              },
            ],
            partialFingerprints: { "opencodehub/v1": "a".repeat(32) },
          },
          {
            ruleId: "r.sqli",
            message: { text: "SQLi risk" },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: "api/b.ts" },
                  region: { startLine: 20 },
                },
              },
            ],
            partialFingerprints: { "opencodehub/v1": "b".repeat(32) },
          },
        ],
      },
    ],
  };
}

async function countFindings(repoPath: string): Promise<number> {
  const store = await openStore({ path: resolveGraphPath(repoPath) });
  try {
    await store.graph.open();
    let n = 0;
    for (const node of await store.graph.listNodes()) {
      if (node.kind === "Finding") n += 1;
    }
    return n;
  } finally {
    await store.close();
  }
}

/**
 * Write the cached `scan.sarif` and seed its findings into the graph the way
 * a prior `codehub scan` would have (via the same idempotent ingest path).
 * Returns the sarif path so the test can re-ingest it on the skip branch.
 */
async function seedRepoWithFindings(repoPath: string): Promise<string> {
  await mkdir(resolveRepoMetaDir(repoPath), { recursive: true });
  const sarifPath = join(resolveRepoMetaDir(repoPath), "scan.sarif");
  await writeFile(sarifPath, `${JSON.stringify(scanLog(), null, 2)}\n`, "utf8");
  await runIngestSarif(sarifPath, { repo: repoPath });
  return sarifPath;
}

/**
 * Reproduce the replace-mode graph rebuild that `runAnalyze` performs: a
 * `bulkLoad` in the default replace mode truncates all nodes/edges. This is
 * the step that wipes the seeded Finding nodes.
 */
async function simulateGraphRebuildWipe(repoPath: string): Promise<void> {
  const store = await openStore({ path: resolveGraphPath(repoPath) });
  try {
    await store.graph.open();
    await store.temporal.open();
    await store.graph.createSchema();
    // Empty graph in replace mode == the "rebuilt from the pipeline" graph
    // that carries no Finding nodes (findings come only from the scan step).
    await store.graph.bulkLoad(new KnowledgeGraph());
  } finally {
    await store.close();
  }
}

test("scan-skip path: replace-mode graph rebuild wipes seeded Finding nodes", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "och-findings-wipe-"));
  await seedRepoWithFindings(repoPath);
  assert.equal(await countFindings(repoPath), 2, "seed should ingest two findings");

  await simulateGraphRebuildWipe(repoPath);

  // This asserts the BUG precondition: after the replace-mode rebuild the
  // findings are gone. If a future change makes the rebuild preserve findings
  // this assertion flips and the guard below becomes redundant — update both.
  assert.equal(
    await countFindings(repoPath),
    0,
    "replace-mode bulkLoad must truncate the prior Finding nodes",
  );
});

test("scan-skip path: re-ingesting the cached SARIF restores findings after the wipe", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "och-findings-restore-"));
  const sarifPath = await seedRepoWithFindings(repoPath);

  // Graph rebuild wipes the findings...
  await simulateGraphRebuildWipe(repoPath);
  assert.equal(await countFindings(repoPath), 0);

  // ...and the fix re-ingests the reused scan.sarif on the fingerprint-match
  // skip branch (exactly what analyze.ts now does instead of only logging).
  const ingested = await runIngestSarif(sarifPath, { repo: repoPath });

  assert.equal(ingested.findingsEmitted, 2, "re-ingest must emit both cached findings");
  assert.equal(
    await countFindings(repoPath),
    2,
    "findings must survive an incremental re-analyze that skips the scanners",
  );
});

test("scan-skip re-ingest is idempotent — no duplicate Finding nodes", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "och-findings-idem-"));
  const sarifPath = await seedRepoWithFindings(repoPath);
  await simulateGraphRebuildWipe(repoPath);

  // Two consecutive skip-path re-ingests (two incremental analyze runs) must
  // not double-count — the ingest bulkLoad runs in upsert mode keyed on the
  // finding fingerprint.
  await runIngestSarif(sarifPath, { repo: repoPath });
  await runIngestSarif(sarifPath, { repo: repoPath });

  assert.equal(
    await countFindings(repoPath),
    2,
    "repeated skip-path re-ingests must stay at two findings (idempotent upsert)",
  );
});
