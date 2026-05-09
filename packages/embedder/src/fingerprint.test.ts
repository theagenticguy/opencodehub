/**
 * Tests for `assertEmbedderCompatible`.
 */

import { equal, ok } from "node:assert/strict";
import { describe, test } from "node:test";
import { assertEmbedderCompatible, EMBEDDER_MISMATCH_HINT } from "./fingerprint.js";

describe("assertEmbedderCompatible", () => {
  test("ok when persisted is undefined (legacy store, never tagged)", () => {
    const result = assertEmbedderCompatible(undefined, "gte-modernbert-base/fp32", false);
    ok(result.ok);
  });

  test("ok when persisted equals current", () => {
    const result = assertEmbedderCompatible(
      "gte-modernbert-base/fp32",
      "gte-modernbert-base/fp32",
      false,
    );
    ok(result.ok);
  });

  test("ok when persisted differs from current but force is true", () => {
    const result = assertEmbedderCompatible(
      "gte-modernbert-base/fp32",
      "sagemaker:gte-modernbert-base@my-endpoint",
      true,
    );
    ok(result.ok);
  });

  test("not ok when persisted differs from current and force is false", () => {
    const result = assertEmbedderCompatible(
      "gte-modernbert-base/fp32",
      "sagemaker:gte-modernbert-base@my-endpoint",
      false,
    );
    ok(!result.ok);
    if (!result.ok) {
      equal(result.persistedModelId, "gte-modernbert-base/fp32");
      equal(result.currentModelId, "sagemaker:gte-modernbert-base@my-endpoint");
      equal(result.hint, EMBEDDER_MISMATCH_HINT);
    }
  });

  test("hint is the stable remediation string", () => {
    equal(
      EMBEDDER_MISMATCH_HINT,
      "Re-run 'codehub analyze --force' or pass --force-backend-mismatch to " +
        "query with potentially stale vectors.",
    );
  });
});
