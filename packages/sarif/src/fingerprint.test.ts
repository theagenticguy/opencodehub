/** Stable-fingerprint tests: context window stability, key preservation, idempotency. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeContextHash,
  computeOpenCodeHubFingerprint,
  computePrimaryLocationLineHash,
  enrichWithFingerprints,
} from "./fingerprint.js";
import type { SarifLog } from "./schemas.js";

const SCANNER_ID = "semgrep";
const RULE_ID = "semgrep.xss";
const FILE_PATH = "web/page.tsx";

const BASE_SOURCE = [
  "line01 alpha",
  "line02 bravo",
  "line03 charlie",
  "line04 delta",
  "line05 finding here",
  "line06 foxtrot",
  "line07 golf",
  "line08 hotel",
  "line09 india",
  "line10 juliet",
].join("\n");

function fingerprintFor(source: string, startLine: number, ruleId = RULE_ID, filePath = FILE_PATH) {
  const contextHash = computeContextHash(source, startLine);
  return computeOpenCodeHubFingerprint({
    scannerId: SCANNER_ID,
    ruleId,
    filePath,
    contextHash,
  });
}

function makeLog(partial?: { primaryLocationLineHash?: string }): SarifLog {
  const pf: Record<string, string> = {};
  if (partial?.primaryLocationLineHash !== undefined) {
    pf["primaryLocationLineHash"] = partial.primaryLocationLineHash;
  }
  return {
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: SCANNER_ID, version: "1.0.0" } },
        results: [
          {
            ruleId: RULE_ID,
            message: { text: "XSS risk" },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: FILE_PATH },
                  region: { startLine: 5 },
                },
              },
            ],
            ...(Object.keys(pf).length > 0 ? { partialFingerprints: pf } : {}),
          },
        ],
      },
    ],
  };
}

test("fingerprint stable across whitespace-only edits within the ±3 window", () => {
  const before = fingerprintFor(BASE_SOURCE, 5);
  const lines = BASE_SOURCE.split("\n");
  // Mutate line 7 (within the ±3 window for startLine=5) with whitespace only.
  lines[6] = `${lines[6]}   `;
  lines[3] = `\t${lines[3]}`;
  const whitespaceOnlyEdit = lines.join("\n");
  const after = fingerprintFor(whitespaceOnlyEdit, 5);
  assert.equal(before, after);
});

test("fingerprint stable across unrelated edits outside the ±3 window", () => {
  const before = fingerprintFor(BASE_SOURCE, 5);
  const lines = BASE_SOURCE.split("\n");
  // Line 20 would be way out of window; we only have 10 lines — edit line 10 instead.
  lines[9] = "line10 juliet TOTALLY DIFFERENT CONTENT";
  const farEdit = lines.join("\n");
  const after = fingerprintFor(farEdit, 5);
  assert.equal(before, after);
});

test("fingerprint changes when ruleId changes", () => {
  const a = fingerprintFor(BASE_SOURCE, 5, "semgrep.xss");
  const b = fingerprintFor(BASE_SOURCE, 5, "semgrep.sqli");
  assert.notEqual(a, b);
});

test("fingerprint changes when filePath changes", () => {
  const a = fingerprintFor(BASE_SOURCE, 5, RULE_ID, "web/page.tsx");
  const b = fingerprintFor(BASE_SOURCE, 5, RULE_ID, "web/other.tsx");
  assert.notEqual(a, b);
});

test("enrichWithFingerprints preserves existing primaryLocationLineHash", () => {
  const preset = "preset-ghas-key";
  const input = makeLog({ primaryLocationLineHash: preset });
  const output = enrichWithFingerprints(input, {
    readSource: () => BASE_SOURCE,
  });
  const pf = output.runs[0]?.results?.[0]?.partialFingerprints;
  assert.ok(pf);
  assert.equal(pf["primaryLocationLineHash"], preset);
  assert.ok(typeof pf["opencodehub/v1"] === "string" && pf["opencodehub/v1"].length === 32);
});

test("enrichWithFingerprints adds both keys and is idempotent on re-enrichment", () => {
  const input = makeLog();
  const first = enrichWithFingerprints(input, { readSource: () => BASE_SOURCE });
  const firstPf = first.runs[0]?.results?.[0]?.partialFingerprints;
  assert.ok(firstPf);
  assert.ok(typeof firstPf["primaryLocationLineHash"] === "string");
  assert.ok(typeof firstPf["opencodehub/v1"] === "string");

  const second = enrichWithFingerprints(first, { readSource: () => BASE_SOURCE });
  assert.equal(JSON.stringify(second), JSON.stringify(first));
});

test("enrichWithFingerprints does not mutate the input log (deep-clone safety)", () => {
  const input = makeLog();
  const snapshot = JSON.stringify(input);
  enrichWithFingerprints(input, { readSource: () => BASE_SOURCE });
  assert.equal(JSON.stringify(input), snapshot);
});

test("enrichWithFingerprints falls back deterministically when readSource fails", () => {
  const input = makeLog();
  const failingReader = () => {
    throw new Error("boom");
  };
  const a = enrichWithFingerprints(input, { readSource: failingReader });
  const b = enrichWithFingerprints(input, { readSource: failingReader });
  const aPf = a.runs[0]?.results?.[0]?.partialFingerprints;
  const bPf = b.runs[0]?.results?.[0]?.partialFingerprints;
  assert.ok(aPf && bPf);
  assert.equal(aPf["opencodehub/v1"], bPf["opencodehub/v1"]);
  assert.equal(aPf["primaryLocationLineHash"], bPf["primaryLocationLineHash"]);
});

test("computePrimaryLocationLineHash format: <16-hex>:<startLine>", () => {
  const hash = computePrimaryLocationLineHash({
    ruleId: RULE_ID,
    filePath: FILE_PATH,
    startLine: 42,
    snippet: "  const x =   1;  ",
  });
  assert.match(hash, /^[0-9a-f]{16}:42$/);
});
