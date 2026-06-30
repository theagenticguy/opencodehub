import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ArmDispersion } from "./dispersion.js";
import {
  type ArmReport,
  buildHarnessReport,
  formatReport,
  serializeReport,
  TOKEN_OVERHEAD_FLAG,
  type VarianceReport,
} from "./report.js";

const assertionDispersion = (passRate: number, stddev: number): ArmDispersion => ({
  kind: "assertion",
  passRate,
  stddev,
  runs: 10,
});

const arm = (stddev: number, input: number, output: number): ArmReport => ({
  dispersion: assertionDispersion(0.5, stddev),
  tokens: { inputTokens: input, outputTokens: output, costUsd: null },
});

describe("buildHarnessReport", () => {
  it("computes the without − with dispersion delta (positive = pack helped)", () => {
    const report = buildHarnessReport({
      harness: "claude",
      runner: "cli:claude",
      runs: 10,
      without: arm(0.5, 1000, 200),
      with: arm(0.2, 1100, 220),
    });
    assert.ok(Math.abs(report.dispersionDelta - 0.3) < 1e-9, "0.5 − 0.2 = 0.3");
  });

  it("computes token overhead as with/without totals", () => {
    const report = buildHarnessReport({
      harness: "codex",
      runner: "cli:codex",
      runs: 10,
      without: arm(0.5, 1000, 0),
      with: arm(0.2, 1100, 0),
    });
    assert.ok(Math.abs(report.tokenOverhead - 1.1) < 1e-9);
    assert.equal(report.tokenOverheadFlagged, false, "1.1× is under the 1.3× flag");
  });

  it("flags when token overhead exceeds the guardrail", () => {
    const report = buildHarnessReport({
      harness: "claude",
      runner: "cli:claude",
      runs: 10,
      without: arm(0.5, 1000, 0),
      with: arm(0.2, 1400, 0),
    });
    assert.ok(report.tokenOverhead > TOKEN_OVERHEAD_FLAG);
    assert.equal(report.tokenOverheadFlagged, true);
  });

  it("reports overhead 0 (never Infinity/NaN) when the baseline arm spent no tokens", () => {
    const report = buildHarnessReport({
      harness: "claude",
      runner: "cli:claude",
      runs: 1,
      without: arm(0, 0, 0),
      with: arm(0, 500, 100),
    });
    assert.equal(report.tokenOverhead, 0);
    assert.equal(report.tokenOverheadFlagged, false);
  });
});

describe("serializeReport (determinism, R6)", () => {
  const report: VarianceReport = {
    schema: 1,
    taskId: "demo-task",
    harnesses: [
      buildHarnessReport({
        harness: "claude",
        runner: "cli:claude",
        runs: 10,
        without: arm(0.5, 1000, 200),
        with: arm(0.2, 1100, 220),
      }),
    ],
  };

  it("is a pure function of the report (byte-identical across calls)", () => {
    assert.equal(serializeReport(report), serializeReport(report));
  });

  it("sorts object keys canonically (no clock/run-id leaks in)", () => {
    const json = serializeReport(report);
    // canonicalJson sorts keys: "harnesses" before "schema" before "taskId".
    assert.ok(json.startsWith('{"harnesses":'));
    assert.ok(!json.includes("Date"));
    assert.ok(!json.includes("timestamp"));
  });
});

describe("formatReport", () => {
  it("renders the flag marker when overhead is high", () => {
    const flagged: VarianceReport = {
      schema: 1,
      taskId: "t",
      harnesses: [
        buildHarnessReport({
          harness: "claude",
          runner: "cli:claude",
          runs: 10,
          without: arm(0.5, 1000, 0),
          with: arm(0.2, 1500, 0),
        }),
      ],
    };
    const text = formatReport(flagged);
    assert.ok(text.includes("FLAG"));
    assert.ok(text.includes("token overhead"));
  });
});
