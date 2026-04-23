import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALL_SPECS,
  filterSpecsByLanguages,
  filterSpecsByProfile,
  findSpec,
  P1_SPECS,
  P2_SPECS,
} from "./catalog.js";

test("P1_SPECS contains the Priority-1 scanners in stable order", () => {
  const ids = P1_SPECS.map((s) => s.id);
  assert.deepEqual(ids, [
    "semgrep",
    "betterleaks",
    "osv-scanner",
    "bandit",
    "biome",
    "pip-audit",
    "npm-audit",
    "ruff",
    "grype",
    "checkov-docker-compose",
    "vulture",
  ]);
});

test("P2_SPECS contains the Priority-2 scanners in stable order", () => {
  const ids = P2_SPECS.map((s) => s.id);
  assert.deepEqual(ids, [
    "trivy",
    "checkov",
    "hadolint",
    "tflint",
    "spectral",
    "radon",
    "ty",
    "clamav",
  ]);
});

test("ALL_SPECS has 19 entries ( expansion)", () => {
  assert.equal(ALL_SPECS.length, 19);
});

test("ty is flagged beta and clamav is optIn", () => {
  const ty = findSpec("ty");
  const clamav = findSpec("clamav");
  assert.ok(ty?.beta, "ty must be flagged beta");
  assert.ok(clamav?.optIn, "clamav must be flagged optIn");
});

test("ALL_SPECS equals P1_SPECS followed by P2_SPECS", () => {
  assert.deepEqual(
    ALL_SPECS.map((s) => s.id),
    [...P1_SPECS.map((s) => s.id), ...P2_SPECS.map((s) => s.id)],
  );
});

test("P2_SPECS marks hadolint + tflint as external-binary-only in license", () => {
  const hadolint = findSpec("hadolint");
  const tflint = findSpec("tflint");
  assert.ok(hadolint);
  assert.ok(tflint);
  assert.match(hadolint.license, /GPL-3\.0/);
  assert.match(hadolint.license, /external binary only/);
  assert.match(tflint.license, /MPL-2\.0/);
  assert.match(tflint.license, /BUSL-1\.1/);
  assert.match(tflint.license, /external binary only/);
});

test("findSpec returns the matching spec", () => {
  const semgrep = findSpec("semgrep");
  assert.ok(semgrep);
  assert.equal(semgrep.version, "1.160.0");
  assert.equal(findSpec("nope"), undefined);
});

test("every P1 spec is marked priority 1", () => {
  for (const spec of P1_SPECS) {
    assert.equal(spec.priority, 1, `${spec.id} should be priority 1`);
  }
});

test("every P2 spec is marked priority 2", () => {
  for (const spec of P2_SPECS) {
    assert.equal(spec.priority, 2, `${spec.id} should be priority 2`);
  }
});

test("filterSpecsByLanguages keeps polyglot scanners and language-matching ones", () => {
  const pythonOnly = filterSpecsByLanguages(P1_SPECS, ["python"]);
  const ids = pythonOnly.map((s) => s.id).sort();
  // semgrep/betterleaks/osv-scanner/grype polyglot; bandit/pip-audit/ruff/vulture match python.
  assert.deepEqual(ids, [
    "bandit",
    "betterleaks",
    "grype",
    "osv-scanner",
    "pip-audit",
    "ruff",
    "semgrep",
    "vulture",
  ]);
});

test("filterSpecsByLanguages returns only polyglot scanners for empty input", () => {
  const empty = filterSpecsByLanguages(P1_SPECS, []);
  const ids = empty.map((s) => s.id).sort();
  assert.deepEqual(ids, ["betterleaks", "grype", "osv-scanner", "semgrep"]);
});

test("filterSpecsByLanguages includes biome + npm-audit for TypeScript projects", () => {
  const ts = filterSpecsByLanguages(P1_SPECS, ["typescript"]);
  const ids = ts.map((s) => s.id).sort();
  assert.deepEqual(ids, ["betterleaks", "biome", "grype", "npm-audit", "osv-scanner", "semgrep"]);
});

test("filterSpecsByProfile: empty profile yields polyglot P1 scanners", () => {
  const ids = filterSpecsByProfile(ALL_SPECS, {})
    .map((s) => s.id)
    .sort();
  assert.deepEqual(ids, ["betterleaks", "grype", "osv-scanner", "semgrep"]);
});

test("filterSpecsByProfile: Python + Terraform project enables python + IaC scanners", () => {
  const ids = filterSpecsByProfile(ALL_SPECS, {
    languages: ["python"],
    iacTypes: ["terraform"],
    apiContracts: [],
  })
    .map((s) => s.id)
    .sort();
  assert.deepEqual(ids, [
    "bandit",
    "betterleaks",
    "checkov",
    "grype",
    "osv-scanner",
    "pip-audit",
    "radon",
    "ruff",
    "semgrep",
    "tflint",
    "trivy",
    "ty",
    "vulture",
  ]);
});

test("filterSpecsByProfile: Docker-only project enables hadolint + trivy + checkov", () => {
  const ids = filterSpecsByProfile(ALL_SPECS, {
    languages: [],
    iacTypes: ["docker"],
    apiContracts: [],
  })
    .map((s) => s.id)
    .sort();
  assert.deepEqual(ids, [
    "betterleaks",
    "checkov",
    "grype",
    "hadolint",
    "osv-scanner",
    "semgrep",
    "trivy",
  ]);
});

test("filterSpecsByProfile: docker-compose iac type enables checkov-docker-compose", () => {
  const ids = filterSpecsByProfile(ALL_SPECS, {
    languages: [],
    iacTypes: ["docker-compose"],
    apiContracts: [],
  }).map((s) => s.id);
  assert.ok(ids.includes("checkov-docker-compose"), "checkov-docker-compose should run");
});

test("filterSpecsByProfile: clamav (optIn) NEVER auto-runs via profile", () => {
  const ids = filterSpecsByProfile(ALL_SPECS, {
    languages: ["python", "typescript"],
    iacTypes: ["terraform", "docker"],
    apiContracts: ["openapi"],
  }).map((s) => s.id);
  assert.ok(!ids.includes("clamav"), "clamav must never auto-run");
});

test("filterSpecsByProfile: OpenAPI project enables spectral", () => {
  const ids = filterSpecsByProfile(ALL_SPECS, {
    languages: [],
    iacTypes: [],
    apiContracts: ["openapi"],
  })
    .map((s) => s.id)
    .sort();
  assert.ok(ids.includes("spectral"), "spectral should be enabled for openapi");
  assert.ok(!ids.includes("trivy"));
  assert.ok(!ids.includes("hadolint"));
  assert.ok(!ids.includes("tflint"));
  assert.ok(!ids.includes("checkov"));
});

test("filterSpecsByProfile: iacTypes=[] skips all P2 IaC scanners", () => {
  const result = filterSpecsByProfile(ALL_SPECS, {
    languages: ["typescript"],
    iacTypes: [],
    apiContracts: [],
  });
  const ids = result.map((s) => s.id);
  for (const id of ["trivy", "checkov", "hadolint", "tflint"]) {
    assert.ok(!ids.includes(id), `${id} should NOT be enabled when iacTypes is empty`);
  }
});
