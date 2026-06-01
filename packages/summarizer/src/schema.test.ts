/**
 * Unit tests for the Zod contract and the run-time citation-bounds pass.
 *
 * These exercise the validation layer directly — no Bedrock, no network.
 * The schema is the citation-grounding heart of the summarizer, so every
 * refinement (banned purpose prefix, side-effect verb, per-field citation
 * via superRefine) and the `validateCitationLines` bounds math gets a focused
 * case here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildToolInputSchema,
  formatZodError,
  SymbolSummary,
  type SymbolSummaryT,
  validateCitationLines,
} from "./schema.js";

/**
 * Smallest summary that passes every refinement. Tests clone and mutate it to
 * isolate a single failure mode.
 */
function validSummary(): SymbolSummaryT {
  return {
    purpose: "Normalize a filesystem path into a canonical absolute form for cache keys.",
    inputs: [{ name: "path", type: "str", description: "the raw path string to normalize" }],
    returns: {
      type: "str",
      type_summary: "the canonical absolute path",
      details: "An absolute, symlink-resolved path string with no trailing slash.",
    },
    side_effects: ["reads the current working directory to resolve relative paths"],
    invariants: ["the result is always an absolute path"],
    citations: [
      { field_name: "purpose", line_start: 10, line_end: 12 },
      { field_name: "inputs", line_start: 10, line_end: 10 },
      { field_name: "returns", line_start: 14, line_end: 16 },
      { field_name: "side_effects", line_start: 13, line_end: 13 },
      { field_name: "invariants", line_start: 16, line_end: 16 },
    ],
  };
}

// ---------------------------------------------------------------------------
// SymbolSummary.safeParse — happy path
// ---------------------------------------------------------------------------

test("SymbolSummary: accepts a fully-populated, citation-complete summary", () => {
  const parsed = SymbolSummary.safeParse(validSummary());
  assert.equal(parsed.success, true);
});

test("SymbolSummary: accepts empty inputs/side_effects with no citation for them", () => {
  const summary = validSummary();
  const minimal = {
    ...summary,
    inputs: [],
    side_effects: [],
    invariants: null,
    citations: [
      { field_name: "purpose", line_start: 10, line_end: 12 },
      { field_name: "returns", line_start: 14, line_end: 16 },
    ],
  };
  const parsed = SymbolSummary.safeParse(minimal);
  assert.equal(parsed.success, true);
});

// ---------------------------------------------------------------------------
// SymbolSummary.safeParse — each invalid shape
// ---------------------------------------------------------------------------

test("SymbolSummary: rejects a purpose that starts with 'This function'", () => {
  const summary = {
    ...validSummary(),
    purpose: "This function normalizes a path into a canonical form for use as a cache key.",
  };
  const parsed = SymbolSummary.safeParse(summary);
  assert.equal(parsed.success, false);
  assert.match(formatZodError(parsed.error), /describe the behavior directly/);
});

test("SymbolSummary: rejects a side_effects item with no read/write/emit/raise/mutate verb", () => {
  const summary = { ...validSummary(), side_effects: ["manages some internal state somehow"] };
  const parsed = SymbolSummary.safeParse(summary);
  assert.equal(parsed.success, false);
  assert.match(formatZodError(parsed.error), /reads\/writes\/emits\/raises\/mutates/);
});

test("SymbolSummary: rejects a populated field with no matching citation", () => {
  const summary = validSummary();
  // Drop the side_effects citation while keeping the side_effects array populated.
  const missing = {
    ...summary,
    citations: summary.citations.filter((c) => c.field_name !== "side_effects"),
  };
  const parsed = SymbolSummary.safeParse(missing);
  assert.equal(parsed.success, false);
  assert.match(
    formatZodError(parsed.error),
    /field 'side_effects' is populated but has no citation/,
  );
});

test("SymbolSummary: rejects a citation whose line_end precedes line_start", () => {
  const summary = validSummary();
  const inverted = {
    ...summary,
    citations: [
      { field_name: "purpose", line_start: 12, line_end: 10 },
      ...summary.citations.slice(1),
    ],
  };
  const parsed = SymbolSummary.safeParse(inverted);
  assert.equal(parsed.success, false);
  assert.match(formatZodError(parsed.error), /line_end must be >= line_start/);
});

