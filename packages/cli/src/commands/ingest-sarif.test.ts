import assert from "node:assert/strict";
import { test } from "node:test";
import type { SarifRun } from "@opencodehub/sarif";
import { buildFindingsGraph } from "./ingest-sarif.js";

function run(scanner: string, results: unknown): SarifRun {
  return {
    tool: { driver: { name: scanner, version: "1.0.0" } },
    results: results as SarifRun["results"],
  };
}

test("buildFindingsGraph emits one Finding + one FOUND_IN per result", () => {
  const runs: SarifRun[] = [
    run("semgrep", [
      {
        ruleId: "semgrep.xss",
        level: "error",
        message: { text: "Potential XSS" },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: "src/api.ts" },
              region: { startLine: 10, endLine: 12 },
            },
          },
        ],
      },
      {
        ruleId: "semgrep.sqli",
        level: "warning",
        message: { text: "SQLi" },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: "src/db.ts" },
              region: { startLine: 50 },
            },
          },
        ],
      },
    ]),
  ];
  const { graph, summary } = buildFindingsGraph(runs);
  assert.equal(summary.findingsEmitted, 2);
  assert.equal(summary.edgesEmitted, 2);
  const nodes = [...graph.nodes()];
  const findings = nodes.filter((n) => n.kind === "Finding");
  assert.equal(findings.length, 2);
  const names = findings.map((n) => n.name).sort();
  assert.deepEqual(names, ["semgrep:semgrep.sqli", "semgrep:semgrep.xss"]);

  const edges = [...graph.edges()];
  assert.equal(edges.length, 2);
  for (const e of edges) {
    assert.equal(e.type, "FOUND_IN");
    assert.ok(e.reason?.startsWith("startLine="));
  }
});

test("buildFindingsGraph skips results missing a usable location", () => {
  const runs: SarifRun[] = [
    run("semgrep", [
      { ruleId: "rule-without-location", message: { text: "no loc" } },
      {
        ruleId: "rule-with-location",
        message: { text: "ok" },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: "foo.ts" },
              region: { startLine: 1 },
            },
          },
        ],
      },
    ]),
  ];
  const { summary } = buildFindingsGraph(runs);
  assert.equal(summary.findingsEmitted, 1);
  assert.equal(summary.resultsSkipped, 1);
});

test("buildFindingsGraph adds a second FOUND_IN edge when opencodehub.symbolId is present", () => {
  const runs: SarifRun[] = [
    run("bandit", [
      {
        ruleId: "B101",
        level: "warning",
        message: { text: "assert" },
        properties: { "opencodehub.symbolId": "Function:foo.py:authenticate" },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: "foo.py" },
              region: { startLine: 7 },
            },
          },
        ],
      },
    ]),
  ];
  const { summary, graph } = buildFindingsGraph(runs);
  assert.equal(summary.findingsEmitted, 1);
  assert.equal(summary.edgesEmitted, 2);
  const edges = [...graph.edges()];
  const targets = edges.map((e) => e.to).sort();
  assert.ok(targets.some((t) => t.startsWith("File:")));
  assert.ok(targets.some((t) => t === "Function:foo.py:authenticate"));
});

test("buildFindingsGraph maps severity correctly", () => {
  const runs: SarifRun[] = [
    run("tool", [
      {
        ruleId: "r1",
        level: "error",
        message: { text: "m" },
        locations: [
          { physicalLocation: { artifactLocation: { uri: "a.ts" }, region: { startLine: 1 } } },
        ],
      },
      {
        ruleId: "r2",
        // no level — should default to "note"
        message: { text: "m" },
        locations: [
          { physicalLocation: { artifactLocation: { uri: "a.ts" }, region: { startLine: 2 } } },
        ],
      },
    ]),
  ];
  const { graph } = buildFindingsGraph(runs);
  const findings = [...graph.nodes()].filter((n) => n.kind === "Finding");
  const r1 = findings.find((f) => f.name === "tool:r1");
  const r2 = findings.find((f) => f.name === "tool:r2");
  assert.ok(r1 && r1.kind === "Finding");
  assert.equal(r1.severity, "error");
  assert.ok(r2 && r2.kind === "Finding");
  assert.equal(r2.severity, "note");
});
