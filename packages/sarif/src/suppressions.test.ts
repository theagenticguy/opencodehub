/**
 * suppressions tests
 *
 * Covers: YAML loading, glob matching, expiry, inline markers (// # and
 * C-family block style), preservation of pre-existing suppressions[], and
 * the `isSuppressed` predicate used by verdict.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { SarifLog } from "./schemas.js";
import {
  applySuppressions,
  isSuppressed,
  loadSuppressions,
  type SuppressionRule,
} from "./suppressions.js";

function makeLog(overrides?: {
  ruleId?: string;
  uri?: string;
  startLine?: number;
  suppressions?: readonly { kind: "external" | "inSource"; justification: string }[];
}): SarifLog {
  const ruleId = overrides?.ruleId ?? "B101";
  const uri = overrides?.uri ?? "tests/test_auth.py";
  const startLine = overrides?.startLine ?? 12;
  const result: Record<string, unknown> = {
    ruleId,
    level: "warning",
    message: { text: "assert used" },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri },
          region: { startLine },
        },
      },
    ],
  };
  if (overrides?.suppressions !== undefined) {
    result["suppressions"] = [...overrides.suppressions];
  }
  return {
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "bandit", version: "1.0.0" } },
        results: [result],
      },
    ],
  };
}

function writeYaml(contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "codehub-suppress-"));
  const file = path.join(dir, "suppressions.yaml");
  writeFileSync(file, contents, "utf8");
  return file;
}

function firstResult(log: SarifLog): Record<string, unknown> {
  const result = log.runs[0]?.results?.[0];
  assert.ok(result !== undefined, "expected at least one result in run[0]");
  return result as Record<string, unknown>;
}

test("loadSuppressions: rule from YAML fixture matches finding by ruleId + filePath", () => {
  const file = writeYaml(
    [
      "rules:",
      "  - ruleId: B101",
      "    filePathPattern: tests/test_auth.py",
      "    reason: asserts ok in tests",
    ].join("\n"),
  );
  const loaded = loadSuppressions(file);
  assert.equal(loaded.warnings.length, 0);
  assert.equal(loaded.rules.length, 1);
  assert.equal(loaded.rules[0]?.reason, "asserts ok in tests");

  const log = makeLog();
  const applied = applySuppressions(log, loaded.rules);
  const result = firstResult(applied);
  const suppressions = result["suppressions"] as { kind: string; justification: string }[];
  assert.ok(Array.isArray(suppressions));
  assert.equal(suppressions.length, 1);
  assert.equal(suppressions[0]?.kind, "external");
  assert.equal(suppressions[0]?.justification, "asserts ok in tests");
});

test("loadSuppressions: expired rule is excluded and emits a warning", () => {
  const file = writeYaml(
    [
      "rules:",
      "  - ruleId: B101",
      "    filePathPattern: tests/**",
      "    reason: temporary waiver",
      "    expiresAt: '2024-01-01T00:00:00Z'",
    ].join("\n"),
  );
  const now = new Date("2026-04-20T00:00:00Z");
  const loaded = loadSuppressions(file, now);
  assert.equal(loaded.rules.length, 0);
  assert.equal(loaded.warnings.length, 1);
  assert.match(loaded.warnings[0] ?? "", /expired/i);
});

test("applySuppressions: glob `tests/**` matches nested paths", () => {
  const rules: SuppressionRule[] = [
    { ruleId: "B101", filePathPattern: "tests/**", reason: "asserts ok in tests" },
  ];
  const log = makeLog({ uri: "tests/integration/nested/test_x.py" });
  const applied = applySuppressions(log, rules);
  const result = firstResult(applied);
  const suppressions = result["suppressions"] as unknown[];
  assert.ok(Array.isArray(suppressions));
  assert.equal(suppressions.length, 1);

  // Non-matching path stays un-suppressed.
  const log2 = makeLog({ uri: "src/prod/auth.py" });
  const applied2 = applySuppressions(log2, rules);
  assert.equal(firstResult(applied2)["suppressions"], undefined);
});

test("applySuppressions: inline `// codehub-suppress` marks result as inSource", () => {
  const source = [
    "def test_auth():",
    "    assert verify_token('x')  // codehub-suppress: B101 asserts ok in tests",
    "    return True",
  ].join("\n");
  const log = makeLog({ startLine: 2 });
  const applied = applySuppressions(log, [], () => source);
  const result = firstResult(applied);
  const suppressions = result["suppressions"] as { kind: string; justification: string }[];
  assert.ok(Array.isArray(suppressions));
  assert.equal(suppressions.length, 1);
  assert.equal(suppressions[0]?.kind, "inSource");
  assert.equal(suppressions[0]?.justification, "asserts ok in tests");
});

test("applySuppressions: inline `# codehub-suppress` (Python) and block comment both match", () => {
  const pythonSource = ["def f():", "    x = 1  # codehub-suppress: B101 python-style marker"].join(
    "\n",
  );
  const pyApplied = applySuppressions(makeLog({ startLine: 2 }), [], () => pythonSource);
  const pySupp = (firstResult(pyApplied)["suppressions"] as { kind: string }[])[0];
  assert.equal(pySupp?.kind, "inSource");

  const blockSource = [
    "int main() {",
    "  assert(ok); /* codehub-suppress: B101 c-family block style */",
    "}",
  ].join("\n");
  const cApplied = applySuppressions(makeLog({ startLine: 2 }), [], () => blockSource);
  const cSuppArr = firstResult(cApplied)["suppressions"] as {
    kind: string;
    justification: string;
  }[];
  assert.equal(cSuppArr[0]?.kind, "inSource");
  assert.equal(cSuppArr[0]?.justification, "c-family block style");
});

