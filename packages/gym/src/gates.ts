import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { CaseScore, Rollup } from "./metrics.js";

const languageKeySchema = z.enum(["python", "typescript", "go", "rust"]);

const languageThresholdSchema = z.object({
  f1Floor: z.number().min(0).max(1),
  f1DeltaTolerance: z.number().min(0).max(1),
});

const gateThresholdsSchema = z.object({
  schemaVersion: z.literal(1),
  languages: z.record(languageKeySchema, languageThresholdSchema),
});

export type GateLanguage = z.infer<typeof languageKeySchema>;

export interface GateThresholds {
  schemaVersion: 1;
  languages: Record<
    GateLanguage,
    {
      f1Floor: number;
      f1DeltaTolerance: number;
    }
  >;
}

export type GateFinding =
  | { gate: "f1-floor"; language: string; observed: number; floor: number; delta: number }
  | {
      gate: "f1-delta";
      key: string;
      observed: number;
      baseline: number;
      delta: number;
      tolerance: number;
    }
  | { gate: "per-case"; caseId: string; caseKind: string; baseline: number; current: number };

export interface GateReport {
  passed: boolean;
  findings: readonly GateFinding[];
  summary: {
    f1FloorChecked: number;
    f1DeltaChecked: number;
    perCaseChecked: number;
    waivedCount: number;
  };
}

export interface GateInput {
  thresholds: GateThresholds;
  currentRollups: readonly Rollup[];
  baselineRollups: readonly Rollup[];
  currentCases: readonly CaseScore[];
  baselineCases: readonly CaseScore[];
  waivedCaseIds: ReadonlySet<string>;
}

const PERFECT_F1 = 0.999;

const GATE_ORDER: Record<GateFinding["gate"], number> = {
  "f1-delta": 0,
  "f1-floor": 1,
  "per-case": 2,
};

function rollupKey(r: Rollup): string {
  return r.key;
}

function languageFromKey(key: string): string {
  const slash = key.indexOf("/");
  return slash === -1 ? key : key.slice(0, slash);
}

function caseIdentity(c: Pick<CaseScore, "caseId" | "caseKind">): string {
  return `${c.caseId}/${c.caseKind}`;
}

function compareFindings(a: GateFinding, b: GateFinding): number {
  const byGate = GATE_ORDER[a.gate] - GATE_ORDER[b.gate];
  if (byGate !== 0) return byGate;
  if (a.gate === "f1-floor" && b.gate === "f1-floor") {
    return a.language < b.language ? -1 : a.language > b.language ? 1 : 0;
  }
  if (a.gate === "f1-delta" && b.gate === "f1-delta") {
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  }
  if (a.gate === "per-case" && b.gate === "per-case") {
    const byCase = a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0;
    if (byCase !== 0) return byCase;
    return a.caseKind < b.caseKind ? -1 : a.caseKind > b.caseKind ? 1 : 0;
  }
  return 0;
}

function evaluateF1Floor(
  rollups: readonly Rollup[],
  thresholds: GateThresholds,
): { findings: GateFinding[]; checked: number } {
  const findings: GateFinding[] = [];
  const languages = new Map<string, number>();
  for (const r of rollups) {
    const language = languageFromKey(r.key);
    const prev = languages.get(language);
    if (prev === undefined || r.f1 < prev) {
      languages.set(language, r.f1);
    }
  }
  let checked = 0;
  for (const [language, observed] of languages) {
    const spec = (thresholds.languages as Record<string, { f1Floor: number } | undefined>)[
      language
    ];
    if (spec === undefined) continue;
    checked += 1;
    const floor = spec.f1Floor;
    if (observed < floor) {
      findings.push({
        gate: "f1-floor",
        language,
        observed,
        floor,
        delta: observed - floor,
      });
    }
  }
  return { findings, checked };
}

function evaluateF1Delta(
  currentRollups: readonly Rollup[],
  baselineRollups: readonly Rollup[],
  thresholds: GateThresholds,
): { findings: GateFinding[]; checked: number } {
  const findings: GateFinding[] = [];
  if (baselineRollups.length === 0) {
    return { findings, checked: 0 };
  }
  const current = new Map<string, Rollup>();
  for (const r of currentRollups) current.set(rollupKey(r), r);
  const baseline = new Map<string, Rollup>();
  for (const r of baselineRollups) baseline.set(rollupKey(r), r);

  let checked = 0;
  for (const [key, baseRollup] of baseline) {
    const language = languageFromKey(key);
    const spec = (thresholds.languages as Record<string, { f1DeltaTolerance: number } | undefined>)[
      language
    ];
    if (spec === undefined) continue;
    const tolerance = spec.f1DeltaTolerance;
    const cur = current.get(key);
    if (cur === undefined) {
      checked += 1;
      findings.push({
        gate: "f1-delta",
        key,
        observed: 0,
        baseline: baseRollup.f1,
        delta: -baseRollup.f1,
        tolerance,
      });
      continue;
    }
    checked += 1;
    const delta = cur.f1 - baseRollup.f1;
    // Small epsilon guards against IEEE-754 drift when delta is numerically
    // equal to -tolerance (e.g. 0.92 - 0.925 = -0.0050000000000000044).
    if (delta < -tolerance - 1e-9) {
      findings.push({
        gate: "f1-delta",
        key,
        observed: cur.f1,
        baseline: baseRollup.f1,
        delta,
        tolerance,
      });
    }
  }
  return { findings, checked };
}

function evaluatePerCase(
  currentCases: readonly CaseScore[],
  baselineCases: readonly CaseScore[],
  waivedCaseIds: ReadonlySet<string>,
): { findings: GateFinding[]; checked: number; waivedCount: number } {
  const findings: GateFinding[] = [];
  if (baselineCases.length === 0) {
    return { findings, checked: 0, waivedCount: 0 };
  }
  const baseline = new Map<string, CaseScore>();
  for (const c of baselineCases) baseline.set(caseIdentity(c), c);

  let checked = 0;
  let waivedCount = 0;
  for (const cur of currentCases) {
    const key = caseIdentity(cur);
    const base = baseline.get(key);
    if (base === undefined) continue;
    if (base.scores.f1 < PERFECT_F1) continue;
    checked += 1;
    if (cur.scores.f1 >= PERFECT_F1) continue;
    if (waivedCaseIds.has(cur.caseId)) {
      waivedCount += 1;
      continue;
    }
    findings.push({
      gate: "per-case",
      caseId: cur.caseId,
      caseKind: cur.caseKind,
      baseline: base.scores.f1,
      current: cur.scores.f1,
    });
  }
  return { findings, checked, waivedCount };
}

export function evaluateGates(input: GateInput): GateReport {
  const floor = evaluateF1Floor(input.currentRollups, input.thresholds);
  const delta = evaluateF1Delta(input.currentRollups, input.baselineRollups, input.thresholds);
  const perCase = evaluatePerCase(input.currentCases, input.baselineCases, input.waivedCaseIds);

  const findings = [...floor.findings, ...delta.findings, ...perCase.findings].sort(
    compareFindings,
  );

  return {
    passed: findings.length === 0,
    findings,
    summary: {
      f1FloorChecked: floor.checked,
      f1DeltaChecked: delta.checked,
      perCaseChecked: perCase.checked,
      waivedCount: perCase.waivedCount,
    },
  };
}

export async function loadThresholds(path: string): Promise<GateThresholds> {
  const raw = await readFile(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`loadThresholds: ${path}: invalid JSON: ${message}`);
  }
  const result = gateThresholdsSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`loadThresholds: ${path}: schema validation failed: ${result.error.message}`);
  }
  return result.data as GateThresholds;
}
