/**
 * detect-secrets JSON → SARIF v2.1.0 converter tests.
 *
 * Every generated SARIF log is validated against `SarifLogSchema` from
 * @opencodehub/sarif so schema drift is caught at the conversion boundary.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { SarifLogSchema } from "@opencodehub/sarif";
import { detectSecretsJsonToSarif } from "./detect-secrets-to-sarif.js";

function assertValidSarif(log: unknown): void {
  const result = SarifLogSchema.safeParse(log);
  assert.ok(result.success, `expected valid SARIF: ${result.success ? "" : result.error.message}`);
}

test("detectSecretsJsonToSarif emits one result per finding across files", () => {
  const json = {
    version: "1.5.0",
    plugins_used: [],
    filters_used: [],
    results: {
      "src/config.ts": [
        {
          type: "AWS Access Key",
          filename: "src/config.ts",
          hashed_secret: "abc123",
          is_verified: false,
          line_number: 10,
        },
        {
          type: "Secret_Keyword",
          filename: "src/config.ts",
          hashed_secret: "def456",
          is_verified: false,
          line_number: 11,
        },
      ],
      "src/db.ts": [
        {
          type: "Basic Auth Credentials",
          filename: "src/db.ts",
          hashed_secret: "ghi789",
          is_verified: true,
          line_number: 4,
        },
      ],
    },
    generated_at: "2026-05-09T19:00:00Z",
  };
  const log = detectSecretsJsonToSarif(json);
  assertValidSarif(log);
  assert.equal(log.runs.length, 1);
  assert.equal(log.runs[0]?.tool.driver.name, "detect-secrets");
  assert.equal(log.runs[0]?.tool.driver.version, "1.5.0");
  const results = log.runs[0]?.results ?? [];
  assert.equal(results.length, 3);
  assert.equal(results[0]?.ruleId, "AWSKeyDetector");
  assert.equal(results[1]?.ruleId, "KeywordDetector");
  assert.equal(results[2]?.ruleId, "BasicAuthDetector");
});

test("detectSecretsJsonToSarif marks verified findings as error", () => {
  const json = {
    results: {
      "x.ts": [
        {
          type: "AWS Access Key",
          filename: "x.ts",
          hashed_secret: "h1",
          is_verified: true,
          line_number: 1,
        },
        {
          type: "AWS Access Key",
          filename: "x.ts",
          hashed_secret: "h2",
          is_verified: false,
          line_number: 2,
        },
      ],
    },
  };
  const log = detectSecretsJsonToSarif(json);
  assertValidSarif(log);
  const results = log.runs[0]?.results ?? [];
  assert.equal(results[0]?.level, "error");
  assert.equal(results[1]?.level, "warning");
  const props0 = (results[0]?.properties as { opencodehub?: Record<string, unknown> } | undefined)
    ?.opencodehub;
  assert.equal(props0?.["is_verified"], true);
});

test("detectSecretsJsonToSarif stamps hashed_secret on partialFingerprints (not as crypto fingerprint)", () => {
  const json = {
    results: {
      "x.ts": [
        {
          type: "AWS Access Key",
          filename: "x.ts",
          hashed_secret: "deadbeef",
          line_number: 1,
        },
      ],
    },
  };
  const log = detectSecretsJsonToSarif(json);
  const r = log.runs[0]?.results?.[0];
  // SARIF §3.27.18: partialFingerprints are plugin-defined identifiers,
  // NOT a security claim. The slot is named `detect_secrets_sha1` to
  // make the (non-cryptographic) algorithm explicit (W-B-1).
  assert.equal(r?.partialFingerprints?.["detect_secrets_sha1"], "deadbeef");
});

test("detectSecretsJsonToSarif uses 1-indexed startLine matching SARIF", () => {
  const json = {
    results: {
      "x.ts": [{ type: "AWS Access Key", filename: "x.ts", hashed_secret: "h", line_number: 42 }],
    },
  };
  const log = detectSecretsJsonToSarif(json);
  const region = log.runs[0]?.results?.[0]?.locations?.[0]?.physicalLocation?.region;
  assert.equal(region?.startLine, 42);
});

test("detectSecretsJsonToSarif passes overlapping findings through (W-B-2)", () => {
  // Two detectors fire on the same line — both must pass through and let
  // OCH's downstream SARIF dedupe handle merging.
  const json = {
    results: {
      "secret.py": [
        {
          type: "AWS Access Key",
          filename: "secret.py",
          hashed_secret: "h-aws",
          line_number: 7,
        },
        {
          type: "Secret_Keyword",
          filename: "secret.py",
          hashed_secret: "h-keyword",
          line_number: 7,
        },
      ],
    },
  };
  const log = detectSecretsJsonToSarif(json);
  const results = log.runs[0]?.results ?? [];
  assert.equal(results.length, 2);
  assert.equal(results[0]?.ruleId, "AWSKeyDetector");
  assert.equal(results[1]?.ruleId, "KeywordDetector");
  assert.equal(
    results[0]?.locations?.[0]?.physicalLocation?.region?.startLine,
    results[1]?.locations?.[0]?.physicalLocation?.region?.startLine,
  );
});

test("detectSecretsJsonToSarif slugs unknown detector types instead of dropping", () => {
  const json = {
    results: {
      "x.ts": [
        {
          type: "Future Detector v2",
          filename: "x.ts",
          hashed_secret: "h",
          line_number: 1,
        },
      ],
    },
  };
  const log = detectSecretsJsonToSarif(json);
  const r = log.runs[0]?.results?.[0];
  assert.equal(r?.ruleId, "Future-Detector-v2");
});

test("detectSecretsJsonToSarif emits empty (but valid) SARIF for garbage input", () => {
  assertValidSarif(detectSecretsJsonToSarif({}));
  assertValidSarif(detectSecretsJsonToSarif(null));
  assertValidSarif(detectSecretsJsonToSarif({ results: "not an object" }));
  assertValidSarif(detectSecretsJsonToSarif({ results: [] }));
  assert.equal(detectSecretsJsonToSarif({}).runs[0]?.results?.length, 0);
  assert.equal(
    detectSecretsJsonToSarif(null).runs[0]?.tool.driver.name,
    "detect-secrets",
    "tool.driver.name must be preserved on empty SARIF (E-B-2)",
  );
});

test("detectSecretsJsonToSarif skips findings without a type", () => {
  const json = {
    results: {
      "x.ts": [
        { type: "AWS Access Key", filename: "x.ts", hashed_secret: "ok", line_number: 1 },
        { filename: "x.ts", hashed_secret: "drop", line_number: 2 }, // no type
        { type: "", filename: "x.ts", hashed_secret: "drop", line_number: 3 }, // empty type
      ],
    },
  };
  const log = detectSecretsJsonToSarif(json);
  const results = log.runs[0]?.results ?? [];
  assert.equal(results.length, 1);
  assert.equal(results[0]?.ruleId, "AWSKeyDetector");
});

test("detectSecretsJsonToSarif tolerates findings without hashed_secret", () => {
  const json = {
    results: {
      "x.ts": [
        {
          type: "AWS Access Key",
          filename: "x.ts",
          line_number: 1,
        },
      ],
    },
  };
  const log = detectSecretsJsonToSarif(json);
  const r = log.runs[0]?.results?.[0];
  assert.equal(r?.ruleId, "AWSKeyDetector");
  assert.equal(r?.partialFingerprints, undefined);
});
