import { strict as assert } from "node:assert";
import { test } from "node:test";
import { toolError, toolErrorFromUnknown } from "./error-envelope.js";

test("toolError populates both content and structuredContent", () => {
  const result = toolError("NOT_FOUND", "no such repo", "run analyze first");
  assert.equal(result.isError, true);
  assert.equal(result.content.length, 1);
  const first = result.content[0];
  assert.ok(first && first.type === "text");
  assert.match(first.text, /Error \(NOT_FOUND\): no such repo/);
  assert.match(first.text, /Hint: run analyze first/);
  const structured = result.structuredContent as { error: { code: string } };
  assert.equal(structured.error.code, "NOT_FOUND");
});

test("toolError omits hint line when no hint provided", () => {
  const result = toolError("INTERNAL", "boom");
  const first = result.content[0];
  assert.ok(first && first.type === "text");
  assert.doesNotMatch(first.text, /Hint:/);
  const structured = result.structuredContent as { error: { hint?: string } };
  assert.equal(structured.error.hint, undefined);
});

test("toolErrorFromUnknown unwraps Error message", () => {
  const result = toolErrorFromUnknown(new Error("bad things"));
  const structured = result.structuredContent as { error: { code: string; message: string } };
  assert.equal(structured.error.code, "INTERNAL");
  assert.equal(structured.error.message, "bad things");
});

test("toolErrorFromUnknown stringifies non-Error values", () => {
  const result = toolErrorFromUnknown("just a string");
  const structured = result.structuredContent as { error: { message: string } };
  assert.equal(structured.error.message, "just a string");
});

test("toolError round-trips AMBIGUOUS_REPO with hint", () => {
  const result = toolError(
    "AMBIGUOUS_REPO",
    "No `repo` arg provided but 2 repos are registered.",
    "Pass `repo` to disambiguate. Registered repos: alpha, beta.",
  );
  assert.equal(result.isError, true);
  const structured = result.structuredContent as { error: { code: string; hint?: string } };
  assert.equal(structured.error.code, "AMBIGUOUS_REPO");
  assert.ok(structured.error.hint?.includes("alpha"));
});
