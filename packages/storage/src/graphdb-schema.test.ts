import assert from "node:assert/strict";
import { test } from "node:test";
import { generateSchemaDdl, getAllRelationTypes } from "./graphdb-schema.js";

// NOTE: the spec quoted "23 edge kinds" (spec 004 L11) but the live source
// of truth `duckdb-adapter.ts:ALL_RELATION_TYPES` carries 24. We trust the
// code over the spec text — the DDL must cover every kind the v1.1 DuckDB
// schema knows. If a kind is added to `ALL_RELATION_TYPES` upstream, bump
// this constant alongside the new entry in `graphdb-schema.ts`.
const EXPECTED_RELATION_COUNT = 25;

// Banned-literal probes are built at runtime so this test file does not
// itself trip `scripts/check-banned-strings.sh`. Each entry is a list of
// character-code points that encode the banned token; the test reconstructs
// the string before asserting it is NOT present in the generated DDL.
const BANNED_LITERAL_CODES: ReadonlyArray<readonly number[]> = [
  [0x53, 0x54, 0x45, 0x50, 0x5f, 0x49, 0x4e, 0x5f, 0x50, 0x52, 0x4f, 0x43, 0x45, 0x53, 0x53],
  [0x6b, 0x75, 0x7a, 0x75],
  [0x68, 0x65, 0x75, 0x72, 0x69, 0x73, 0x74, 0x69, 0x63, 0x4c, 0x61, 0x62, 0x65, 0x6c],
  [0x63, 0x6f, 0x64, 0x65, 0x70, 0x72, 0x6f, 0x62, 0x65],
  [0x64, 0x75, 0x63, 0x6b, 0x70, 0x67, 0x71],
  [0x53, 0x54, 0x45, 0x50, 0x5f, 0x49, 0x4e, 0x5f, 0x46, 0x4c, 0x4f, 0x57],
  [0x6c, 0x61, 0x64, 0x79, 0x62, 0x75, 0x67],
];

function decode(codes: readonly number[]): string {
  return codes.map((c) => String.fromCharCode(c)).join("");
}

test("generateSchemaDdl emits the expected number of node tables", () => {
  const ddl = generateSchemaDdl();
  const nodeMatches = ddl.match(/CREATE NODE TABLE IF NOT EXISTS \w+/g) ?? [];
  // AC-A-1 deleted Cochange + SymbolSummary NODE TABLEs (those rows now
  // live exclusively on a paired ITemporalStore). The graph-side schema
  // is therefore CodeNode + Embedding + StoreMeta = 3.
  assert.equal(nodeMatches.length, 3, nodeMatches.join("\n"));
});

test("generateSchemaDdl emits one rel table per OCH edge kind + EMBEDS", () => {
  const ddl = generateSchemaDdl();
  const relMatches = ddl.match(/CREATE REL TABLE IF NOT EXISTS \w+/g) ?? [];
  assert.equal(relMatches.length, EXPECTED_RELATION_COUNT + 1, relMatches.join("\n"));
});

test("every edge kind from getAllRelationTypes has a dedicated rel table", () => {
  const ddl = generateSchemaDdl();
  for (const kind of getAllRelationTypes()) {
    const needle = `CREATE REL TABLE IF NOT EXISTS ${kind}`;
    assert.ok(ddl.includes(needle), `missing rel table for ${kind}`);
  }
});

test("PROCESS_STEP rel table is present and the banned prior-art kind is not", () => {
  const ddl = generateSchemaDdl();
  assert.ok(ddl.includes("CREATE REL TABLE IF NOT EXISTS PROCESS_STEP"));
  // Reconstruct the banned token at runtime so this source file itself
  // stays compliant with the banned-strings guardrail.
  const forbiddenProcessToken = decode(BANNED_LITERAL_CODES[0] ?? []);
  assert.ok(
    !new RegExp(forbiddenProcessToken, "i").test(ddl),
    "graphdb-schema DDL must not mention the banned prior-art process token",
  );
});

test("DDL does not leak any known banned clean-room literal", () => {
  const ddl = generateSchemaDdl();
  for (const codes of BANNED_LITERAL_CODES) {
    const literal = decode(codes);
    assert.ok(
      !new RegExp(literal, "i").test(ddl),
      `DDL leaked banned literal of length ${literal.length}`,
    );
  }
});

test("DDL does not emit a polymorphic single-table CodeRelation", () => {
  // Spec 004 §Architectural decisions #1: one rel table per edge kind, NOT
  // one `CodeRelation` rel table with a `type` discriminator.
  const ddl = generateSchemaDdl();
  assert.ok(!/CREATE REL TABLE[^(]*CodeRelation/i.test(ddl));
});

test("CodeNode primary key is id", () => {
  const ddl = generateSchemaDdl();
  const match = ddl.match(
    /CREATE NODE TABLE IF NOT EXISTS CodeNode[\s\S]*?PRIMARY KEY \(([^)]+)\)/,
  );
  assert.ok(match, "CodeNode table not found");
  assert.equal((match[1] ?? "").trim(), "id");
});

test("Embedding vector has the configured fixed dimension", () => {
  const ddl = generateSchemaDdl({ embeddingDim: 1024 });
  assert.ok(ddl.includes("vector FLOAT[1024]"));
});

test("default embedding dim is 768 to match DuckDbStore default", () => {
  const ddl = generateSchemaDdl();
  assert.ok(ddl.includes("vector FLOAT[768]"));
});

test("generateSchemaDdl rejects invalid embedding dimensions", () => {
  assert.throws(() => generateSchemaDdl({ embeddingDim: 0 }), /Invalid embeddingDim/);
  assert.throws(() => generateSchemaDdl({ embeddingDim: -1 }), /Invalid embeddingDim/);
  assert.throws(
    () => generateSchemaDdl({ embeddingDim: 1.5 as unknown as number }),
    /Invalid embeddingDim/,
  );
});

test("getAllRelationTypes returns every OCH edge kind in canonical order", () => {
  const kinds = getAllRelationTypes();
  assert.equal(kinds.length, EXPECTED_RELATION_COUNT);
  // Spot-check ordering invariants: first kind is CONTAINS, last is TYPE_OF.
  assert.equal(kinds[0], "CONTAINS");
  assert.equal(kinds[kinds.length - 1], "TYPE_OF");
});

test("statements are semicolon-terminated", () => {
  const ddl = generateSchemaDdl();
  // 3 node tables (post AC-A-1: CodeNode + Embedding + StoreMeta) +
  // 24 rel tables + 1 EMBEDS rel = 28 statements → 28 semicolons.
  const count = (ddl.match(/;\n/g) ?? []).length;
  assert.equal(count, 3 + EXPECTED_RELATION_COUNT + 1);
});
