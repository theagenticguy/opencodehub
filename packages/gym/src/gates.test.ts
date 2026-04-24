import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { evaluateGates, type GateInput, type GateThresholds, loadThresholds } from "./gates.js";
import type { CaseScore, Rollup } from "./metrics.js";

const BASELINES_PATH = new URL("../baselines/thresholds.json", import.meta.url).pathname;

function thresholds(): GateThresholds {
  return {
    schemaVersion: 1,
    languages: {
      python: { f1Floor: 0.95, f1DeltaTolerance: 0.005 },
      typescript: { f1Floor: 0.9, f1DeltaTolerance: 0.01 },
      go: { f1Floor: 0.9, f1DeltaTolerance: 0.01 },
      rust: { f1Floor: 0.85, f1DeltaTolerance: 0.015 },
    },
  };
}

interface RollupOverrides {
  language?: "python" | "typescript" | "go" | "rust";
  tool?: string;
  caseKind?: "references" | "implementations" | "callers";
  caseCount?: number;
  precision?: number;
  recall?: number;
  f1?: number;
  meanJaccard?: number;
  meanKendallTau?: number | undefined;
}

function rollup(overrides: RollupOverrides = {}): Rollup {
  const language = overrides.language ?? "python";
  const tool = overrides.tool ?? "pyright";
  const caseKind = overrides.caseKind ?? "references";
  const r: Rollup = {
    key: `${language}/${tool}/${caseKind}`,
    caseCount: overrides.caseCount ?? 1,
    precision: overrides.precision ?? 1,
    recall: overrides.recall ?? 1,
    f1: overrides.f1 ?? 1,
    meanJaccard: overrides.meanJaccard ?? 1,
  };
  if (overrides.meanKendallTau !== undefined) r.meanKendallTau = overrides.meanKendallTau;
  return r;
}

interface CaseScoreOverrides {
  caseId?: string;
  caseKind?: "references" | "implementations" | "callers";
  language?: "python" | "typescript" | "go" | "rust";
  tool?: string;
  precision?: number;
  recall?: number;
  f1?: number;
  tp?: number;
  fp?: number;
  fn?: number;
  jaccard?: number;
  kendallTau?: number | undefined;
}

function caseScore(overrides: CaseScoreOverrides = {}): CaseScore {
  const c: CaseScore = {
    caseId: overrides.caseId ?? "case-1",
    caseKind: overrides.caseKind ?? "references",
    language: overrides.language ?? "python",
    tool: overrides.tool ?? "pyright",
    scores: {
      precision: overrides.precision ?? 1,
      recall: overrides.recall ?? 1,
      f1: overrides.f1 ?? 1,
      tp: overrides.tp ?? 1,
      fp: overrides.fp ?? 0,
      fn: overrides.fn ?? 0,
    },
    jaccard: overrides.jaccard ?? 1,
  };
  if (overrides.kendallTau !== undefined) c.kendallTau = overrides.kendallTau;
  return c;
}

function emptyInput(overrides: Partial<GateInput> = {}): GateInput {
  const base: GateInput = {
    thresholds: thresholds(),
    currentRollups: [],
    baselineRollups: [],
    currentCases: [],
    baselineCases: [],
    waivedCaseIds: new Set(),
  };
  return { ...base, ...overrides };
}

test("loadThresholds: reads packages/gym/baselines/thresholds.json cleanly", async () => {
  const parsed = await loadThresholds(BASELINES_PATH);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.languages.python.f1Floor, 0.95);
  assert.equal(parsed.languages.typescript.f1DeltaTolerance, 0.01);
});

test("loadThresholds: throws with clear message on malformed JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gym-thresholds-"));
  try {
    const path = join(dir, "bad.json");
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        languages: { python: { f1DeltaTolerance: 0.005 } },
      }),
      "utf-8",
    );
    await assert.rejects(
      () => loadThresholds(path),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /loadThresholds:/);
        assert.match(err.message, /schema validation failed/);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Gate 1: all rollups above floor -> passes with no findings", () => {
  const report = evaluateGates(
    emptyInput({
      currentRollups: [
        rollup({ language: "python", f1: 0.97 }),
        rollup({ language: "typescript", tool: "tsserver", f1: 0.93 }),
      ],
    }),
  );
  assert.equal(report.passed, true);
  assert.deepEqual(report.findings, []);
  assert.equal(report.summary.f1FloorChecked, 2);
});

