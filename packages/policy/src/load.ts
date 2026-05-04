/**
 * loadPolicy — read opencodehub.policy.yaml, parse, Zod-validate.
 *
 * Behavior (hard-pinned by T-M2-4's EARS requirements):
 *
 * - File missing on disk → resolve to `undefined`. `codehub verdict` must
 *   skip the policy step entirely in this state.
 * - File exists but the YAML body is empty or all comments (the default
 *   starter at repo root) → resolve to `undefined`. The rule-less starter
 *   is treated as "no policy configured".
 * - File exists and parses to a non-empty document that fails the Zod
 *   schema → throw `PolicyValidationError` with the precise Zod message so
 *   `codehub verdict` exits non-zero rather than silently passing.
 * - File exists and the YAML itself is malformed → throw
 *   `PolicyValidationError` wrapping the YAML parser error.
 *
 * The file is read with Node's fs/promises. Errors with code ENOENT resolve
 * to `undefined`; every other filesystem error propagates unchanged — we
 * don't want to mask an unreadable or permission-denied policy file.
 */

import { readFile } from "node:fs/promises";
import { parse as parseYaml, YAMLParseError } from "yaml";
import type { z } from "zod";
import type { Policy } from "./schemas/policy-v1.js";
import { PolicySchema } from "./schemas/policy-v1.js";

export class PolicyValidationError extends Error {
  override readonly name = "PolicyValidationError";
}

interface NodeFsError {
  readonly code?: string;
}

function isEnoent(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  return (err as NodeFsError).code === "ENOENT";
}

export async function loadPolicy(filePath: string): Promise<Policy | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const message =
      err instanceof YAMLParseError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    throw new PolicyValidationError(`failed to parse ${filePath}: ${message}`);
  }

  // An all-comments or empty YAML file parses to `null` (or `undefined`).
  // The starter opencodehub.policy.yaml ships in this state, and the EARS
  // contract says: behave as if no policy were configured.
  if (parsed === null || parsed === undefined) {
    return undefined;
  }

  const result = PolicySchema.safeParse(parsed);
  if (!result.success) {
    throw new PolicyValidationError(
      `invalid policy in ${filePath}: ${formatZodError(result.error)}`,
    );
  }
  return result.data;
}

function formatZodError(error: z.ZodError): string {
  const parts: string[] = [];
  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.map((seg) => String(seg)).join(".") : "<root>";
    parts.push(`${path}: ${issue.message}`);
  }
  return parts.join("; ");
}
