/**
 * Unit tests for the `codehub scan` CLI command's scanner selection.
 *
 * We test the pure `selectScanners(profile, opts)` function — no disk,
 * no binary spawn, no graph store. Integration tests live elsewhere.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { selectScanners } from "./scan.js";

test("selectScanners: empty profile yields only polyglot P1 scanners", () => {
  const ids = selectScanners({}, {})
    .map((s) => s.id)
    .sort();
  assert.deepEqual(ids, ["betterleaks", "grype", "osv-scanner", "semgrep"]);
});

test("selectScanners: iacTypes=['terraform'] enables tflint + trivy + checkov", () => {
  const ids = selectScanners({ iacTypes: ["terraform"] }, {})
    .map((s) => s.id)
    .sort();
  // P1 polyglot + grype + trivy (terraform) + checkov (terraform) + tflint (terraform).
  assert.deepEqual(ids, [
    "betterleaks",
    "checkov",
    "grype",
    "osv-scanner",
    "semgrep",
    "tflint",
    "trivy",
  ]);
});

test("selectScanners: iacTypes=[] skips every P2 scanner", () => {
  const ids = selectScanners({ languages: ["typescript"], iacTypes: [], apiContracts: [] }, {}).map(
    (s) => s.id,
  );
  for (const p2 of ["trivy", "checkov", "hadolint", "tflint", "spectral"]) {
    assert.ok(!ids.includes(p2), `${p2} should NOT run on a profile with empty iacTypes`);
  }
});

test("selectScanners: iacTypes=['docker'] enables hadolint", () => {
  const ids = selectScanners({ iacTypes: ["docker"] }, {}).map((s) => s.id);
  assert.ok(ids.includes("hadolint"));
  assert.ok(ids.includes("trivy"));
  assert.ok(ids.includes("checkov"));
  // tflint stays off (no terraform).
  assert.ok(!ids.includes("tflint"));
});

test("selectScanners: apiContracts=['openapi'] enables spectral", () => {
  const ids = selectScanners({ apiContracts: ["openapi"] }, {}).map((s) => s.id);
  assert.ok(ids.includes("spectral"));
  assert.ok(!ids.includes("tflint"));
});

test("selectScanners: --with trivy force-adds trivy even without IaC in profile", () => {
  const ids = selectScanners(
    { languages: ["python"], iacTypes: [], apiContracts: [] },
    { withScanners: ["trivy"] },
  ).map((s) => s.id);
  assert.ok(ids.includes("trivy"), "trivy should be force-added via --with");
  assert.ok(ids.includes("bandit"), "bandit still gated normally by language");
});

test("selectScanners: --scanners overrides profile gating entirely", () => {
  const ids = selectScanners(
    { languages: ["python"], iacTypes: ["docker"], apiContracts: ["openapi"] },
    { scanners: ["semgrep", "bandit"] },
  )
    .map((s) => s.id)
    .sort();
  assert.deepEqual(ids, ["bandit", "semgrep"]);
});

test("selectScanners: --scanners + --with merges the two lists", () => {
  const ids = selectScanners(
    { languages: ["python"] },
    { scanners: ["semgrep"], withScanners: ["trivy"] },
  )
    .map((s) => s.id)
    .sort();
  assert.deepEqual(ids, ["semgrep", "trivy"]);
});

test("selectScanners: Python project enables pip-audit alongside bandit", () => {
  const ids = selectScanners({ languages: ["python"] }, {}).map((s) => s.id);
  assert.ok(ids.includes("pip-audit"));
  assert.ok(ids.includes("bandit"));
});

test("selectScanners: TypeScript project enables npm-audit alongside biome", () => {
  const ids = selectScanners({ languages: ["typescript"] }, {}).map((s) => s.id);
  assert.ok(ids.includes("biome"));
  assert.ok(ids.includes("npm-audit"));
});
