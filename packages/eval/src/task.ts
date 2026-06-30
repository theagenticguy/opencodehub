/**
 * Task definition + loader for the variance probe.
 *
 * A **task** is the fixed unit the probe runs repeatedly (spec 010 §2):
 *
 *   > a triple `(repo @ commit, instruction, success_oracle)` run by a coding
 *   > agent, where the agent's only variable input across the experiment is
 *   > whether the OCH pack is in its context.
 *
 * The task file is a small YAML or JSON document. We validate it with Zod so a
 * malformed task surfaces a precise error rather than a cryptic runtime failure
 * mid-experiment (the experiment costs real agent minutes — fail fast at load).
 *
 * Three oracle shapes, in increasing cost (§2):
 *   - `output_hash` — no scoring agent; dispersion = distinct-output ratio.
 *   - `assertion`   — a deterministic shell check; dispersion = pass-rate stddev.
 *   - `judge`       — an LLM-panel rubric; dispersion = stddev of scores.
 */

import { readFile } from "node:fs/promises";
import { parse as parseYaml, YAMLParseError } from "yaml";
import { z } from "zod";

/** Oracle that scores each run by whether its output text differs across N. */
export const OutputHashOracleSchema = z
  .object({
    type: z.literal("output_hash"),
    /**
     * Which captured field to hash for the distinct-output ratio. `final_text`
     * (the agent's answer) is the default; `diff` hashes the produced patch.
     */
    field: z.enum(["final_text", "diff"]).default("final_text"),
  })
  .strict();

/** Oracle that scores each run pass/fail via a deterministic shell command. */
export const AssertionOracleSchema = z
  .object({
    type: z.literal("assertion"),
    /**
     * Shell command run in the (post-run) repo checkout. Exit code 0 = pass,
     * non-zero = fail. This is the most defensible "variance" — it's objective.
     */
    command: z.string().min(1),
    /**
     * Optional working directory for the command, relative to the run's repo
     * checkout. Defaults to the checkout root.
     */
    cwd: z.string().optional(),
    /** Per-command timeout in milliseconds. Defaults to 120_000. */
    timeoutMs: z.number().int().positive().default(120_000),
  })
  .strict();

/** Oracle that scores each run 0..1 via an LLM-judge panel rubric. */
export const JudgeOracleSchema = z
  .object({
    type: z.literal("judge"),
    /** The rubric handed to the judge panel, verbatim. */
    rubric: z.string().min(1),
    /** Panel size — how many independent judge runs to average per outcome. */
    panel: z.number().int().positive().default(3),
  })
  .strict();

export const OracleSchema = z.discriminatedUnion("type", [
  OutputHashOracleSchema,
  AssertionOracleSchema,
  JudgeOracleSchema,
]);

export const TaskSchema = z
  .object({
    /** Human-facing task id (used to label the report). */
    id: z.string().min(1),
    /** Repo location — a local path or a clonable git URL. */
    repo: z.string().min(1),
    /** Pinned commit SHA. Frozen so the pack is the only variable. */
    commit: z.string().min(1),
    /** The natural-language ask, given verbatim to the agent every run. */
    instruction: z.string().min(1),
    /** How a run is scored. */
    oracle: OracleSchema,
    /**
     * Optional harness selector. Omitted → the probe runs the configured
     * default set (Claude Code + Codex). A value pins one agent.
     */
    harness: z.enum(["claude", "codex"]).optional(),
  })
  .strict();

export type OutputHashOracle = z.infer<typeof OutputHashOracleSchema>;
export type AssertionOracle = z.infer<typeof AssertionOracleSchema>;
export type JudgeOracle = z.infer<typeof JudgeOracleSchema>;
export type Oracle = z.infer<typeof OracleSchema>;
export type Task = z.infer<typeof TaskSchema>;

export class TaskValidationError extends Error {
  override readonly name = "TaskValidationError";
}

interface NodeFsError {
  readonly code?: string;
}

function isEnoent(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  return (err as NodeFsError).code === "ENOENT";
}

/**
 * Read + parse + validate a task file. YAML and JSON are both accepted — the
 * `yaml` parser is a JSON superset, so one code path handles both. A missing
 * file, malformed document, or schema violation throws {@link TaskValidationError}
 * with a precise message, so the probe never starts an expensive experiment on
 * a bad task.
 */
export async function loadTask(filePath: string): Promise<Task> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if (isEnoent(err)) {
      throw new TaskValidationError(`task file not found: ${filePath}`);
    }
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
    throw new TaskValidationError(`failed to parse ${filePath}: ${message}`);
  }

  if (parsed === null || parsed === undefined) {
    throw new TaskValidationError(`task file is empty: ${filePath}`);
  }

  const result = TaskSchema.safeParse(parsed);
  if (!result.success) {
    throw new TaskValidationError(`invalid task in ${filePath}: ${formatZodError(result.error)}`);
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