test("SymbolSummary: rejects an empty citations array (min 1)", () => {
  const summary = { ...validSummary(), citations: [] };
  const parsed = SymbolSummary.safeParse(summary);
  assert.equal(parsed.success, false);
});

test("SymbolSummary: rejects unknown top-level keys (strict)", () => {
  const summary = { ...validSummary(), complexity: 7 };
  const parsed = SymbolSummary.safeParse(summary);
  assert.equal(parsed.success, false);
});

// ---------------------------------------------------------------------------
// validateCitationLines — bounds math
// ---------------------------------------------------------------------------

test("validateCitationLines: returns no errors when every citation is in-bounds", () => {
  const errors = validateCitationLines(validSummary(), 10, 16);
  assert.deepEqual(errors, []);
});

test("validateCitationLines: accepts citations exactly on the lineStart/lineEnd boundary", () => {
  const summary = validSummary();
  const onBoundary = {
    ...summary,
    citations: [
      { field_name: "purpose" as const, line_start: 10, line_end: 10 },
      { field_name: "returns" as const, line_start: 16, line_end: 16 },
    ],
    inputs: [],
    side_effects: [],
    invariants: null,
  };
  assert.deepEqual(validateCitationLines(onBoundary, 10, 16), []);
});

test("validateCitationLines: flags an off-by-one below lineStart", () => {
  const summary = validSummary();
  const below = {
    ...summary,
    citations: [{ field_name: "purpose" as const, line_start: 9, line_end: 12 }],
  };
  const errors = validateCitationLines(below, 10, 16);
  assert.equal(errors.length, 1);
  assert.match(errors[0] as string, /falls outside source span \[10, 16\]/);
});

test("validateCitationLines: flags an off-by-one above lineEnd", () => {
  const summary = validSummary();
  const above = {
    ...summary,
    citations: [{ field_name: "returns" as const, line_start: 14, line_end: 17 }],
  };
  const errors = validateCitationLines(above, 10, 16);
  assert.equal(errors.length, 1);
  assert.match(errors[0] as string, /\[14, 17\] falls outside source span \[10, 16\]/);
});

test("validateCitationLines: reports one error per out-of-bounds citation, with its index", () => {
  const summary = validSummary();
  const twoBad = {
    ...summary,
    citations: [
      { field_name: "purpose" as const, line_start: 10, line_end: 16 },
      { field_name: "returns" as const, line_start: 1, line_end: 2 },
      { field_name: "side_effects" as const, line_start: 100, line_end: 200 },
    ],
  };
  const errors = validateCitationLines(twoBad, 10, 16);
  assert.equal(errors.length, 2);
  assert.match(errors[0] as string, /^citations\[1\]:/);
  assert.match(errors[1] as string, /^citations\[2\]:/);
});

// ---------------------------------------------------------------------------
// buildToolInputSchema — JSON-Schema export
// ---------------------------------------------------------------------------

test("buildToolInputSchema: strips the $schema key for a tight, byte-stable prefix", () => {
  const schema = buildToolInputSchema();
  assert.equal("$schema" in schema, false);
});

test("buildToolInputSchema: emits an object schema with all five summary properties", () => {
  const schema = buildToolInputSchema();
  assert.equal(schema["type"], "object");
  const props = schema["properties"] as Record<string, unknown>;
  for (const field of ["purpose", "inputs", "returns", "side_effects", "invariants", "citations"]) {
    assert.ok(field in props, `expected schema property '${field}'`);
  }
});

test("buildToolInputSchema: is deterministic across calls (stable cache key)", () => {
  assert.equal(JSON.stringify(buildToolInputSchema()), JSON.stringify(buildToolInputSchema()));
});

// ---------------------------------------------------------------------------
// formatZodError — feedback string shape
// ---------------------------------------------------------------------------

test("formatZodError: renders each issue as a bulleted path + message + code line", () => {
  const parsed = SymbolSummary.safeParse({ ...validSummary(), purpose: "short" });
  assert.equal(parsed.success, false);
  const text = formatZodError(parsed.error);
  assert.match(text, /^- at /m);
  assert.match(text, /\(code=/);
});
