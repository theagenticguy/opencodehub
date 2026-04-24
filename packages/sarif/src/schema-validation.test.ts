/**
 * SARIF schema validation against committed fixtures.
 *
 * Complements `schemas.test.ts` (which inlines small literals) by validating
 * the Zod schemas against full SARIF v2.1.0 log files checked into
 * `packages/sarif/fixtures/`. These fixtures are representative of what the
 * `codehub scan` pipeline emits (merged Priority-1 scanners) and serve as the
 * CI gate for "OpenCodeHub emits SARIF v2.1.0-conformant logs".
 *
 * Keeping the fixtures on disk (rather than inline) makes them easy to
 * hand-edit and to reuse from the acceptance shell gate.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SarifLogSchema } from "./schemas.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// At runtime this file lives at `packages/sarif/dist/schema-validation.test.js`;
// the committed fixtures live at `packages/sarif/fixtures/`, one level up.
const PKG_ROOT = join(HERE, "..");
const FIXTURES = join(PKG_ROOT, "fixtures");

async function loadJson(path: string): Promise<unknown> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw);
}

test("schema-validation: v2.1.0 valid fixture parses cleanly", async () => {
  const log = await loadJson(join(FIXTURES, "v2.1.0-valid.sarif.json"));
  const parsed = SarifLogSchema.safeParse(log);
  if (!parsed.success) {
    console.error(parsed.error.format());
  }
  assert.equal(parsed.success, true, "expected valid v2.1.0 fixture to pass SarifLogSchema");
});

test("schema-validation: v2.2.0 invalid fixture is rejected", async () => {
  const log = await loadJson(join(FIXTURES, "v2.2.0-invalid.sarif.json"));
  const parsed = SarifLogSchema.safeParse(log);
  assert.equal(parsed.success, false, "version != '2.1.0' MUST be rejected");
});

test("schema-validation: GHAS dedup contract — partialFingerprints survives round-trip", async () => {
  const log = await loadJson(join(FIXTURES, "v2.1.0-valid.sarif.json"));
  const parsed = SarifLogSchema.parse(log);
  const first = parsed.runs[0]?.results?.[0];
  assert.ok(first, "expected at least one result in the valid fixture");
  assert.equal(
    first.partialFingerprints?.["primaryLocationLineHash"],
    "6f0a91bbf8a4c2cd",
    "primaryLocationLineHash MUST survive parse byte-identical (GHAS dedup key)",
  );
});

test("schema-validation: passthrough preserves tool.driver.informationUri", async () => {
  const log = await loadJson(join(FIXTURES, "v2.1.0-valid.sarif.json"));
  const parsed = SarifLogSchema.parse(log);
  const driver = parsed.runs[0]?.tool.driver as unknown as { informationUri?: string };
  assert.equal(driver.informationUri, "https://semgrep.dev");
});
