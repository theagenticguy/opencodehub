/**
 * BOM body item: salient SARIF findings (AC-M5-5 — item 8/9).
 *
 * Groups `Finding` nodes by `(severity, ruleId)`. Severity is the SARIF
 * 2.1.0 `level` enum ONLY: `error | warning | note | none`. The typed
 * `FindingNode` already narrows `severity` to that enum, but
 * `listFindings()` reports any unrecognised value as `"none"` here for
 * defence in depth. Suppressed rows are skipped via the same rehydration
 * pattern used in `packages/analysis/src/verdict.ts:614-626` — we parse
 * `suppressedJson` into a minimal `{suppressions: [...]}` shape and
 * delegate to `sarif.isSuppressed()` so the "non-empty suppressions[]"
 * definition stays single-sourced in `@opencodehub/sarif`.
 *
 * Determinism contract:
 *   - Groups sort by `severity` (error > warning > note > none) then
 *     `ruleId ASC`. Severity is mapped to an explicit SEVERITY_RANK to
 *     avoid relying on string comparison of the enum.
 *   - Within each group, examples sort by `nodeId ASC` and are capped at
 *     `examplesPerGroup` (default 3).
 *
 * `listFindings()` returns every Finding node in one round-trip — pack
 * output sizes are bounded by `examplesPerGroup * groupCount` so we
 * never push a LIMIT into the database.
 */

import type { FindingNode } from "@opencodehub/core-types";
import type { SarifResult } from "@opencodehub/sarif";
import { isSuppressed } from "@opencodehub/sarif";
import type { IGraphStore } from "@opencodehub/storage";

/** SARIF `level` enum — the only severity vocabulary the BOM exposes. */
export type FindingSeverity = "error" | "warning" | "note" | "none";

/** Explicit ranking — error first, none last. */
const SEVERITY_RANK: Readonly<Record<FindingSeverity, number>> = {
  error: 0,
  warning: 1,
  note: 2,
  none: 3,
};

/** A single example row exposed under each finding group. */
export interface FindingExample {
  readonly nodeId: string;
  readonly message?: string;
  readonly filePath?: string;
  /** 1-based start line, when the underlying Finding is a `LocatedNode`. */
  readonly startLine?: number;
}

/** A group of Findings sharing the same severity + ruleId. */
export interface FindingGroup {
  readonly severity: FindingSeverity;
  readonly ruleId: string;
  readonly count: number;
  readonly examples: readonly FindingExample[];
}

export interface FindingsOpts {
  readonly store: IGraphStore;
  /** Cap on how many example rows each group exposes. Default 3. */
  readonly examplesPerGroup?: number;
}

/**
 * Build the salient-findings BOM slice.
 *
 * Empty graphs / no-finding repos return `[]`. Suppressed rows are
 * dropped before grouping so the `count` field never includes them.
 */
export async function buildFindings(opts: FindingsOpts): Promise<readonly FindingGroup[]> {
  const { store } = opts;
  const examplesCap = clampExamples(opts.examplesPerGroup);

  const rows = await store.listFindings();

  const groups = new Map<
    string,
    { severity: FindingSeverity; ruleId: string; rows: FindingExample[] }
  >();
  for (const row of rows) {
    if (isFindingSuppressed(row)) continue;
    const id = row.id;
    if (id.length === 0) continue;
    const ruleId = row.ruleId;
    const severity = coerceSeverity(row.severity);
    const key = `${severity}\0${ruleId}`;
    const example: FindingExample = {
      nodeId: id,
      ...(row.message.length > 0 ? { message: row.message } : {}),
      ...(row.filePath.length > 0 ? { filePath: row.filePath } : {}),
      ...(typeof row.startLine === "number" && Number.isFinite(row.startLine)
        ? { startLine: Math.trunc(row.startLine) }
        : {}),
    };
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { severity, ruleId, rows: [example] });
    } else {
      existing.rows.push(example);
    }
  }

  const out: FindingGroup[] = [];
  for (const g of groups.values()) {
    g.rows.sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
    out.push({
      severity: g.severity,
      ruleId: g.ruleId,
      count: g.rows.length,
      examples: g.rows.slice(0, examplesCap),
    });
  }
  out.sort(compareGroups);
  return out;
}

/** Cap default = 3; clamp negatives to 0 so callers can suppress examples entirely. */
function clampExamples(n: number | undefined): number {
  if (n === undefined) return 3;
  if (!Number.isFinite(n)) return 3;
  return n < 0 ? 0 : Math.floor(n);
}

/**
 * Mirror the `isRowSuppressed` helper from `packages/analysis/src/verdict.ts`.
 * Re-implemented here (rather than imported) because verdict.ts does not
 * export it. Operates on the typed FindingNode's `suppressedJson`.
 */
function isFindingSuppressed(row: FindingNode): boolean {
  const raw = row.suppressedJson;
  if (typeof raw !== "string" || raw.length === 0) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  const result = { suppressions: parsed } as unknown as SarifResult;
  return isSuppressed(result);
}

/** Coerce a raw severity value to the SARIF level enum. */
function coerceSeverity(raw: unknown): FindingSeverity {
  if (typeof raw !== "string") return "none";
  if (raw === "error" || raw === "warning" || raw === "note" || raw === "none") {
    return raw;
  }
  return "none";
}

function compareGroups(a: FindingGroup, b: FindingGroup): number {
  const rankDelta = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (rankDelta !== 0) return rankDelta;
  return a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0;
}
