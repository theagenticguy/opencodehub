/**
 * Tests for the context read-receipt builder.
 *
 * Covers:
 *   A. Determinism — same files produce byte-identical canonical JSON + hash.
 *   B. Hash sensitivity — any file change flips contextBomHash.
 *   C. Missing contentHash omits the `hashes` array (no fabricated hash).
 *   D. Byte ranges — merged, sorted, non-overlapping; omitted when empty.
 *   E. CycloneDX 1.7 shape — bomFormat/specVersion/components well-formed.
 *   F. Order independence — input order does not affect output (sorted by path).
 *   G. Provenance citation — externalReferences[vcs] + opencodehub:commit
 *      present when (repoOriginUrl, commit) supplied, omitted when absent,
 *      and deterministic.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { sha256Hex } from "@opencodehub/core-types";
import { type ByteSpan, buildContextBom, type ContextFile, mergeSpans } from "./context-bom.js";

const FILE_A: ContextFile = {
  path: "src/a.ts",
  contentHash: "a".repeat(64),
  lineCount: 10,
  language: "typescript",
};
const FILE_B: ContextFile = {
  path: "src/b.ts",
  contentHash: "b".repeat(64),
  lineCount: 20,
  language: "typescript",
};
const FILES: readonly ContextFile[] = [FILE_A, FILE_B];

/** Assert the document has a first component and return it narrowed. */
function firstComponent(r: ReturnType<typeof buildContextBom>) {
  const comp = r.document.components[0];
  assert.ok(comp !== undefined, "expected at least one component");
  return comp;
}

test("A. buildContextBom is deterministic across two runs", () => {
  const r1 = buildContextBom({ files: FILES });
  const r2 = buildContextBom({ files: FILES });
  assert.equal(r1.canonical, r2.canonical);
  assert.equal(r1.contextBomHash, r2.contextBomHash);
});

test("A. contextBomHash is sha256 of the canonical bytes", () => {
  const r = buildContextBom({ files: FILES });
  assert.equal(r.contextBomHash, sha256Hex(r.canonical));
  assert.match(r.contextBomHash, /^[0-9a-f]{64}$/);
});

test("B. changing a file's contentHash flips contextBomHash", () => {
  const base = buildContextBom({ files: FILES });
  const altA: ContextFile = {
    path: "src/a.ts",
    contentHash: "c".repeat(64),
    lineCount: 10,
    language: "typescript",
  };
  const alt = buildContextBom({ files: [altA, FILE_B] });
  assert.notEqual(base.contextBomHash, alt.contextBomHash);
});

test("B. changing a file's lineCount flips contextBomHash", () => {
  const base = buildContextBom({ files: FILES });
  const altA: ContextFile = {
    path: "src/a.ts",
    contentHash: "a".repeat(64),
    lineCount: 11,
    language: "typescript",
  };
  const alt = buildContextBom({ files: [altA, FILE_B] });
  assert.notEqual(base.contextBomHash, alt.contextBomHash);
});

test("C. a file without contentHash omits the hashes array", () => {
  const r = buildContextBom({ files: [{ path: "src/x.ts", lineCount: 3 }] });
  const comp = firstComponent(r);
  assert.equal(comp.name, "src/x.ts");
  assert.equal(comp.hashes, undefined);
});

test("D. byte ranges are merged into sorted non-overlapping spans", () => {
  const ranges = new Map<string, readonly ByteSpan[]>([
    [
      "src/a.ts",
      [
        { start: 10, end: 20 },
        { start: 0, end: 5 },
        { start: 18, end: 30 },
      ],
    ],
  ]);
  const r = buildContextBom({ files: [FILE_A], byteRangesByPath: ranges });
  const prop = firstComponent(r).properties?.find((p) => p.name === "opencodehub:byteRanges");
  assert.ok(prop !== undefined, "byteRanges property should be present");
  assert.equal(prop?.value, "[[0,5],[10,30]]");
});

test("D. no byte ranges → byteRanges property omitted", () => {
  const r = buildContextBom({ files: [FILE_A] });
  const prop = firstComponent(r).properties?.find((p) => p.name === "opencodehub:byteRanges");
  assert.equal(prop, undefined);
});