test("applySuppressions: a marker inside a string literal does NOT suppress", () => {
  // The marker text rides inside a quoted string, NOT a comment. Treating
  // it as a suppression would let a finding hide behind its own source
  // text — a security gate defeat. It must stay un-suppressed.
  const source = [
    "def f():",
    '    example = "codehub-suppress: B101 do not actually suppress"',
    "    return example",
  ].join("\n");
  const applied = applySuppressions(makeLog({ startLine: 2 }), [], () => source);
  assert.equal(firstResult(applied)["suppressions"], undefined);
});

test("applySuppressions: a marker in a comment on the line above DOES suppress", () => {
  // Same marker text, this time inside a real `#` comment above the
  // finding. This is the supported usage and must suppress.
  const source = ["def f():", "    # codehub-suppress: B101 asserts ok here", "    assert ok"].join(
    "\n",
  );
  const applied = applySuppressions(makeLog({ startLine: 3 }), [], () => source);
  const supp = firstResult(applied)["suppressions"] as { kind: string; justification: string }[];
  assert.ok(Array.isArray(supp));
  assert.equal(supp[0]?.kind, "inSource");
  assert.equal(supp[0]?.justification, "asserts ok here");
});

test("applySuppressions: SQL `--` and HTML `<!--` comment markers suppress", () => {
  const sqlSource = ["SELECT *", "FROM t -- codehub-suppress: B101 sql comment marker"].join("\n");
  const sqlApplied = applySuppressions(makeLog({ startLine: 2 }), [], () => sqlSource);
  const sqlSupp = firstResult(sqlApplied)["suppressions"] as {
    kind: string;
    justification: string;
  }[];
  assert.equal(sqlSupp[0]?.kind, "inSource");
  assert.equal(sqlSupp[0]?.justification, "sql comment marker");

  const htmlSource = ["<div>", "  <!-- codehub-suppress: B101 html comment marker -->"].join("\n");
  const htmlApplied = applySuppressions(makeLog({ startLine: 2 }), [], () => htmlSource);
  const htmlSupp = firstResult(htmlApplied)["suppressions"] as {
    kind: string;
    justification: string;
  }[];
  assert.equal(htmlSupp[0]?.kind, "inSource");
  assert.equal(htmlSupp[0]?.justification, "html comment marker");
});

