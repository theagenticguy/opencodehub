/**
 * Tests for the findings BOM body (AC-M5-5 — item 8/9).
 *
 * Covers:
 *   - A. Determinism across two consecutive calls.
 *   - B. Suppressed rows are dropped (rehydration via isSuppressed).
 *   - C. Group ordering: severity (error > warning > note > none) then
 *        ruleId ASC.
 *   - D. NULL/unknown severity coerces to "none".
 *   - E. Examples are sorted by nodeId ASC and capped at examplesPerGroup.
 *   - F. Group count reflects post-suppression row count.
 *   - G. Empty graph returns `[]`.
 *   - H. examplesPerGroup=0 returns groups with empty examples but valid count.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { FindingNode } from "@opencodehub/core-types";
import { canonicalJson } from "@opencodehub/core-types";
import type { IGraphStore } from "@opencodehub/storage";
import { buildFindings, type FindingGroup } from "./findings.js";

interface RawFinding {
  readonly id: string;
  readonly rule_id: string;
  readonly severity: string | null;
  readonly file_path?: string;
  readonly start_line?: number;
  readonly message?: string;
  readonly suppressed_json?: string;
}

/** Convert a raw fixture row into the typed FindingNode the finder returns. */
function toFinding(row: RawFinding): FindingNode {
  const sev = row.severity;
  const severity: FindingNode["severity"] =
    sev === "error" || sev === "warning" || sev === "note" || sev === "none"
      ? sev
      : ("none" as const);
  const node: FindingNode = {
    id: row.id as FindingNode["id"],
    kind: "Finding",
    name: row.id,
    filePath: row.file_path ?? "",
    ruleId: row.rule_id,
    severity,
    scannerId: "",
    message: row.message ?? "",
    propertiesBag: {},
    ...(row.start_line !== undefined ? { startLine: row.start_line } : {}),
    ...(row.suppressed_json !== undefined ? { suppressedJson: row.suppressed_json } : {}),
  };
  // Smuggle a non-canonical severity past the typed shape so the
  // "unknown severity coerces to 'none'" test can still exercise the
  // production-side coercion guard.
  if (sev !== null && sev !== severity) {
    return { ...node, severity: sev as FindingNode["severity"] };
  }
  return node;
}

function makeStore(rows: readonly RawFinding[]): IGraphStore {
  return {
    listFindings: async () => {
      return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(toFinding);
    },
  } as unknown as IGraphStore;
}

const FIXTURES: readonly RawFinding[] = [
  // 2 errors on rule A, 1 error on rule B.
  { id: "fnd:1", rule_id: "rule-a", severity: "error", file_path: "x.ts", start_line: 1 },
  { id: "fnd:2", rule_id: "rule-a", severity: "error", file_path: "y.ts", start_line: 2 },
  { id: "fnd:3", rule_id: "rule-b", severity: "error", file_path: "z.ts", start_line: 3 },
  // 2 warnings on rule A, 1 warning on rule C.
  { id: "fnd:4", rule_id: "rule-a", severity: "warning", file_path: "x.ts", start_line: 4 },
  { id: "fnd:5", rule_id: "rule-a", severity: "warning", file_path: "x.ts", start_line: 5 },
  { id: "fnd:6", rule_id: "rule-c", severity: "warning", file_path: "x.ts", start_line: 6 },
  // 1 suppressed: must NOT contribute to any group.
  {
    id: "fnd:7",
    rule_id: "rule-a",
    severity: "error",
    file_path: "x.ts",
    start_line: 7,
    // sarif.isSuppressed expects an array of objects; one object is enough.
    suppressed_json: JSON.stringify([{ kind: "external", justification: "reviewed" }]),
  },
  // 1 finding with NULL severity → coerces to "none".
  { id: "fnd:8", rule_id: "rule-d", severity: null, file_path: "x.ts", start_line: 8 },
];

test("A. buildFindings is deterministic across two consecutive calls", async () => {
  const store = makeStore(FIXTURES);
  const first = await buildFindings({ store });
  const second = await buildFindings({ store });
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.deepEqual(first, second);
});

