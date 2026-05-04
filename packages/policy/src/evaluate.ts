/**
 * evaluatePolicy — run each rule in `policy.rules` against a pre-computed
 * `PolicyContext` and return a deterministic `PolicyDecision`.
 *
 * Design notes:
 *
 * - Pure function: no I/O, no DuckDB, no globals. Callers (currently
 *   `codehub verdict`) pre-compute the context from their existing
 *   license audit, blast-radius tier, and ownership graph.
 *
 * - Three rule types (v1):
 *     license_allowlist   — block when any observed license is in `deny`.
 *     blast_radius_max    — block when `ctx.blastRadiusTier > max_tier`.
 *     ownership_required  — block when a touched path under one of the
 *                           rule's glob patterns lacks an approval from
 *                           any owner in `require_approval_from` (or the
 *                           real owners attached to that path via
 *                           `ctx.ownersByPath`).
 *
 * - Output determinism: violations are sorted by `ruleId` (stable) so CI
 *   diffs and fixture tests don't flake.
 *
 * - Status ladder: any violation collapses the decision to `block`. The
 *   `warn` state is reserved for non-blocking rules in a future version
 *   (ADR TBD) — v1 rules are all blocking, so the evaluator emits either
 *   `pass` or `block`. Returning a `warn` variant here keeps the type
 *   stable when warn-severity rules land.
 *
 * - Glob semantics: `ownership_required.paths` supports `*` (single-segment
 *   wildcard) and `**` (multi-segment wildcard) plus literal path
 *   segments. No character classes — the `.codehub/suppressions.yaml`
 *   glob surface is intentionally richer; policy paths stay simpler so a
 *   reviewer can read the rule at a glance.
 */

import type {
  BlastRadiusMaxRule,
  LicenseAllowlistRule,
  OwnershipRequiredRule,
  Policy,
  Rule,
} from "./schemas/policy-v1.js";

export interface LicenseViolationInput {
  readonly license: string;
  readonly package: string;
}

export interface PolicyContext {
  /** Observed license findings from the dependency audit. */
  readonly licenseViolations: readonly LicenseViolationInput[];
  /** Effective blast-radius tier for this diff (higher = more impactful). */
  readonly blastRadiusTier: number;
  /** Paths touched by the diff, relative to the repo root, using / separators. */
  readonly touchedPaths: readonly string[];
  /** Owners associated with each touched path (from OWNED_BY edges). */
  readonly ownersByPath: ReadonlyMap<string, readonly string[]>;
  /** Approvals already granted on the PR (owners / teams / users). */
  readonly approvals: readonly string[];
}

export interface PolicyViolation {
  readonly ruleId: string;
  readonly reason: string;
}

export interface PolicyDecision {
  readonly status: "pass" | "warn" | "block";
  readonly violations: readonly PolicyViolation[];
}

export function evaluatePolicy(policy: Policy, ctx: PolicyContext): PolicyDecision {
  const violations: PolicyViolation[] = [];
  for (const rule of policy.rules) {
    const ruleViolations = evaluateRule(rule, ctx);
    violations.push(...ruleViolations);
  }
  // Deterministic output: sort by ruleId, then by reason (stable within ruleId).
  violations.sort((a, b) => {
    if (a.ruleId < b.ruleId) return -1;
    if (a.ruleId > b.ruleId) return 1;
    if (a.reason < b.reason) return -1;
    if (a.reason > b.reason) return 1;
    return 0;
  });
  const status: PolicyDecision["status"] = violations.length === 0 ? "pass" : "block";
  return { status, violations };
}

function evaluateRule(rule: Rule, ctx: PolicyContext): readonly PolicyViolation[] {
  switch (rule.type) {
    case "license_allowlist":
      return evaluateLicenseAllowlist(rule, ctx);
    case "blast_radius_max":
      return evaluateBlastRadiusMax(rule, ctx);
    case "ownership_required":
      return evaluateOwnershipRequired(rule, ctx);
  }
}

function evaluateLicenseAllowlist(
  rule: LicenseAllowlistRule,
  ctx: PolicyContext,
): readonly PolicyViolation[] {
  if (rule.deny.length === 0) return [];
  const deny = new Set(rule.deny);
  const out: PolicyViolation[] = [];
  for (const violation of ctx.licenseViolations) {
    if (deny.has(violation.license)) {
      out.push({
        ruleId: rule.id,
        reason: `license "${violation.license}" from package "${violation.package}" is denied`,
      });
    }
  }
  return out;
}

function evaluateBlastRadiusMax(
  rule: BlastRadiusMaxRule,
  ctx: PolicyContext,
): readonly PolicyViolation[] {
  if (ctx.blastRadiusTier <= rule.max_tier) return [];
  return [
    {
      ruleId: rule.id,
      reason: `blast radius tier ${ctx.blastRadiusTier} exceeds max ${rule.max_tier}`,
    },
  ];
}

function evaluateOwnershipRequired(
  rule: OwnershipRequiredRule,
  ctx: PolicyContext,
): readonly PolicyViolation[] {
  const out: PolicyViolation[] = [];
  const approvals = new Set(ctx.approvals);

  // For each touched path that matches one of the rule's globs, require an
  // approval from either (a) the rule's explicit `require_approval_from`
  // list, or (b) any owner attached to that path. Emit one violation per
  // path without coverage.
  for (const path of ctx.touchedPaths) {
    if (!rule.paths.some((pattern) => matchesGlob(path, pattern))) continue;
    const pathOwners = ctx.ownersByPath.get(path) ?? [];
    const acceptable = new Set<string>([...rule.require_approval_from, ...pathOwners]);
    if (acceptable.size === 0) {
      // No explicit requirement and no owner in the graph — treat as
      // missing ownership approval rather than silently passing.
      out.push({
        ruleId: rule.id,
        reason: `path "${path}" is under an ownership-required glob but has no owners`,
      });
      continue;
    }
    const hasApproval = [...acceptable].some((who) => approvals.has(who));
    if (!hasApproval) {
      const needed = [...acceptable].sort().join(", ");
      out.push({
        ruleId: rule.id,
        reason: `path "${path}" requires approval from one of: ${needed}`,
      });
    }
  }
  return out;
}

/**
 * Minimal glob matcher supporting `*` (one segment) and `**` (any number
 * of segments). Matches on `/`-separated paths.
 */
function matchesGlob(path: string, pattern: string): boolean {
  const regex = globToRegex(pattern);
  return regex.test(path);
}

function globToRegex(pattern: string): RegExp {
  // Escape regex specials except `*` and `/` which we handle ourselves.
  let out = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**` -> match any number of characters including /.
        out += ".*";
        i += 2;
        // Skip a trailing `/` after `**` so `packages/**/file` matches
        // `packages/file` too.
        if (pattern[i] === "/") i += 1;
        continue;
      }
      // `*` -> one path segment (no `/`).
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if (ch !== undefined && /[.+^$(){}|[\]\\]/.test(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
    i += 1;
  }
  out += "$";
  return new RegExp(out);
}