test("Gate 1: rollup below floor -> fails with correct delta", () => {
  const report = evaluateGates(
    emptyInput({
      currentRollups: [rollup({ language: "python", f1: 0.94 })],
    }),
  );
  assert.equal(report.passed, false);
  assert.equal(report.findings.length, 1);
  const [finding] = report.findings;
  assert.ok(finding !== undefined);
  assert.equal(finding.gate, "f1-floor");
  if (finding.gate !== "f1-floor") throw new Error("unreachable");
  assert.equal(finding.language, "python");
  assert.equal(finding.observed, 0.94);
  assert.equal(finding.floor, 0.95);
  assert.ok(Math.abs(finding.delta - -0.01) < 1e-9);
});

test("Gate 2: new coverage (key in current, absent in baseline) -> no finding", () => {
  const report = evaluateGates(
    emptyInput({
      currentRollups: [
        rollup({ language: "python", f1: 0.97 }),
        rollup({ language: "python", caseKind: "implementations", f1: 0.97 }),
      ],
      baselineRollups: [rollup({ language: "python", f1: 0.97 })],
    }),
  );
  assert.equal(report.passed, true);
  assert.deepEqual(report.findings, []);
  assert.equal(report.summary.f1DeltaChecked, 1);
});

test("Gate 2: coverage dropped (key in baseline, absent in current) -> finding", () => {
  const report = evaluateGates(
    emptyInput({
      currentRollups: [rollup({ language: "python", f1: 0.97 })],
      baselineRollups: [
        rollup({ language: "python", f1: 0.97 }),
        rollup({ language: "python", caseKind: "implementations", f1: 0.97 }),
      ],
    }),
  );
  assert.equal(report.passed, false);
  assert.equal(report.findings.length, 1);
  const [finding] = report.findings;
  assert.ok(finding !== undefined);
  assert.equal(finding.gate, "f1-delta");
  if (finding.gate !== "f1-delta") throw new Error("unreachable");
  assert.equal(finding.key, "python/pyright/implementations");
  assert.equal(finding.observed, 0);
  assert.equal(finding.baseline, 0.97);
});

test("Gate 2: within tolerance (delta == -tolerance) -> no finding", () => {
  const report = evaluateGates(
    emptyInput({
      currentRollups: [rollup({ language: "python", f1: 0.97 })],
      baselineRollups: [rollup({ language: "python", f1: 0.975 })],
    }),
  );
  assert.equal(report.passed, true);
  assert.deepEqual(report.findings, []);
});

test("Gate 2: outside tolerance -> finding", () => {
  const report = evaluateGates(
    emptyInput({
      currentRollups: [rollup({ language: "python", f1: 0.96 })],
      baselineRollups: [rollup({ language: "python", f1: 0.98 })],
    }),
  );
  assert.equal(report.passed, false);
  assert.equal(report.findings.length, 1);
  const [finding] = report.findings;
  assert.ok(finding !== undefined);
  assert.equal(finding.gate, "f1-delta");
  if (finding.gate !== "f1-delta") throw new Error("unreachable");
  assert.equal(finding.key, "python/pyright/references");
  assert.equal(finding.tolerance, 0.005);
});

test("Gate 3: previously perfect, now broken -> finding", () => {
  const report = evaluateGates(
    emptyInput({
      currentCases: [caseScore({ caseId: "c1", f1: 0.5 })],
      baselineCases: [caseScore({ caseId: "c1", f1: 1 })],
    }),
  );
  assert.equal(report.passed, false);
  assert.equal(report.findings.length, 1);
  const [finding] = report.findings;
  assert.ok(finding !== undefined);
  assert.equal(finding.gate, "per-case");
  if (finding.gate !== "per-case") throw new Error("unreachable");
  assert.equal(finding.caseId, "c1");
  assert.equal(finding.baseline, 1);
  assert.equal(finding.current, 0.5);
  assert.equal(report.summary.perCaseChecked, 1);
  assert.equal(report.summary.waivedCount, 0);
});

