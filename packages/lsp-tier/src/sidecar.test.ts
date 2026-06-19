/**
 * Unit tests for the Tier-3 sidecar writer + the per-server license audit
 * (AC-A5). No live LSP spawn — fixtures only.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LspTierFact } from "./provenance.js";
import { auditWrappedServerLicenses, LSP_SERVER_REGISTRY } from "./servers.js";
import {
  serializeTier3Sidecar,
  TIER3_SIDECAR_FILENAME,
  TIER3_SIDECAR_SCHEMA_VERSION,
  writeTier3Sidecar,
} from "./sidecar.js";

const FACTS: readonly LspTierFact[] = [
  { source: "lsp", server: "zls@0.13.0", symbol: "main", edges: ["std.debug.print"] },
];

test("serializeTier3Sidecar emits a tier=lsp envelope with schema version", () => {
  const json = JSON.parse(serializeTier3Sidecar(FACTS)) as {
    schema_version: number;
    tier: string;
    facts: readonly LspTierFact[];
  };
  assert.equal(json.tier, "lsp");
  assert.equal(json.schema_version, TIER3_SIDECAR_SCHEMA_VERSION);
  assert.equal(json.facts.length, 1);
  assert.equal(json.facts[0]?.source, "lsp");
});

test("writeTier3Sidecar writes lsp-tier.sidecar.json (NOT manifest.json)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lsp-tier-sidecar-"));
  try {
    const path = await writeTier3Sidecar(FACTS, dir);
    assert.ok(path.endsWith(TIER3_SIDECAR_FILENAME));
    assert.notEqual(TIER3_SIDECAR_FILENAME, "manifest.json");
    const bytes = await readFile(path, "utf8");
    assert.ok(bytes.includes('"tier":"lsp"'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("serializeTier3Sidecar re-canonicalizes defensively (idempotent ordering)", () => {
  const shuffled: readonly LspTierFact[] = [
    { source: "lsp", server: "zls@0.13.0", symbol: "b", edges: ["y", "x"] },
    { source: "lsp", server: "zls@0.13.0", symbol: "a", edges: ["n", "m"] },
  ];
  const a = serializeTier3Sidecar(shuffled);
  const b = serializeTier3Sidecar([shuffled[1], shuffled[0]] as LspTierFact[]);
  assert.equal(a, b);
});

// ---- AC-A5: per-wrapped-server license audit ----------------------------

test("AC-A5: every registered server is audited individually", () => {
  const audits = auditWrappedServerLicenses();
  assert.equal(audits.length, Object.keys(LSP_SERVER_REGISTRY).length);
  // One verdict per registry binary, no merging.
  const binaries = new Set(audits.map((a) => a.binary));
  for (const pin of Object.values(LSP_SERVER_REGISTRY)) {
    assert.ok(binaries.has(pin.binary), `${pin.binary} must have its own audit verdict`);
  }
});

test("AC-A5: EPL/MPL servers are SUBPROCESS-ONLY, permissive servers are OK; none BLOCK", () => {
  const audits = auditWrappedServerLicenses();
  for (const a of audits) {
    if (a.license === "EPL-2.0" || a.license === "MPL-2.0") {
      assert.equal(a.tier, "SUBPROCESS-ONLY", `${a.binary} (${a.license}) must be subprocess-only`);
      assert.equal(a.subprocessOnly, true);
    } else {
      assert.equal(a.tier, "OK", `${a.binary} (${a.license}) is permissive`);
      assert.equal(a.subprocessOnly, false);
    }
    // Critically: no verdict is "BLOCK" — every server is detect-on-PATH and
    // never bundled/linked, so even MPL is permissible as a subprocess.
    assert.notEqual(a.tier as string, "BLOCK");
  }
});

test("AC-A5: terraform-ls (MPL) is correctly flagged subprocess-only", () => {
  const audits = auditWrappedServerLicenses();
  const tf = audits.find((a) => a.binary === "terraform-ls");
  assert.ok(tf, "terraform-ls must be audited");
  assert.equal(tf?.license, "MPL-2.0");
  assert.equal(tf?.tier, "SUBPROCESS-ONLY");
});