test("B. suppressed rows are dropped via isSuppressed rehydration", async () => {
  const store = makeStore(FIXTURES);
  const groups = await buildFindings({ store });
  // The fnd:7 row was suppressed → rule-a / error count should be 2, not 3.
  const errorRuleA = groups.find((g) => g.severity === "error" && g.ruleId === "rule-a");
  assert.equal(errorRuleA?.count, 2);
  for (const g of groups) {
    for (const ex of g.examples) {
      assert.notEqual(ex.nodeId, "fnd:7");
    }
  }
});

test("C. groups sort by severity (error > warning > note > none) then ruleId ASC", async () => {
  const store = makeStore(FIXTURES);
  const groups = await buildFindings({ store });
  // First three are errors (rule-a, rule-b), then warnings (rule-a, rule-c),
  // then none (rule-d). Within severity, ruleId ASC.
  const ranks = groups.map((g) => `${g.severity}/${g.ruleId}`);
  assert.deepEqual(ranks, [
    "error/rule-a",
    "error/rule-b",
    "warning/rule-a",
    "warning/rule-c",
    "none/rule-d",
  ]);
});

test("D. NULL severity coerces to 'none'", async () => {
  const store = makeStore(FIXTURES);
  const groups = await buildFindings({ store });
  const ruleD = groups.find((g) => g.ruleId === "rule-d");
  assert.equal(ruleD?.severity, "none");
});

test("E. examples sorted by nodeId ASC and capped at examplesPerGroup", async () => {
  const store = makeStore(FIXTURES);
  const groups = await buildFindings({ store, examplesPerGroup: 1 });
  // rule-a / error has 2 rows; cap=1 keeps the lex-min nodeId only.
  const errorRuleA = groups.find((g) => g.severity === "error" && g.ruleId === "rule-a");
  assert.equal(errorRuleA?.examples.length, 1);
  assert.equal(errorRuleA?.examples[0]?.nodeId, "fnd:1");
});

test("F. group count reflects post-suppression row count", async () => {
  const store = makeStore(FIXTURES);
  const groups = await buildFindings({ store });
  // Total count across groups = 7 (8 fixtures - 1 suppressed).
  const total = groups.reduce((sum, g) => sum + g.count, 0);
  assert.equal(total, 7);
});

test("G. empty graph returns []", async () => {
  const store = makeStore([]);
  const groups = await buildFindings({ store });
  assert.deepEqual(groups, []);
});

test("H. examplesPerGroup=0 returns groups with empty examples but valid count", async () => {
  const store = makeStore(FIXTURES);
  const groups = await buildFindings({ store, examplesPerGroup: 0 });
  for (const g of groups) {
    assert.deepEqual([...g.examples], []);
  }
  // Counts still tally pre-cap.
  const errorRuleA = groups.find((g) => g.severity === "error" && g.ruleId === "rule-a");
  assert.equal(errorRuleA?.count, 2);
});

test("I. unknown severity strings coerce to 'none'", async () => {
  const rows: readonly RawFinding[] = [
    { id: "fnd:1", rule_id: "rule-x", severity: "critical" }, // not a SARIF level
  ];
  const store = makeStore(rows);
  const groups = await buildFindings({ store });
  assert.equal(groups[0]?.severity, "none");
});

test("J. only error severity in fixture preserves error rank position", async () => {
  const errorOnly: readonly RawFinding[] = [
    { id: "fnd:1", rule_id: "rule-z", severity: "error" },
    { id: "fnd:2", rule_id: "rule-a", severity: "error" },
  ];
  const store = makeStore(errorOnly);
  const groups: readonly FindingGroup[] = await buildFindings({ store });
  // Both severity=error; ruleId ASC: rule-a then rule-z.
  assert.equal(groups[0]?.ruleId, "rule-a");
  assert.equal(groups[1]?.ruleId, "rule-z");
});

test("K. malformed suppressed_json does NOT suppress the row", async () => {
  const rows: readonly RawFinding[] = [
    {
      id: "fnd:1",
      rule_id: "rule-a",
      severity: "error",
      suppressed_json: "{not valid json",
    },
  ];
  const store = makeStore(rows);
  const groups = await buildFindings({ store });
  assert.equal(groups[0]?.count, 1);
});
