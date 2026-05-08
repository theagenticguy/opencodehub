/**
 * Pure license classification for Dependency nodes.
 *
 * Sorts each dependency into three buckets:
 *
 *   - copyleft    — names matching GPL/AGPL/SSPL/EUPL/CPAL/OSL/RPL. These
 *                   are redistribution-contagious licenses that the host
 *                   project (Apache-2.0) cannot safely link against.
 *   - proprietary — explicit "PROPRIETARY" declarations.
 *   - unknown     — missing licenses or the `"UNKNOWN"` sentinel emitted
 *                   by the dependency phase when a manifest parser could
 *                   not recover a declared license. A later release will
 *                   populate real licenses from ecosystem metadata;
 *                   until then most audits WILL return tier=WARN.
 *
 * Tier assignment:
 *   BLOCK  — any copyleft OR any proprietary dep.
 *   WARN   — no copyleft/proprietary, at least one unknown.
 *   OK     — nothing flagged.
 *
 * Lifted from `@opencodehub/mcp/src/tools/license-audit.ts` so that
 * `@opencodehub/pack` can reuse the classifier without introducing a
 * mcp → pack → mcp cycle.
 */

/**
 * Copyleft license prefix matcher. Upper-cased inputs only — callers must
 * normalise. The regex is anchored so `LGPL-3.0` does NOT match `^GPL`
 * (LGPL is weak copyleft → classified as UNKNOWN/WARN for v1.0, upgraded
 * in a follow-up task).
 */
const COPYLEFT_PATTERN = /^(GPL|AGPL|SSPL|EUPL|CPAL|OSL|RPL)/;

export interface DependencyRef {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly ecosystem: string;
  readonly license: string;
  readonly lockfileSource: string;
}

export type LicenseTier = "OK" | "WARN" | "BLOCK";

export interface LicenseAuditFlagged {
  readonly copyleft: readonly DependencyRef[];
  readonly unknown: readonly DependencyRef[];
  readonly proprietary: readonly DependencyRef[];
}

export interface LicenseAuditResult {
  readonly tier: LicenseTier;
  readonly flagged: LicenseAuditFlagged;
  readonly summary: {
    readonly total: number;
    readonly okCount: number;
    readonly flaggedCount: number;
  };
}

/**
 * Pure classification. Exposed so unit tests can assert tier logic
 * without touching the MCP server scaffolding.
 */
export function classifyDependencies(deps: readonly DependencyRef[]): LicenseAuditResult {
  const copyleft: DependencyRef[] = [];
  const unknown: DependencyRef[] = [];
  const proprietary: DependencyRef[] = [];

  for (const d of deps) {
    const normalised = d.license.trim().toUpperCase();
    if (normalised === "" || normalised === "UNKNOWN") {
      unknown.push(d);
    } else if (normalised === "PROPRIETARY") {
      proprietary.push(d);
    } else if (COPYLEFT_PATTERN.test(normalised)) {
      copyleft.push(d);
    }
  }

  const flaggedCount = copyleft.length + unknown.length + proprietary.length;
  const hasBlocking = copyleft.length > 0 || proprietary.length > 0;
  const tier: LicenseTier = hasBlocking ? "BLOCK" : unknown.length > 0 ? "WARN" : "OK";

  return {
    tier,
    flagged: { copyleft, unknown, proprietary },
    summary: {
      total: deps.length,
      okCount: deps.length - flaggedCount,
      flaggedCount,
    },
  };
}
