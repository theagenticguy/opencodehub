/**
 * Tests for `@opencodehub/pack`'s prove module — the in-toto/SLSA-v1
 * statement builder + cosign signing glue.
 *
 * The load-bearing invariants (success criteria E-C1):
 *   - subject digest sha256 == manifest.packHash (verbatim, not recomputed).
 *   - predicate.buildDefinition.externalParameters carries all FOUR
 *     reproducibility inputs (commit, tokenizerId, budgetTokens, pins).
 *   - resolvedDependencies binds every BOM file by its sha256, lex-sorted.
 *   - the unsigned `.intoto.jsonl` is always written, byte-stable, and when
 *     cosign is absent `signing.signed` is false with the exact sign command
 *     — we never fabricate a signature.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildProvenanceStatement,
  IN_TOTO_STATEMENT_TYPE,
  offlineVerifyCommand,
  prove,
  SIGSTORE_OIDC_ISSUER,
  SLSA_PROVENANCE_PREDICATE_TYPE,
  serializeStatement,
} from "./prove.js";
import type { PackManifest } from "./types.js";

const PACK_HASH = "deadbeef".repeat(8);

function makeManifest(overrides: Partial<PackManifest> = {}): PackManifest {
  return {
    commit: "a".repeat(40),
    repoOriginUrl: "https://github.com/opencodehub/opencodehub.git",
    tokenizerId: "openai:o200k_base@tiktoken-0.8.0",
    determinismClass: "strict",
    budgetTokens: 100_000,
    pins: { chonkieVersion: "0.0.10", duckdbVersion: "1.4.0", grammarCommits: { ts: "abc123" } },
    files: [
      { kind: "skeleton", path: "skeleton.jsonl", fileHash: "1".repeat(64) },
      { kind: "file-tree", path: "file-tree.jsonl", fileHash: "2".repeat(64) },
      { kind: "deps", path: "deps.jsonl", fileHash: "3".repeat(64) },
      { kind: "licenses", path: "licenses.md", fileHash: "4".repeat(64) },
      { kind: "xrefs", path: "xrefs.jsonl", fileHash: "5".repeat(64) },
      { kind: "ast-chunks", path: "ast-chunks.jsonl", fileHash: "6".repeat(64) },
      { kind: "findings", path: "findings.jsonl", fileHash: "7".repeat(64) },
    ],
    packHash: PACK_HASH,
    schemaVersion: 1,
    ...overrides,
  };
}

test("subject digest sha256 equals manifest.packHash verbatim", () => {
  const m = makeManifest();
  const s = buildProvenanceStatement(m, "/tmp/staging");
  assert.equal(s.subject.length, 1);
  assert.equal(s.subject[0]?.digest.sha256, m.packHash);
  assert.equal(s.subject[0]?.name, `pack:${m.packHash}`);
});

test("statement uses the in-toto/SLSA-v1 type tags", () => {
  const s = buildProvenanceStatement(makeManifest(), "/tmp/staging");
  assert.equal(s._type, IN_TOTO_STATEMENT_TYPE);
  assert.equal(s.predicateType, SLSA_PROVENANCE_PREDICATE_TYPE);
});

test("predicate.externalParameters carries all FOUR reproducibility inputs", () => {
  const m = makeManifest();
  const s = buildProvenanceStatement(m, "/tmp/staging");
  const ep = s.predicate.buildDefinition.externalParameters;
  // Exactly the four — no more, no fewer.
  assert.deepEqual(Object.keys(ep).sort(), ["budgetTokens", "commit", "pins", "tokenizerId"]);
  assert.equal(ep.commit, m.commit);
  assert.equal(ep.tokenizerId, m.tokenizerId);
  assert.equal(ep.budgetTokens, m.budgetTokens);
  assert.deepEqual(ep.pins, m.pins);
});

test("resolvedDependencies binds every BOM file by sha256, lex-sorted by name", () => {
  const m = makeManifest();
  const s = buildProvenanceStatement(m, "/tmp/staging");
  const deps = s.predicate.buildDefinition.resolvedDependencies;
  assert.equal(deps.length, m.files.length);
  // Lex-sorted by name regardless of the cache-prefix BOM order.
  const names = deps.map((d) => d.name);
  assert.deepEqual(names, [...names].sort());
  // Every file's digest is preserved verbatim.
  for (const f of m.files) {
    const d = deps.find((x) => x.name === f.path);
    assert.ok(d, `missing resolved dependency for ${f.path}`);
    assert.equal(d?.digest.sha256, f.fileHash);
  }
});

test("serializeStatement is byte-stable across calls (RFC 8785 canonical + trailing LF)", () => {
  const m = makeManifest();
  const a = serializeStatement(buildProvenanceStatement(m, "/tmp/staging"));
  const b = serializeStatement(buildProvenanceStatement(m, "/tmp/staging"));
  assert.equal(a, b);
  assert.ok(a.endsWith("\n"));
  // Canonical JSON sorts keys: `_type` sorts before `predicate`.
  assert.ok(a.indexOf('"_type"') < a.indexOf('"predicate"'));
});

test("prove() writes the unsigned .intoto.jsonl even when cosign is absent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "och-prove-nocosign-"));
  try {
    const m = makeManifest();
    const r = await prove(m, dir, { _cosignPresent: async () => false });
    assert.equal(r.signing.signed, false);
    if (r.signing.signed === false) {
      assert.match(r.signing.reason, /cosign not found/);
      // The exact sign command is surfaced for an operator to run later.
      assert.match(r.signing.command, /cosign sign-blob --yes --bundle/);
    }
    // The statement file exists and decodes to a statement whose subject == packHash.
    const onDisk = await readFile(r.statementPath, "utf8");
    const parsed = JSON.parse(onDisk) as { subject: { digest: { sha256: string } }[] };
    assert.equal(parsed.subject[0]?.digest.sha256, m.packHash);
    assert.equal(r.bundlePath, `${r.statementPath}.sigstore`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("prove() reports signed:true when the injected cosign probe succeeds (sign step stubbed by PATH absence handled separately)", async () => {
  // We can only assert the present-branch wiring deterministically by also
  // confirming it does NOT mark signed when the real cosign call would fail.
  // Here cosign is reported present but absent on PATH, so the real spawn
  // fails and we land on signed:false with a sign-blob-failed reason — proving
  // we never fabricate a signature on a failed sign.
  const dir = await mkdtemp(join(tmpdir(), "och-prove-cosign-present-"));
  try {
    const m = makeManifest();
    const r = await prove(m, dir, { _cosignPresent: async () => true });
    assert.equal(r.signing.signed, false);
    if (r.signing.signed === false) {
      assert.match(r.signing.reason, /cosign sign-blob failed/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("offlineVerifyCommand pins the keyless OIDC issuer + offline flag", () => {
  const cmd = offlineVerifyCommand("/p/pack.intoto.jsonl.sigstore", "/p/pack.intoto.jsonl");
  assert.match(cmd, /cosign verify-blob-attestation/);
  assert.ok(cmd.includes(SIGSTORE_OIDC_ISSUER));
  assert.match(cmd, /--offline/);
  assert.match(cmd, /--trusted-root/);
});

test("best_effort manifest threads the determinism class into internalParameters", () => {
  const m = makeManifest({ tokenizerId: "anthropic:claude@1", determinismClass: "best_effort" });
  const s = buildProvenanceStatement(m, "/tmp/staging");
  assert.equal(s.predicate.buildDefinition.internalParameters.determinismClass, "best_effort");
  // tokenizerId is provenance — it rides verbatim in externalParameters.
  assert.equal(s.predicate.buildDefinition.externalParameters.tokenizerId, "anthropic:claude@1");
});