test("applySuppressions: location-less result is suppressed by a catch-all `**` rule", () => {
  // SARIF 2.1.0 allows a Result with a ruleId but no locations[] (file-less
  // secret/dependency findings). A catch-all rule must still be able to
  // suppress it by ruleId; a path-scoped rule must not.
  const log: SarifLog = {
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "betterleaks", version: "1.0.0" } },
        results: [{ ruleId: "B101", level: "error", message: { text: "file-less finding" } }],
      },
    ],
  };

  const catchAll: SuppressionRule[] = [
    { ruleId: "B101", filePathPattern: "**", reason: "accepted risk" },
  ];
  const applied = applySuppressions(log, catchAll);
  const supp = firstResult(applied)["suppressions"] as { kind: string; justification: string }[];
  assert.ok(Array.isArray(supp));
  assert.equal(supp.length, 1);
  assert.equal(supp[0]?.kind, "external");
  assert.equal(supp[0]?.justification, "accepted risk");

  // A path-scoped rule must NOT leak onto the location-less finding.
  const scoped: SuppressionRule[] = [
    { ruleId: "B101", filePathPattern: "tests/**", reason: "scoped" },
  ];
  const scopedApplied = applySuppressions(log, scoped);
  assert.equal(firstResult(scopedApplied)["suppressions"], undefined);
});

test("applySuppressions: preserves pre-existing suppressions[]", () => {
  const preExisting = [{ kind: "external" as const, justification: "vendor rule" }];
  const log = makeLog({ suppressions: preExisting });
  const rules: SuppressionRule[] = [
    { ruleId: "B101", filePathPattern: "tests/**", reason: "also ok" },
  ];
  const applied = applySuppressions(log, rules);
  const result = firstResult(applied);
  const suppressions = result["suppressions"] as { kind: string; justification: string }[];
  assert.equal(suppressions.length, 2);
  assert.equal(suppressions[0]?.justification, "vendor rule");
  assert.equal(suppressions[1]?.justification, "also ok");
});

test("isSuppressed: true for suppressed, false for unsuppressed", () => {
  const bare = makeLog();
  assert.equal(
    isSuppressed(firstResult(bare) as unknown as Parameters<typeof isSuppressed>[0]),
    false,
  );

  const withSupp = makeLog({
    suppressions: [{ kind: "external", justification: "ok" }],
  });
  assert.equal(
    isSuppressed(firstResult(withSupp) as unknown as Parameters<typeof isSuppressed>[0]),
    true,
  );
});

test("applySuppressions: does not mutate the input log", () => {
  const log = makeLog();
  const snapshot = JSON.stringify(log);
  const rules: SuppressionRule[] = [{ ruleId: "B101", filePathPattern: "tests/**", reason: "ok" }];
  applySuppressions(log, rules);
  assert.equal(JSON.stringify(log), snapshot);
});

test("loadSuppressions: missing file resolves to empty rules, no warnings", () => {
  const loaded = loadSuppressions("/tmp/codehub-does-not-exist-xyz.yaml");
  assert.equal(loaded.rules.length, 0);
  assert.equal(loaded.warnings.length, 0);
});

test("applySuppressions: deduplicates repeated external and inSource entries", () => {
  const rules: SuppressionRule[] = [{ ruleId: "B101", filePathPattern: "tests/**", reason: "ok" }];
  const pre = [{ kind: "external" as const, justification: "ok" }];
  const log = makeLog({ suppressions: pre });
  const applied = applySuppressions(log, rules);
  const arr = firstResult(applied)["suppressions"] as unknown[];
  assert.equal(arr.length, 1);
});
