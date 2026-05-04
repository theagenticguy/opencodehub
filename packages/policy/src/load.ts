/**
 * loadPolicy — read opencodehub.policy.yaml, parse, Zod-validate.
 *
 * Implemented in commit 2 of T-M2-4.
 */

import type { Policy } from "./schemas/policy-v1.js";

export class PolicyValidationError extends Error {
  override readonly name = "PolicyValidationError";
}

export async function loadPolicy(filePath: string): Promise<Policy | undefined> {
  void filePath;
  throw new Error("loadPolicy: not yet implemented");
}
