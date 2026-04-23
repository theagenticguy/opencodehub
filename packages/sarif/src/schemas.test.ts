import assert from "node:assert/strict";
import { test } from "node:test";
import { SarifLogSchema, SarifResultSchema, SarifRunSchema } from "./schemas.js";

test("SarifLogSchema: accepts the SARIF v2.1.0 minimal valid example", () => {
  const log = {
    $schema:
      "https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "opencodehub-merged", version: "1.0.0" } },
        results: [
          {
            ruleId: "semgrep.rule.id",
            level: "error",
            message: { text: "Potential SSRF" },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: "src/api.ts" },
                  region: { startLine: 42, startColumn: 5 },
                },
              },
            ],
            partialFingerprints: { primaryLocationLineHash: "abc123" },
            properties: {
              "opencodehub.blastRadius": 7,
              "opencodehub.cochangeScore": 0.81,
            },
          },
        ],
      },
    ],
  };

  const parsed = SarifLogSchema.safeParse(log);
  assert.equal(parsed.success, true);
});

test("SarifLogSchema: rejects version != '2.1.0'", () => {
  const parsed = SarifLogSchema.safeParse({
    version: "2.2.0",
    runs: [{ tool: { driver: { name: "x" } } }],
  });
  assert.equal(parsed.success, false);
});

test("SarifLogSchema: rejects missing 'runs'", () => {
  const parsed = SarifLogSchema.safeParse({ version: "2.1.0" });
  assert.equal(parsed.success, false);
});

test("SarifLogSchema: passthrough preserves unknown top-level fields", () => {
  const input = {
    version: "2.1.0",
    runs: [{ tool: { driver: { name: "driver-x" } } }],
    inlineExternalProperties: [{ runGuid: "e17b1b13-1f0e-4b6f-a3a2-9fd66e3d1c11" }],
    vendorCustom: { k: "v" },
  };
  interface LooseLog {
    inlineExternalProperties?: unknown;
    vendorCustom?: unknown;
  }
  const parsed = SarifLogSchema.parse(input) as unknown as LooseLog;
  assert.deepEqual(parsed.inlineExternalProperties, input.inlineExternalProperties);
  assert.deepEqual(parsed.vendorCustom, input.vendorCustom);
});

test("SarifRunSchema: tool.driver.name is required", () => {
  const missingName = SarifRunSchema.safeParse({ tool: { driver: {} } });
  assert.equal(missingName.success, false);
});

test("SarifResultSchema: allows the minimum shape", () => {
  const parsed = SarifResultSchema.safeParse({
    ruleId: "R1",
    message: { text: "hi" },
  });
  assert.equal(parsed.success, true);
});

test("SarifResultSchema: passthrough preserves unknown result fields", () => {
  interface LooseResult {
    kind?: string;
    rank?: number;
  }
  const parsed = SarifResultSchema.parse({
    ruleId: "R1",
    kind: "fail",
    rank: 42,
    suppressions: [],
  }) as unknown as LooseResult;
  assert.equal(parsed.kind, "fail");
  assert.equal(parsed.rank, 42);
});

test("SarifLogSchema: validates a real multi-tool merged example", () => {
  const log = {
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "semgrep", version: "1.50.0" } },
        results: [
          {
            ruleId: "semgrep.xss",
            message: { text: "XSS risk" },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: "web/page.tsx" },
                  region: { startLine: 10 },
                },
              },
            ],
            fingerprints: { hash1: "deadbeef" },
          },
        ],
      },
      {
        tool: { driver: { name: "gitleaks", semanticVersion: "8.18.0" } },
        results: [],
      },
    ],
  };
  const parsed = SarifLogSchema.safeParse(log);
  assert.equal(parsed.success, true);
});
