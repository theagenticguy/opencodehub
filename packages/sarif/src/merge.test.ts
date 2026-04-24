import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeSarif } from "./merge.js";
import type { SarifLog } from "./schemas.js";

function semgrepLog(): SarifLog {
  return {
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "semgrep", version: "1.50.0" } },
        results: [
          {
            ruleId: "semgrep.xss",
            message: { text: "XSS risk" },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: "web/page.tsx" },
                  region: { startLine: 10 },
                },
              },
            ],
            partialFingerprints: { primaryLocationLineHash: "fp-xss-1" },
          },
        ],
      },
    ],
  };
}

function gitleaksLog(): SarifLog {
  return {
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "gitleaks", semanticVersion: "8.18.0" } },
        results: [
          {
            ruleId: "aws-access-token",
            message: { text: "leaked token" },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: "infra/deploy.sh" },
                  region: { startLine: 3 },
                },
              },
            ],
            partialFingerprints: { primaryLocationLineHash: "fp-aws-1" },
          },
        ],
      },
    ],
  };
}

test("mergeSarif: preserves run count + order + tool.driver.name identity", () => {
  const merged = mergeSarif([semgrepLog(), gitleaksLog()]);
  assert.equal(merged.version, "2.1.0");
  assert.equal(merged.runs.length, 2);
  assert.equal(merged.runs[0]?.tool.driver.name, "semgrep");
  assert.equal(merged.runs[1]?.tool.driver.name, "gitleaks");
});

test("mergeSarif: deep-clones — mutating output does not touch input", () => {
  const a = semgrepLog();
  const b = gitleaksLog();
  const merged = mergeSarif([a, b]);

  const firstRun = merged.runs[0];
  assert.ok(firstRun !== undefined);
  const firstResult = firstRun.results?.[0];
  assert.ok(firstResult !== undefined);
  (firstResult as { message?: { text?: string } }).message = { text: "tampered" };

  assert.deepEqual(a.runs[0]?.results?.[0]?.message, { text: "XSS risk" });
});

test("mergeSarif: empty input returns empty runs", () => {
  const merged = mergeSarif([]);
  assert.equal(merged.version, "2.1.0");
  assert.equal(merged.runs.length, 0);
});

test("mergeSarif: rejects an input whose version != '2.1.0'", () => {
  const bad = { version: "2.2.0", runs: [] } as unknown as SarifLog;
  assert.throws(() => mergeSarif([bad]), /schema validation/);
});

test("mergeSarif: propagates first log's $schema when present", () => {
  const a: SarifLog = {
    $schema: "https://example.com/sarif.json",
    version: "2.1.0",
    runs: [{ tool: { driver: { name: "a" } } }],
  };
  const b: SarifLog = {
    version: "2.1.0",
    runs: [{ tool: { driver: { name: "b" } } }],
  };
  const merged = mergeSarif([a, b]);
  assert.equal(merged.$schema, "https://example.com/sarif.json");
});