test("Gate 3: waived case -> no finding, waivedCount=1", () => {
  const report = evaluateGates(
    emptyInput({
      currentCases: [caseScore({ caseId: "c1", f1: 0.5 })],
      baselineCases: [caseScore({ caseId: "c1", f1: 1 })],
      waivedCaseIds: new Set(["c1"]),
    }),
  );
  assert.equal(report.passed, true);
  assert.deepEqual(report.findings, []);
  assert.equal(report.summary.perCaseChecked, 1);
  assert.equal(report.summary.waivedCount, 1);
});

test("Gate 3: previously imperfect stays imperfect -> no finding", () => {
  const report = evaluateGates(
    emptyInput({
      currentCases: [caseScore({ caseId: "c1", f1: 0.7 })],
      baselineCases: [caseScore({ caseId: "c1", f1: 0.8 })],
    }),
  );
  assert.equal(report.passed, true);
  assert.deepEqual(report.findings, []);
  assert.equal(report.summary.perCaseChecked, 0);
});

test("Zero baseline: Gate 1 runs, Gates 2+3 skip silently", () => {
  const report = evaluateGates(
    emptyInput({
      currentRollups: [rollup({ language: "python", f1: 0.97 })],
      currentCases: [caseScore({ caseId: "c1", f1: 0.7 })],
    }),
  );
  assert.equal(report.passed, true);
  assert.deepEqual(report.findings, []);
  assert.equal(report.summary.f1FloorChecked, 1);
  assert.equal(report.summary.f1DeltaChecked, 0);
  assert.equal(report.summary.perCaseChecked, 0);
  assert.equal(report.summary.waivedCount, 0);
});

test("Finding ordering: multi-gate findings sorted deterministically", () => {
  const report = evaluateGates(
    emptyInput({
      currentRollups: [
        rollup({ language: "python", f1: 0.8 }),
        rollup({ language: "typescript", tool: "tsserver", f1: 0.5 }),
        rollup({ language: "go", tool: "gopls", f1: 0.5 }),
      ],
      baselineRollups: [
        rollup({ language: "python", f1: 0.97 }),
        rollup({ language: "typescript", tool: "tsserver", f1: 0.95 }),
      ],
      currentCases: [
        caseScore({ caseId: "zeta", f1: 0.5 }),
        caseScore({ caseId: "alpha", f1: 0.5 }),
      ],
      baselineCases: [caseScore({ caseId: "zeta", f1: 1 }), caseScore({ caseId: "alpha", f1: 1 })],
    }),
  );
  assert.equal(report.passed, false);
  const gates = report.findings.map((f) => f.gate);
  assert.deepEqual(
    gates,
    gates.slice().sort((a, b) => {
      const order: Record<string, number> = { "f1-delta": 0, "f1-floor": 1, "per-case": 2 };
      const aOrder = order[a];
      const bOrder = order[b];
      assert.ok(aOrder !== undefined);
      assert.ok(bOrder !== undefined);
      return aOrder - bOrder;
    }),
  );
  // f1-delta findings ordered by key ascending
  const deltaKeys = report.findings
    .filter((f): f is Extract<typeof f, { gate: "f1-delta" }> => f.gate === "f1-delta")
    .map((f) => f.key);
  assert.deepEqual(deltaKeys, deltaKeys.slice().sort());
  // f1-floor findings ordered by language ascending
  const floorLangs = report.findings
    .filter((f): f is Extract<typeof f, { gate: "f1-floor" }> => f.gate === "f1-floor")
    .map((f) => f.language);
  assert.deepEqual(floorLangs, floorLangs.slice().sort());
  // per-case findings ordered by caseId ascending
  const perCaseIds = report.findings
    .filter((f): f is Extract<typeof f, { gate: "per-case" }> => f.gate === "per-case")
    .map((f) => f.caseId);
  assert.deepEqual(perCaseIds, ["alpha", "zeta"]);
});
