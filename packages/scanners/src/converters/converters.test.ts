/**
 * Converter tests — pip-audit JSON → SARIF + npm-audit JSON → SARIF.
 *
 * Every generated SARIF log is validated against `SarifLogSchema` from
 * @opencodehub/sarif so schema drift is caught at the conversion boundary.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { SarifLogSchema } from "@opencodehub/sarif";
import { npmAuditJsonToSarif } from "./npm-audit-to-sarif.js";
import { pipAuditJsonToSarif } from "./pip-audit-to-sarif.js";

function assertValidSarif(log: unknown): void {
  const result = SarifLogSchema.safeParse(log);
  assert.ok(result.success, `expected valid SARIF: ${result.success ? "" : result.error.message}`);
}

// ---------- pip-audit -----------------------------------------------------

test("pipAuditJsonToSarif emits one result per vulnerability", () => {
  const json = {
    dependencies: [
      {
        name: "flask",
        version: "1.0.0",
        vulns: [
          {
            id: "PYSEC-2020-10",
            description: "Flask is vulnerable to timing attacks.",
            aliases: ["CVE-2020-28493"],
            fix_versions: ["2.0.1"],
          },
          {
            id: "GHSA-m2qf-hxjv-5gpq",
            description: "Second vuln in flask.",
            fix_versions: [],
          },
        ],
      },
      { name: "requests", version: "2.0.0", vulns: [] },
    ],
  };
  const log = pipAuditJsonToSarif(json);
  assertValidSarif(log);
  assert.equal(log.runs.length, 1);
  const results = log.runs[0]?.results ?? [];
  assert.equal(results.length, 2);
  assert.equal(results[0]?.ruleId, "PYSEC-2020-10");
  assert.equal(results[1]?.ruleId, "GHSA-m2qf-hxjv-5gpq");
  assert.equal(results[0]?.level, "error");
  assert.equal(results[0]?.message?.text, "Flask is vulnerable to timing attacks.");
  assert.equal(
    results[0]?.locations?.[0]?.physicalLocation?.artifactLocation?.uri,
    "requirements.txt",
  );
  const props = (results[0]?.properties as { opencodehub?: Record<string, unknown> } | undefined)
    ?.opencodehub;
  assert.equal(props?.["dependency"], "flask@1.0.0");
  assert.deepEqual(props?.["aliases"], ["CVE-2020-28493"]);
  assert.deepEqual(props?.["fixVersions"], ["2.0.1"]);
});

test("pipAuditJsonToSarif honours custom requirementsPath option", () => {
  const log = pipAuditJsonToSarif(
    {
      dependencies: [
        { name: "x", version: "1.0.0", vulns: [{ id: "PYSEC-xxx", description: "desc" }] },
      ],
    },
    { requirementsPath: "pyproject.toml" },
  );
  assert.equal(
    log.runs[0]?.results?.[0]?.locations?.[0]?.physicalLocation?.artifactLocation?.uri,
    "pyproject.toml",
  );
});

test("pipAuditJsonToSarif emits empty (but valid) SARIF for garbage input", () => {
  const empty = pipAuditJsonToSarif({} as unknown);
  assertValidSarif(empty);
  assert.equal(empty.runs[0]?.results?.length, 0);

  const nullLog = pipAuditJsonToSarif(null);
  assertValidSarif(nullLog);
  assert.equal(nullLog.runs[0]?.results?.length, 0);

  const arrLog = pipAuditJsonToSarif([]);
  assertValidSarif(arrLog);
  assert.equal(arrLog.runs[0]?.results?.length, 0);
});

test("pipAuditJsonToSarif skips malformed vulnerabilities", () => {
  const log = pipAuditJsonToSarif({
    dependencies: [
      {
        name: "foo",
        version: "1.0.0",
        vulns: [
          { id: "PYSEC-good", description: "ok" },
          { description: "no id" }, // dropped
          null, // dropped
          { id: "", description: "empty id" }, // dropped
        ],
      },
      { name: "missing-version" }, // dropped (no version)
    ],
  });
  const results = log.runs[0]?.results ?? [];
  assert.equal(results.length, 1);
  assert.equal(results[0]?.ruleId, "PYSEC-good");
});

// ---------- npm audit -----------------------------------------------------

test("npmAuditJsonToSarif emits one result per advisory via entry", () => {
  const json = {
    vulnerabilities: {
      lodash: {
        name: "lodash",
        severity: "high",
        range: ">=3.0.0 <4.17.21",
        via: [
          {
            source: 1094,
            name: "lodash",
            title: "Prototype Pollution in lodash",
            url: "https://github.com/advisories/GHSA-35jh",
            severity: "high",
            range: "<4.17.21",
          },
        ],
      },
      moderate_pkg: {
        name: "moderate_pkg",
        severity: "moderate",
        range: "<1.0.0",
        via: [
          {
            source: 42,
            name: "moderate_pkg",
            title: "Low risk",
            severity: "moderate",
          },
        ],
      },
    },
  };
  const log = npmAuditJsonToSarif(json);
  assertValidSarif(log);
  const results = log.runs[0]?.results ?? [];
  assert.equal(results.length, 2);
  // Deterministic sort order — lodash comes before moderate_pkg.
  assert.equal(results[0]?.ruleId, "npm-advisory-1094");
  assert.equal(results[0]?.level, "error");
  assert.equal(results[1]?.ruleId, "npm-advisory-42");
  assert.equal(results[1]?.level, "warning");
  const props = (results[0]?.properties as { opencodehub?: Record<string, unknown> } | undefined)
    ?.opencodehub;
  assert.equal(props?.["dependency"], "lodash@>=3.0.0 <4.17.21");
  assert.equal(props?.["severity"], "high");
  assert.equal(props?.["advisoryUrl"], "https://github.com/advisories/GHSA-35jh");
});

test("npmAuditJsonToSarif skips transitive-only via entries", () => {
  const json = {
    vulnerabilities: {
      hoist: {
        name: "hoist",
        severity: "low",
        range: "*",
        via: ["parent-a", "parent-b"], // strings — transitive hops only
      },
    },
  };
  const log = npmAuditJsonToSarif(json);
  assertValidSarif(log);
  assert.equal(log.runs[0]?.results?.length, 0);
});

test("npmAuditJsonToSarif falls back to url / name when no numeric source", () => {
  const json = {
    vulnerabilities: {
      pkg: {
        name: "pkg",
        severity: "critical",
        range: "*",
        via: [
          {
            name: "pkg",
            title: "nasty",
            url: "https://example.com/advisory/xyz",
            severity: "critical",
          },
        ],
      },
    },
  };
  const log = npmAuditJsonToSarif(json);
  assertValidSarif(log);
  const r = log.runs[0]?.results?.[0];
  assert.equal(r?.ruleId, "https://example.com/advisory/xyz");
  assert.equal(r?.level, "error");
});

test("npmAuditJsonToSarif honours custom lockfilePath option", () => {
  const log = npmAuditJsonToSarif(
    {
      vulnerabilities: {
        x: {
          name: "x",
          severity: "high",
          range: "*",
          via: [{ source: 1, title: "t" }],
        },
      },
    },
    { lockfilePath: "package-lock.json" },
  );
  assert.equal(
    log.runs[0]?.results?.[0]?.locations?.[0]?.physicalLocation?.artifactLocation?.uri,
    "package-lock.json",
  );
});

test("npmAuditJsonToSarif emits empty (but valid) SARIF for garbage input", () => {
  assertValidSarif(npmAuditJsonToSarif({}));
  assertValidSarif(npmAuditJsonToSarif(null));
  assertValidSarif(npmAuditJsonToSarif({ vulnerabilities: "not an object" }));
  assert.equal(npmAuditJsonToSarif({}).runs[0]?.results?.length, 0);
});
