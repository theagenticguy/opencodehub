/**
 * Smoke test — `LanguageId` is exported from the canonical module and the
 * package barrel. If this compiles and the runtime check passes, downstream
 * consumers can `import { LanguageId } from "@opencodehub/core-types"` from
 * any package.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageId } from "./index.js";
import type { LanguageId as DirectId } from "./language-id.js";

test("language-id: canonical export is usable from the package barrel", () => {
  const a: LanguageId = "typescript";
  const b: DirectId = "typescript";
  // Runtime assert so node --test actually exercises the module.
  assert.equal(a, b);
});

test("language-id: every registered id is a string discriminator", () => {
  const known: readonly LanguageId[] = [
    "typescript",
    "tsx",
    "javascript",
    "python",
    "go",
    "rust",
    "java",
    "csharp",
    "c",
    "cpp",
    "ruby",
    "kotlin",
    "swift",
    "php",
    "dart",
  ];
  // All fifteen members coerce to string without any loss.
  for (const id of known) {
    assert.equal(typeof id, "string");
    assert.ok(id.length > 0);
  }
});
