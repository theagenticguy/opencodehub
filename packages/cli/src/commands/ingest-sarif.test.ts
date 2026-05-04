import assert from "node:assert/strict";
import { test } from "node:test";
import type { NodeId } from "@opencodehub/core-types";
import type { SarifRun } from "@opencodehub/sarif";
import { indexNodesByFile, type NodeRow } from "./find-enclosing-symbol.js";
import { buildFindingsGraph } from "./ingest-sarif.js";

function run(scanner: string, results: unknown): SarifRun {
  return {
    tool: { driver: { name: scanner, version: "1.0.0" } },
    results: results as SarifRun["results"],
  };
}

function nodeRow(
  id: string,
  filePath: string,
  startLine: number,
  endLine: number,
  kind: NodeRow["kind"],
): NodeRow {
  return { id: id as NodeId, filePath, startLine, endLine, kind };
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

test("buildFindingsGraph persists partialFingerprint + baselineState + suppressedJson", () => {
  const runs: SarifRun[] = [
    run("semgrep", [
      {
        ruleId: "semgrep.sqli",
        level: "warning",
        message: { text: "SQLi" },
        partialFingerprints: { "opencodehub/v1": "f".repeat(32) },
        baselineState: "unchanged",
        suppressions: [
          {
            kind: "external",
            justification: "accepted risk",
          },
        ],
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: "src/db.ts" },
              region: { startLine: 50 },
            },
          },
        ],
      } as SarifRun["results"] extends readonly (infer R)[] | undefined ? R : never,
    ]),
  ];
  const { graph, summary } = buildFindingsGraph(runs);
  assert.equal(summary.findingsEmitted, 1);
  const finding = [...graph.nodes()].find((n) => n.kind === "Finding");
  assert.ok(finding && finding.kind === "Finding");
  assert.equal(finding.partialFingerprint, "f".repeat(32));
  assert.equal(finding.baselineState, "unchanged");
  assert.ok(finding.suppressedJson);
  const parsed = JSON.parse(finding.suppressedJson as string);
  assert.equal(parsed[0]?.kind, "external");
  assert.equal(parsed[0]?.justification, "accepted risk");
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

test("buildFindingsGraph emits Finding → Symbol via enclosing lookup when line data present", () => {
  // Graph contains a Class(1-100) wrapping a Method(15-25). A finding
  // at line 20 should attach to the Method (tightest span).
  const nodesByFile = indexNodesByFile([
    nodeRow("Class:foo.py:Foo", "foo.py", 1, 100, "Class"),
    nodeRow("Method:foo.py:Foo.bar", "foo.py", 15, 25, "Method"),
  ]);
  const runs: SarifRun[] = [
    run("bandit", [
      {
        ruleId: "B301",
        level: "warning",
        message: { text: "pickle" },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: "foo.py" },
              region: { startLine: 20 },
            },
          },
        ],
      },
    ]),
  ];
  const { graph, summary } = buildFindingsGraph(runs, nodesByFile);
  assert.equal(summary.findingsEmitted, 1);
  assert.equal(summary.edgesEmitted, 2);
  const edges = [...graph.edges()];
  const targets = edges.map((e) => e.to).sort();
  assert.ok(targets.some((t) => t.startsWith("File:")));
  assert.ok(
    targets.some((t) => t === "Method:foo.py:Foo.bar"),
    `expected Method target, got ${targets.join(",")}`,
  );
});

test("buildFindingsGraph falls back to outer symbol when the tight one does not enclose the line", () => {
  // Class(1-100) wraps Method(15-25). A finding at line 10 is outside
  // the Method but inside the Class — the Class should win.
  const nodesByFile = indexNodesByFile([
    nodeRow("Class:foo.py:Foo", "foo.py", 1, 100, "Class"),
    nodeRow("Method:foo.py:Foo.bar", "foo.py", 15, 25, "Method"),
  ]);
  const runs: SarifRun[] = [
    run("bandit", [
      {
        ruleId: "B101",
        level: "note",
        message: { text: "assert" },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: "foo.py" },
              region: { startLine: 10 },
            },
          },
        ],
      },
    ]),
  ];
  const { graph } = buildFindingsGraph(runs, nodesByFile);
  const edges = [...graph.edges()];
  const symbolEdge = edges.find((e) => e.to === "Class:foo.py:Foo");
  assert.ok(symbolEdge, "expected FOUND_IN to the enclosing Class");
});

test("buildFindingsGraph honors opencodehub.symbolId over the enclosing lookup", () => {
  // Even with a valid nodesByFile, the scanner-provided id must win.
  const nodesByFile = indexNodesByFile([
    nodeRow("Function:foo.py:enclosing", "foo.py", 1, 50, "Function"),
  ]);
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
  const { graph, summary } = buildFindingsGraph(runs, nodesByFile);
  assert.equal(summary.edgesEmitted, 2);
  const edges = [...graph.edges()];
  const symbolTargets = edges.filter((e) => !e.to.startsWith("File:")).map((e) => e.to);
  assert.deepEqual(symbolTargets, ["Function:foo.py:authenticate"]);
  // And the enclosing-lookup target must NOT appear.
  assert.ok(
    !symbolTargets.includes("Function:foo.py:enclosing" as NodeId),
    "enclosing-lookup must lose to scanner-provided hint",
  );
});

test("buildFindingsGraph emits only the File edge when no symbol encloses the line", () => {
  // Single Function(50-70) on the file; finding at line 5 has no
  // enclosing symbol candidate.
  const nodesByFile = indexNodesByFile([
    nodeRow("Function:foo.py:late", "foo.py", 50, 70, "Function"),
  ]);
  const runs: SarifRun[] = [
    run("bandit", [
      {
        ruleId: "B101",
        level: "note",
        message: { text: "top-level" },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: "foo.py" },
              region: { startLine: 5 },
            },
          },
        ],
      },
    ]),
  ];
  const { graph, summary } = buildFindingsGraph(runs, nodesByFile);
  assert.equal(summary.findingsEmitted, 1);
  assert.equal(summary.edgesEmitted, 1);
  const edges = [...graph.edges()];
  assert.equal(edges.length, 1);
  assert.ok(edges[0]?.to.startsWith("File:"));
});

test("buildFindingsGraph defaults to File-only edges when nodesByFile is omitted", () => {
  // Backward-compat: the existing callers that don't pass nodesByFile
  // must still produce exactly one edge per result (to File).
  const runs: SarifRun[] = [
    run("trivy", [
      {
        ruleId: "CVE-2024-1",
        level: "error",
        message: { text: "vuln" },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: "pkg.lock" },
              region: { startLine: 3 },
            },
          },
        ],
      },
    ]),
  ];
  const { summary } = buildFindingsGraph(runs);
  assert.equal(summary.findingsEmitted, 1);
  assert.equal(summary.edgesEmitted, 1);
});
