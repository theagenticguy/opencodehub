/**
 * evaluatePolicy — run each rule in `policy.rules` against a small pre-computed
 * `PolicyContext` and return a deterministic `PolicyDecision`.
 *
 * Implemented in commit 3 of T-M2-4.
 */

import type { Policy } from "./schemas/policy-v1.js";

export interface PolicyContext {
  readonly licenseViolations: readonly { license: string; package: string }[];
  readonly blastRadiusTier: number;
  readonly touchedPaths: readonly string[];
  readonly ownersByPath: ReadonlyMap<string, readonly string[]>;
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
  void policy;
  void ctx;
  throw new Error("evaluatePolicy: not yet implemented");
}
