/**
 * Tests for the in-toto context attestation builder.
 *
 * Covers:
 *   A. Exact in-toto Statement v1 envelope: `_type` literal, single subject
 *      with `{ sha256: <packHash> }` digest, minted predicateType.
 *   B. Predicate carries the expected context-provenance fields from the
 *      manifest.
 *   C. bomItems are sorted by path ASC and project {path, kind, fileHash}.
 *   D. Determinism: two builds from the same manifest serialize byte-identically
 *      (no clock / UUID / run-id).
 *   E. serializeAttestation round-trips to the same Statement shape.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildContextAttestation,
  CONTEXT_ATTESTATION_PREDICATE_TYPE,
  CONTEXT_ATTESTATION_SUBJECT_NAME,
  IN_TOTO_STATEMENT_TYPE,
  serializeAttestation,
} from "./attestation.js";
import type { PackManifest } from "./types.js";

function fixtureManifest(overrides: Partial<PackManifest> = {}): PackManifest {
  return {
    commit: "0".repeat(40),
    repoOriginUrl: "https://github.com/example/repo",
    tokenizerId: "openai:o200k_base@tiktoken-0.8.0",
    determinismClass: "strict",
    budgetTokens: 100_000,
    pins: { chonkieVersion: "0.3.0", grammarCommits: { python: "a".repeat(40) } },
    // Deliberately out of path order so the sort is observable.
    files: [
      { kind: "xrefs", path: "xrefs.jsonl", fileHash: "e".repeat(64) },
      { kind: "skeleton", path: "skeleton.jsonl", fileHash: "c".repeat(64) },
      { kind: "context-bom", path: "context-bom.json", fileHash: "2".repeat(64) },
    ],
    contextBomHash: "3".repeat(64),
    packHash: "deadbeef".repeat(8),
    schemaVersion: 2,
    ...overrides,
  };
}

test("A. Statement has the exact in-toto v1 `_type` literal", () => {
  const stmt = buildContextAttestation(fixtureManifest());
  assert.equal(stmt._type, "https://in-toto.io/Statement/v1");
  assert.equal(stmt._type, IN_TOTO_STATEMENT_TYPE);
});

test("A. subject is a single entry with digest { sha256: <packHash> }", () => {
  const m = fixtureManifest();
  const stmt = buildContextAttestation(m);
  assert.equal(stmt.subject.length, 1);
  const subj = stmt.subject[0];
  assert.ok(subj !== undefined);
  assert.equal(subj.name, CONTEXT_ATTESTATION_SUBJECT_NAME);
  assert.deepEqual(subj.digest, { sha256: m.packHash });
  // The digest map has exactly one algorithm key.
  assert.deepEqual(Object.keys(subj.digest), ["sha256"]);
});

test("A. predicateType is the minted opencodehub.dev URI at v0.1", () => {
  const stmt = buildContextAttestation(fixtureManifest());
  assert.equal(stmt.predicateType, "https://opencodehub.dev/attestation/context/v0.1");
  assert.equal(stmt.predicateType, CONTEXT_ATTESTATION_PREDICATE_TYPE);
});

test("B. predicate carries the context-provenance fields from the manifest", () => {
  const m = fixtureManifest();
  const { predicate } = buildContextAttestation(m);
  assert.equal(predicate.packHash, m.packHash);
  assert.equal(predicate.contextBomHash, m.contextBomHash);
  assert.equal(predicate.commit, m.commit);
  assert.equal(predicate.repoOriginUrl, m.repoOriginUrl);
  assert.equal(predicate.tokenizerId, m.tokenizerId);
  assert.equal(predicate.budgetTokens, m.budgetTokens);
  assert.equal(predicate.determinismClass, m.determinismClass);
});

test("B. repoOriginUrl null is preserved in the predicate", () => {
  const { predicate } = buildContextAttestation(fixtureManifest({ repoOriginUrl: null }));
  assert.equal(predicate.repoOriginUrl, null);
});

test("C. bomItems are sorted by path ASC and project {path, kind, fileHash}", () => {
  const { predicate } = buildContextAttestation(fixtureManifest());
  const paths = predicate.bomItems.map((i) => i.path);
  assert.deepEqual(paths, ["context-bom.json", "skeleton.jsonl", "xrefs.jsonl"]);
  // Every item projects exactly the three fields, keyed to the source manifest.
  const skeleton = predicate.bomItems.find((i) => i.path === "skeleton.jsonl");
  assert.ok(skeleton !== undefined);
  assert.deepEqual(skeleton, {
    path: "skeleton.jsonl",
    kind: "skeleton",
    fileHash: "c".repeat(64),
  });
});

test("D. two builds from the same manifest serialize byte-identically", () => {
  const m = fixtureManifest();
  const s1 = serializeAttestation(buildContextAttestation(m));
  const s2 = serializeAttestation(buildContextAttestation(m));
  assert.equal(s1, s2);
});

test("D. serialized attestation carries no clock / uuid / run-id fields", () => {
  const s = serializeAttestation(buildContextAttestation(fixtureManifest()));
  for (const forbidden of ["timestamp", "serialNumber", "runId", "run_id", "uuid", "createdAt"]) {
    assert.ok(!s.includes(forbidden), `attestation leaked a non-deterministic field: ${forbidden}`);
  }
});

test("D. a different packHash flips the serialized attestation", () => {
  const base = serializeAttestation(buildContextAttestation(fixtureManifest()));
  const alt = serializeAttestation(
    buildContextAttestation(fixtureManifest({ packHash: "cafebabe".repeat(8) })),
  );
  assert.notEqual(base, alt);
});

test("E. serializeAttestation round-trips to the same Statement shape", () => {
  const stmt = buildContextAttestation(fixtureManifest());
  const parsed = JSON.parse(serializeAttestation(stmt));
  assert.equal(parsed._type, IN_TOTO_STATEMENT_TYPE);
  assert.equal(parsed.predicateType, CONTEXT_ATTESTATION_PREDICATE_TYPE);
  assert.equal(parsed.subject[0].digest.sha256, stmt.subject[0]?.digest.sha256);
  assert.equal(parsed.predicate.packHash, stmt.predicate.packHash);
  assert.deepEqual(
    parsed.predicate.bomItems.map((i: { path: string }) => i.path),
    stmt.predicate.bomItems.map((i) => i.path),
  );
});

test("empty files array still produces a valid Statement with empty bomItems", () => {
  const stmt = buildContextAttestation(fixtureManifest({ files: [] }));
  assert.equal(stmt.predicate.bomItems.length, 0);
  assert.equal(stmt._type, IN_TOTO_STATEMENT_TYPE);
  assert.deepEqual(stmt.subject[0]?.digest, { sha256: "deadbeef".repeat(8) });
});
