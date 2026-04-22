import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { isRevertCommit } from "./revert-detect.js";

describe("isRevertCommit", () => {
  it("matches the default git-revert subject form", () => {
    assert.equal(isRevertCommit('Revert "feat: add widget"', ""), true);
  });

  it("matches the default git-revert body form", () => {
    assert.equal(isRevertCommit("fix: rollback", "This reverts commit abc123def456789012"), true);
  });

  it("matches the --reference body form", () => {
    const body = 'This reverts abc123def456 ("feat: widget", 2024-01-01)';
    assert.equal(isRevertCommit("chore: revert", body), true);
  });

  it("combines subject + body but the dedupe keeps it a single detection", () => {
    // A combined commit where both flags fire: function still returns true
    // (a single 'isRevert' event). Callers dedupe by SHA, so this is a
    // single-count commit from their perspective.
    const subj = 'Revert "feat: x"';
    const body = "This reverts commit deadbeef0000";
    assert.equal(isRevertCommit(subj, body), true);
  });

  it("returns false for a normal commit", () => {
    assert.equal(isRevertCommit("feat: add widget", "body"), false);
  });

  it("returns false for an arbitrary subject mentioning revert in prose", () => {
    // No quoted subject, no body marker.
    assert.equal(isRevertCommit("thinking about revert later", ""), false);
  });
});
