/**
 * Zod schemas for OpenCodeHub policy v1.
 *
 * Mirrors `opencodehub.policy.yaml` at the repo root. The starter file has
 * every rule commented out; uncommenting any rule lights up its evaluator.
 *
 * Design notes:
 * - `version` is pinned to the literal `1`. Forward-incompatible policies
 *   must bump this and ship a separate schema module.
 * - The three rule shapes are expressed as a Zod discriminated union on
 *   `type`. This gives callers precise type narrowing and surfaces the
 *   missing / wrong discriminant as a first-class validation error.
 * - `auto_approve.require` is a free-form list of requirement objects with a
 *   single declared shape each. We keep its schema intentionally loose (any
 *   known key → its coerced value) so additive tweaks in newer ADRs don't
 *   require code churn. Evaluation currently does NOT consume it — wired in
 *   by a follow-up task once spec 002 P1 lands.
 * - All output types are `readonly` / `Readonly<...>` so results can cross
 *   serialization boundaries without defensive copying.
 */

import { z } from "zod";

/**
 * A single auto-approve requirement. YAML shapes:
 *
 *   - blast_radius.tier: ">= 3"
 *   - findings.severity_error: 0
 *   - license_audit.violations: 0
 *
 * YAML maps with a single key/value each. We accept any of the three
 * declared keys; unknown keys flow through untouched so future ADR
 * additions don't force a schema bump.
 */
export const AutoApproveRequirementSchema = z
  .object({
    "blast_radius.tier": z.union([z.string(), z.number()]).optional(),
    "findings.severity_error": z.number().optional(),
    "license_audit.violations": z.number().optional(),
  })
  .passthrough();

export const LicenseAllowlistRuleSchema = z.object({
  type: z.literal("license_allowlist"),
  id: z.string().min(1),
  deny: z.array(z.string().min(1)),
});

export const BlastRadiusMaxRuleSchema = z.object({
  type: z.literal("blast_radius_max"),
  id: z.string().min(1),
  max_tier: z.number().int(),
});

export const OwnershipRequiredRuleSchema = z.object({
  type: z.literal("ownership_required"),
  id: z.string().min(1),
  paths: z.array(z.string().min(1)),
  require_approval_from: z.array(z.string().min(1)),
});

export const RuleSchema = z.discriminatedUnion("type", [
  LicenseAllowlistRuleSchema,
  BlastRadiusMaxRuleSchema,
  OwnershipRequiredRuleSchema,
]);

export const PolicySchema = z.object({
  version: z.literal(1),
  auto_approve: z
    .object({
      require: z.array(AutoApproveRequirementSchema).optional(),
    })
    .optional(),
  rules: z.array(RuleSchema).default([]),
});

export type AutoApproveRequirement = z.infer<typeof AutoApproveRequirementSchema>;
export type LicenseAllowlistRule = z.infer<typeof LicenseAllowlistRuleSchema>;
export type BlastRadiusMaxRule = z.infer<typeof BlastRadiusMaxRuleSchema>;
export type OwnershipRequiredRule = z.infer<typeof OwnershipRequiredRuleSchema>;
export type Rule = z.infer<typeof RuleSchema>;
export type Policy = z.infer<typeof PolicySchema>;