test("E. document is a well-formed CycloneDX 1.7 BOM", () => {
  const r = buildContextBom({ files: FILES });
  assert.equal(r.document.bomFormat, "CycloneDX");
  assert.equal(r.document.specVersion, "1.7");
  assert.equal(r.document.$schema, "http://cyclonedx.org/schema/bom-1.7.schema.json");
  assert.equal(r.document.version, 1);
  for (const c of r.document.components) {
    assert.equal(c.type, "file");
    assert.ok(typeof c.name === "string" && c.name.length > 0);
    for (const h of c.hashes ?? []) {
      assert.equal(h.alg, "SHA-256");
      assert.match(h.content, /^[0-9a-f]{64}$/);
    }
    for (const p of c.properties ?? []) {
      assert.equal(typeof p.name, "string");
      assert.equal(typeof p.value, "string");
    }
  }
});

test("E. empty file set still produces a valid (empty) receipt", () => {
  const r = buildContextBom({ files: [] });
  assert.equal(r.document.bomFormat, "CycloneDX");
  assert.deepEqual(r.document.components, []);
  assert.match(r.contextBomHash, /^[0-9a-f]{64}$/);
});

test("F. input order does not affect output (components sorted by path)", () => {
  const forward = buildContextBom({ files: [FILE_A, FILE_B] });
  const reverse = buildContextBom({ files: [FILE_B, FILE_A] });
  assert.equal(forward.canonical, reverse.canonical);
  assert.deepEqual(
    forward.document.components.map((c) => c.name),
    ["src/a.ts", "src/b.ts"],
  );
});

const ORIGIN = "https://github.com/org/repo";
const COMMIT = "c".repeat(40);

test("G. provenance citation appears on each component when commit+originUrl supplied", () => {
  const r = buildContextBom({ files: FILES, commit: COMMIT, repoOriginUrl: ORIGIN });
  assert.ok(r.document.components.length > 0, "expected components");
  for (const c of r.document.components) {
    assert.deepEqual(c.externalReferences, [{ type: "vcs", url: ORIGIN }]);
    const commitProp = c.properties?.find((p) => p.name === "opencodehub:commit");
    assert.ok(commitProp !== undefined, "opencodehub:commit property should be present");
    assert.equal(commitProp?.value, COMMIT);
  }
});

test("G. provenance citation is omitted when commit+originUrl are absent", () => {
  const r = buildContextBom({ files: FILES });
  for (const c of r.document.components) {
    assert.equal(c.externalReferences, undefined);
    const commitProp = c.properties?.find((p) => p.name === "opencodehub:commit");
    assert.equal(commitProp, undefined);
  }
});

test("G. null repoOriginUrl omits externalReferences; empty commit omits the property", () => {
  const r = buildContextBom({ files: FILES, commit: "", repoOriginUrl: null });
  for (const c of r.document.components) {
    assert.equal(c.externalReferences, undefined);
    const commitProp = c.properties?.find((p) => p.name === "opencodehub:commit");
    assert.equal(commitProp, undefined);
  }
});

test("G. commit-only (no origin) records the property but omits externalReferences", () => {
  const r = buildContextBom({ files: FILES, commit: COMMIT });
  for (const c of r.document.components) {
    assert.equal(c.externalReferences, undefined);
    const commitProp = c.properties?.find((p) => p.name === "opencodehub:commit");
    assert.equal(commitProp?.value, COMMIT);
  }
});

test("G. provenance is deterministic and does not disturb component sort order", () => {
  const forward = buildContextBom({
    files: [FILE_A, FILE_B],
    commit: COMMIT,
    repoOriginUrl: ORIGIN,
  });
  const reverse = buildContextBom({
    files: [FILE_B, FILE_A],
    commit: COMMIT,
    repoOriginUrl: ORIGIN,
  });
  assert.equal(forward.canonical, reverse.canonical);
  assert.equal(forward.contextBomHash, reverse.contextBomHash);
  assert.deepEqual(
    forward.document.components.map((c) => c.name),
    ["src/a.ts", "src/b.ts"],
  );
});

test("G. adding a provenance citation flips contextBomHash (it is in the preimage)", () => {
  const plain = buildContextBom({ files: FILES });
  const cited = buildContextBom({ files: FILES, commit: COMMIT, repoOriginUrl: ORIGIN });
  assert.notEqual(plain.contextBomHash, cited.contextBomHash);
});

test("mergeSpans drops zero-length and inverted spans", () => {
  assert.deepEqual(mergeSpans([{ start: 5, end: 5 }]), []);
  assert.deepEqual(mergeSpans([{ start: 9, end: 3 }]), []);
  assert.deepEqual(
    mergeSpans([
      { start: 0, end: 4 },
      { start: 4, end: 8 },
    ]),
    [{ start: 0, end: 8 }],
  );
});
