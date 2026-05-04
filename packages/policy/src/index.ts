/**
 * @opencodehub/policy — policy loader + evaluator for `opencodehub.policy.yaml`.
 *
 * Public surface:
 *   - loadPolicy(path): read + validate the YAML, return Policy | undefined.
 *   - evaluatePolicy(policy, ctx): pure evaluator returning a deterministic
 *     PolicyDecision with violations sorted by ruleId.
 *   - Schemas + types for the 3 v1 rule shapes.
 */

export type { PolicyContext, PolicyDecision, PolicyViolation } from "./evaluate.js";
export { evaluatePolicy } from "./evaluate.js";
export { loadPolicy, PolicyValidationError } from "./load.js";
export type {
  AutoApproveRequirement,
  BlastRadiusMaxRule,
  LicenseAllowlistRule,
  OwnershipRequiredRule,
  Policy,
  Rule,
} from "./schemas/policy-v1.js";
export {
  AutoApproveRequirementSchema,
  BlastRadiusMaxRuleSchema,
  LicenseAllowlistRuleSchema,
  OwnershipRequiredRuleSchema,
  PolicySchema,
  RuleSchema,
} from "./schemas/policy-v1.js";
