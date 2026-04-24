/**
 * Zod 4 contract for structured code-symbol summaries.
 *
 * Each callable symbol (function / method / class) is summarized at index
 * time into a strict, citation-grounded shape. Fields are embedded separately
 * and weighted per-question at retrieval time (see SACL / Anthropic
 * Contextual Retrieval evidence). Citations let a staleness detector drop
 * summaries whose source has drifted.
 *
 * The schema is exported to JSON Schema via `z.toJSONSchema` and handed to
 * Bedrock's `toolConfig.tools[].toolSpec.inputSchema.json`. Claude can only
 * respond by filling this schema — any field-level violation is caught by
 * `SymbolSummary.safeParse` and fed back through the ReAct retry loop.
 *
 * Two shape choices worth calling out:
 *   - `returns` is split into `type` + `type_summary` (10-80) + `details`
 *     (20-400) so constructor-style symbols don't trip tight length caps.
 *   - `side_effects` items MUST contain one of reads/writes/emits/raises/mutates.
 *     This disambiguates "manages state" noise from actionable contracts.
 */

import { z } from "zod";

const SIDE_EFFECT_VERB_RE = /(reads|writes|emits|raises|mutates)/i;
const BANNED_PURPOSE_PREFIX_RE = /^this (function|method|class)/i;

export const InputSpec = z
  .object({
    name: z.string().min(1).max(128),
    type: z.string().min(1).max(256),
    description: z.string().min(20).max(200),
  })
  .strict();

export const ReturnSpec = z
  .object({
    type: z.string().min(1).max(256),
    type_summary: z.string().min(10).max(80),
    details: z.string().min(20).max(400),
  })
  .strict();

export const Citation = z
  .object({
    field_name: z.enum(["purpose", "inputs", "returns", "side_effects", "invariants"]),
    line_start: z.number().int().min(1),
    line_end: z.number().int().min(1),
  })
  .strict()
  .refine((c) => c.line_end >= c.line_start, {
    message: "line_end must be >= line_start",
  });

export const SymbolSummary = z
  .object({
    purpose: z
      .string()
      .min(30)
      .max(400)
      .refine((s) => !BANNED_PURPOSE_PREFIX_RE.test(s.trim()), {
        message:
          'purpose must not start with "This function/method/class" — describe the behavior directly',
      }),
    inputs: z.array(InputSpec),
    returns: ReturnSpec,
    side_effects: z.array(
      z
        .string()
        .min(10)
        .max(200)
        .refine((s) => SIDE_EFFECT_VERB_RE.test(s), {
          message: "side_effects item must mention one of reads/writes/emits/raises/mutates",
        }),
    ),
    invariants: z.array(z.string().min(10).max(300)).nullable(),
    citations: z.array(Citation).min(1),
  })
  .strict()
  .superRefine((val, ctx) => {
    // purpose and returns are always populated; inputs / side_effects /
    // invariants are only populated when non-empty. Every populated field
    // must carry at least one citation — this is the core staleness-
    // detection invariant and the reason to run superRefine rather than
    // enforce per-field.
    const populated = new Set<string>(["purpose", "returns"]);
    if (val.inputs.length > 0) populated.add("inputs");
    if (val.side_effects.length > 0) populated.add("side_effects");
    if (val.invariants && val.invariants.length > 0) populated.add("invariants");

    const cited = new Set(val.citations.map((c) => c.field_name));
    for (const field of populated) {
      if (!cited.has(field as "purpose" | "inputs" | "returns" | "side_effects" | "invariants")) {
        ctx.addIssue({
          code: "custom",
          message: `field '${field}' is populated but has no citation`,
          path: ["citations"],
        });
      }
    }
  });

export type SymbolSummaryT = z.infer<typeof SymbolSummary>;

/**
 * Emit the JSON Schema Bedrock's Converse API expects inside
 * `toolConfig.tools[].toolSpec.inputSchema.json`. Strips the `$schema` key
 * to keep the cacheable prefix tight and byte-stable across runs.
 */
export function buildToolInputSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(SymbolSummary) as Record<string, unknown>;
  delete schema["$schema"];
  return schema;
}

/**
 * Cross-check that every citation's line range falls inside the supplied
 * source span. Zod cannot express this (it depends on run-time context),
 * so we run it as a second pass after `safeParse` succeeds.
 */
export function validateCitationLines(
  summary: SymbolSummaryT,
  sourceLineStart: number,
  sourceLineEnd: number,
): string[] {
  const errors: string[] = [];
  summary.citations.forEach((c, i) => {
    if (c.line_start < sourceLineStart || c.line_end > sourceLineEnd) {
      errors.push(
        `citations[${i}]: line range [${c.line_start}, ${c.line_end}] falls outside source span ` +
          `[${sourceLineStart}, ${sourceLineEnd}]`,
      );
    }
  });
  return errors;
}

export function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => `- at ${i.path.join(".") || "<root>"}: ${i.message} (code=${i.code})`)
    .join("\n");
}
