/**
 * Tests for `assertEmbedderCompatible`.
 */

import { equal, ok } from "node:assert/strict";
import { describe, test } from "node:test";
import { assertEmbedderCompatible, EMBEDDER_MISMATCH_HINT } from "./fingerprint.js";

describe("assertEmbedderCompatible", () => {
  test("ok when persisted is undefined (legacy store, never tagged)", () => {
    const result = assertEmbedderCompatible(undefined, "f2llm-v2-80m/fp32", false);
    ok(result.ok);
  });

  test("ok when persisted equals current", () => {
    const result = assertEmbedderCompatible("f2llm-v2-80m/fp32", "f2llm-v2-80m/fp32", false);
    ok(result.ok);
  });

  test("ok when persisted differs from current but force is true", () => {
    const result = assertEmbedderCompatible(
      "f2llm-v2-80m/fp32",
      "f2llm-v2-80m/sagemaker:my-endpoint",
      true,
    );
    ok(result.ok);
  });

  test("not ok when persisted differs from current and force is false", () => {
    const result = assertEmbedderCompatible(
      "f2llm-v2-80m/fp32",
      "f2llm-v2-80m/sagemaker:my-endpoint",
      false,
    );
    ok(!result.ok);
    if (!result.ok) {
      equal(result.persistedModelId, "f2llm-v2-80m/fp32");
      equal(result.currentModelId, "f2llm-v2-80m/sagemaker:my-endpoint");
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
