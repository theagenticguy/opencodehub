import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  AMBIGUOUS_REPO_CHOICES_CAP,
  type AmbiguousRepoDetail,
  type RepoChoice,
  toolAmbiguousRepoError,
  toolError,
  toolErrorFromUnknown,
} from "./error-envelope.js";

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

// ---------------------------------------------------------------------------
// Structured AMBIGUOUS_REPO with choices[] + total_matches.
// ---------------------------------------------------------------------------

test("toolAmbiguousRepoError populates structured fields alongside legacy ones", () => {
  const choices: readonly RepoChoice[] = [
    { repo_uri: "github.com/org/alpha", default_branch: null, group: null },
    { repo_uri: "github.com/org/bravo", default_branch: null, group: null },
  ];
  const result = toolAmbiguousRepoError({
    message: "No `repo` arg provided but 2 repos are registered.",
    hint: "Pass `repo_uri` (or `repo`) to disambiguate. Registered repos: alpha, bravo.",
    choices,
    totalMatches: 2,
  });

  // Legacy contract (same as error-envelope.test.ts:39-47).
  assert.equal(result.isError, true);
  const first = result.content[0];
  assert.ok(first && first.type === "text");
  assert.match(first.text, /Error \(AMBIGUOUS_REPO\)/);

  const detail = (result.structuredContent as { error: AmbiguousRepoDetail }).error;
  assert.equal(detail.code, "AMBIGUOUS_REPO");
  assert.ok(detail.message.includes("2 repos"));
  assert.ok(detail.hint?.includes("alpha"));

  // Structured contract — error_code + jsonrpc_code + counts.
  assert.equal(detail.error_code, "AMBIGUOUS_REPO");
  assert.equal(detail.jsonrpc_code, -32602);
  assert.equal(detail.total_matches, 2);
  assert.equal(detail.choices.length, 2);
  assert.equal(detail.choices[0]?.repo_uri, "github.com/org/alpha");
  assert.equal(detail.choices[0]?.default_branch, null);
  assert.equal(detail.choices[0]?.group, null);
});

test("toolAmbiguousRepoError caps choices[] at 10 but preserves total_matches", () => {
  const choices: RepoChoice[] = [];
  for (let i = 0; i < 15; i += 1) {
    choices.push({
      repo_uri: `local:${i.toString().padStart(12, "0")}`,
      default_branch: null,
      group: null,
    });
  }
  const result = toolAmbiguousRepoError({
    message: "No `repo` arg provided but 15 repos are registered.",
    hint: "Pass `repo_uri` to disambiguate.",
    choices,
    totalMatches: 15,
  });
  const detail = (result.structuredContent as { error: AmbiguousRepoDetail }).error;
  assert.equal(detail.choices.length, AMBIGUOUS_REPO_CHOICES_CAP);
  assert.equal(detail.choices.length, 10);
  // The caller still learns the untruncated count.
  assert.equal(detail.total_matches, 15);
});
