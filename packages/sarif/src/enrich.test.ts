import assert from "node:assert/strict";
import { test } from "node:test";
import { enrichWithProperties, type ResultEnrichment } from "./enrich.js";
import type { SarifLog } from "./schemas.js";

/** Typed view of what an OpenCodeHub namespace bag looks like in assertions. */
interface OpenCodeHubBagAssert {
  blastRadius?: number;
  community?: string;
  cochangeScore?: number;
  centrality?: number;
  temporalFixDensity?: number;
  busFactor?: number;
  cyclomaticComplexity?: number;
  ownershipDrift?: number;
  enrichedAt?: string;
  enrichmentVersion?: string;
  sources?: string[];
  priorKey?: string;
}

interface PropsBagAssert {
  opencodehub?: OpenCodeHubBagAssert;
  "microsoft.classification"?: string;
  "github.alertNumber"?: number;
}

function fixture(): SarifLog {
  return {
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
            partialFingerprints: {
              primaryLocationLineHash: "fp-xss-1",
              extra: "stays-as-is",
            },
            fingerprints: { hash1: "deadbeef" },
          },
          {
            ruleId: "semgrep.sqli",
            message: { text: "SQLi risk" },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: "src/db.ts" },
                  region: { startLine: 22 },
                },
              },
            ],
            partialFingerprints: { primaryLocationLineHash: "fp-sqli-1" },
          },
        ],
      },
    ],
  };
}

function resultProps(log: SarifLog, resultIdx: number): PropsBagAssert {
  const props = log.runs[0]?.results?.[resultIdx]?.properties as PropsBagAssert | undefined;
  assert.ok(props, `expected result[${resultIdx}] properties bag`);
  return props;
}

function resultNsBag(log: SarifLog, resultIdx: number): OpenCodeHubBagAssert {
  const ns = resultProps(log, resultIdx).opencodehub;
  assert.ok(ns, `expected result[${resultIdx}] opencodehub namespaced bag`);
  return ns;
}

test("enrichWithProperties: preserves fingerprints byte-identity", () => {
  const input = fixture();
  const before = JSON.stringify(input.runs[0]?.results?.[0]?.fingerprints);
  const beforePf = JSON.stringify(input.runs[0]?.results?.[0]?.partialFingerprints);

  const output = enrichWithProperties(input, {
    byResultIndex: new Map<number, ResultEnrichment>([
      [0, { blastRadius: 7, cochangeScore: 0.81 }],
    ]),
  });

  const after = JSON.stringify(output.runs[0]?.results?.[0]?.fingerprints);
  const afterPf = JSON.stringify(output.runs[0]?.results?.[0]?.partialFingerprints);
  assert.strictEqual(before, after);
  assert.strictEqual(beforePf, afterPf);
});

test("enrichWithProperties: never mutates ruleId or artifactLocation.uri", () => {
  const input = fixture();
  const output = enrichWithProperties(input, {
    byResultIndex: new Map<number, ResultEnrichment>([
      [0, { blastRadius: 7 }],
      [1, { blastRadius: 3 }],
    ]),
  });

  const inResults = input.runs[0]?.results;
  const outResults = output.runs[0]?.results;
  assert.ok(inResults && outResults);
  for (let i = 0; i < inResults.length; i += 1) {
    assert.equal(outResults[i]?.ruleId, inResults[i]?.ruleId);
    assert.equal(
      outResults[i]?.locations?.[0]?.physicalLocation?.artifactLocation.uri,
      inResults[i]?.locations?.[0]?.physicalLocation?.artifactLocation.uri,
    );
  }
});

test("enrichWithProperties: adds result.properties.opencodehub.blastRadius", () => {
  const output = enrichWithProperties(fixture(), {
    byResultIndex: new Map<number, ResultEnrichment>([
      [0, { blastRadius: 7, cochangeScore: 0.81, community: "auth-core" }],
    ]),
  });

  const ns = resultNsBag(output, 0);
  assert.equal(ns.blastRadius, 7);
  assert.equal(ns.cochangeScore, 0.81);
  assert.equal(ns.community, "auth-core");
});

test("enrichWithProperties: prefers byResultFingerprint over byResultIndex", () => {
  const output = enrichWithProperties(fixture(), {
    byResultFingerprint: new Map<string, ResultEnrichment>([["fp-xss-1", { blastRadius: 99 }]]),
    byResultIndex: new Map<number, ResultEnrichment>([[0, { blastRadius: 1 }]]),
  });

  const ns = resultNsBag(output, 0);
  assert.equal(ns.blastRadius, 99);
});

test("enrichWithProperties: falls back to byResultIndex when no fp match", () => {
  const output = enrichWithProperties(fixture(), {
    byResultFingerprint: new Map<string, ResultEnrichment>([
      ["does-not-match", { blastRadius: 999 }],
    ]),
    byResultIndex: new Map<number, ResultEnrichment>([[0, { blastRadius: 5 }]]),
  });

  const ns = resultNsBag(output, 0);
  assert.equal(ns.blastRadius, 5);
});

test("enrichWithProperties: writes run-level opencodehub.* properties", () => {
  const output = enrichWithProperties(fixture(), {
    run: {
      enrichedAt: "2026-04-18T00:00:00Z",
      enrichmentVersion: "1.0",
      sources: ["git_temporal.json", "risk_profile.json"],
    },
  });

  const runProps = output.runs[0]?.properties as PropsBagAssert | undefined;
  assert.ok(runProps);
  const ns = runProps.opencodehub;
  assert.ok(ns);
  assert.equal(ns.enrichedAt, "2026-04-18T00:00:00Z");
  assert.equal(ns.enrichmentVersion, "1.0");
  assert.deepEqual(ns.sources, ["git_temporal.json", "risk_profile.json"]);
});

test("enrichWithProperties: preserves unknown top-level properties (passthrough)", () => {
  const input: SarifLog = {
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "semgrep" } },
        results: [
          {
            ruleId: "R1",
            message: { text: "hi" },
            properties: {
              "microsoft.classification": "security",
              "github.alertNumber": 42,
            },
          },
        ],
      },
    ],
  };

  const output = enrichWithProperties(input, {
    byResultIndex: new Map<number, ResultEnrichment>([[0, { blastRadius: 2 }]]),
  });

  const props = resultProps(output, 0);
  assert.equal(props["microsoft.classification"], "security");
  assert.equal(props["github.alertNumber"], 42);
  assert.equal(props.opencodehub?.blastRadius, 2);
});

test("enrichWithProperties: input is not mutated (deep-clone)", () => {
  const input = fixture();
  const snapshot = JSON.stringify(input);
  enrichWithProperties(input, {
    byResultIndex: new Map<number, ResultEnrichment>([[0, { blastRadius: 10 }]]),
    run: { enrichedAt: "2026-04-18T00:00:00Z" },
  });
  assert.equal(JSON.stringify(input), snapshot);
});

test("enrichWithProperties: no enrichments leaves results untouched", () => {
  const input = fixture();
  const output = enrichWithProperties(input, {});
  assert.equal(JSON.stringify(output), JSON.stringify(input));
});

test("enrichWithProperties: rejects bad schema version", () => {
  const bad = { version: "2.2.0", runs: [] } as unknown as SarifLog;
  assert.throws(() => enrichWithProperties(bad, {}), /schema validation/);
});

test("enrichWithProperties: merges into existing opencodehub bag, not clobbers", () => {
  const input: SarifLog = {
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "semgrep" } },
        results: [
          {
            ruleId: "R1",
            message: { text: "hi" },
            properties: {
              opencodehub: { priorKey: "kept" },
            },
          },
        ],
      },
    ],
  };
  const output = enrichWithProperties(input, {
    byResultIndex: new Map<number, ResultEnrichment>([[0, { blastRadius: 4 }]]),
  });
  const ns = resultNsBag(output, 0);
  assert.equal(ns.priorKey, "kept");
  assert.equal(ns.blastRadius, 4);
});
