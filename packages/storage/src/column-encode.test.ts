/**
 * Unit tests for `./column-encode.ts` — every encoder and every sentinel.
 *
 * These tests pin the helper-level contracts so a future edit to
 * `column-encode.ts` cannot silently change behaviour without tripping
 * a focused failure here. The cross-adapter round-trip is covered by
 * `graph-hash-parity.test.ts`; this file owns the unit-level shape.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type GraphNode, makeNodeId } from "@opencodehub/core-types";
import {
  applyRepoNullables,
  booleanOrNull,
  coerceLanguageStats,
  coveredLinesOrNull,
  dedupeLastById,
  frameworksJsonOrNull,
  jsonArrayOrNull,
  jsonObjectOrNull,
  languageStatsJsonOrNull,
  NODE_COLUMNS,
  nodeToColumns,
  normalizeDeadness,
  numberOrNull,
  repoStringOrNull,
  stepZeroSentinel,
  stringArrayOrNull,
  stringOrNull,
} from "./column-encode.js";

// ---------------------------------------------------------------------------
// NODE_COLUMNS shape
// ---------------------------------------------------------------------------

test("NODE_COLUMNS: 73 entries with id first and language_stats_json last", () => {
  assert.equal(NODE_COLUMNS.length, 73);
  assert.equal(NODE_COLUMNS[0], "id");
  assert.equal(NODE_COLUMNS[NODE_COLUMNS.length - 1], "language_stats_json");
});

test("NODE_COLUMNS: every entry is unique", () => {
  const seen = new Set<string>();
  for (const col of NODE_COLUMNS) {
    assert.ok(!seen.has(col), `duplicate column: ${col}`);
    seen.add(col);
  }
});

// ---------------------------------------------------------------------------
// numberOrNull / stringOrNull / booleanOrNull
// ---------------------------------------------------------------------------

test("numberOrNull: finite numbers pass through; NaN/Infinity/non-number → null", () => {
  assert.equal(numberOrNull(0), 0);
  assert.equal(numberOrNull(42), 42);
  assert.equal(numberOrNull(-1.5), -1.5);
  assert.equal(numberOrNull(Number.NaN), null);
  assert.equal(numberOrNull(Number.POSITIVE_INFINITY), null);
  assert.equal(numberOrNull("42"), null);
  assert.equal(numberOrNull(null), null);
  assert.equal(numberOrNull(undefined), null);
});

test("stringOrNull: non-empty strings pass through; empty string and non-strings → null", () => {
  assert.equal(stringOrNull("hello"), "hello");
  assert.equal(stringOrNull(""), null);
  assert.equal(stringOrNull(0), null);
  assert.equal(stringOrNull(null), null);
  assert.equal(stringOrNull(undefined), null);
});

test("booleanOrNull: booleans pass through; everything else → null", () => {
  assert.equal(booleanOrNull(true), true);
  assert.equal(booleanOrNull(false), false);
  assert.equal(booleanOrNull(0), null);
  assert.equal(booleanOrNull("true"), null);
  assert.equal(booleanOrNull(null), null);
  assert.equal(booleanOrNull(undefined), null);
});

// ---------------------------------------------------------------------------
// stringArrayOrNull
// ---------------------------------------------------------------------------

test("stringArrayOrNull: preserves [] vs absent for round-trip symmetry", () => {
  assert.deepEqual(stringArrayOrNull(["a", "b"]), ["a", "b"]);
  // Explicit empty array survives the writer side as a typed 0-length
  // array (NOT null) so the native TEXT[] / STRING[] column can
  // distinguish `keywords: []` from absent. The symmetric reader is in
  // duckdb-adapter.ts:setStringArrayField + analyze.ts:stringArrayField.
  assert.deepEqual(stringArrayOrNull([]), []);
  assert.equal(stringArrayOrNull("a"), null);
  assert.equal(stringArrayOrNull(null), null);
  assert.equal(stringArrayOrNull(undefined), null);
  // Non-string elements are filtered silently; mixed arrays keep the strings.
  assert.deepEqual(stringArrayOrNull(["a", 1, null, "b"]), ["a", "b"]);
  // Filtering out every element yields an empty array — NOT null. The
  // input was an array (= author intent: collection), just one whose
  // elements all violated the contract. The reader will rebuild this as
  // `[]` rather than dropping the field entirely; that's intentional —
  // it preserves the array-vs-absent signal even after element coercion.
  assert.deepEqual(stringArrayOrNull([1, null, undefined]), []);
});

// ---------------------------------------------------------------------------
// jsonArrayOrNull / jsonObjectOrNull
// ---------------------------------------------------------------------------

test("jsonArrayOrNull: arrays serialize via JSON.stringify; pre-encoded strings pass through", () => {
  assert.equal(jsonArrayOrNull(["a", "b"]), '["a","b"]');
  assert.equal(jsonArrayOrNull([1, 2, 3]), "[1,2,3]");
  assert.equal(jsonArrayOrNull('["already"]'), '["already"]');
  assert.equal(jsonArrayOrNull(null), null);
  assert.equal(jsonArrayOrNull(undefined), null);
  assert.equal(jsonArrayOrNull({}), null);
});

test("jsonObjectOrNull: records serialize via JSON.stringify; arrays + non-objects → null", () => {
  assert.equal(jsonObjectOrNull({ a: 1 }), '{"a":1}');
  assert.equal(jsonObjectOrNull('{"a":1}'), '{"a":1}');
  assert.equal(jsonObjectOrNull([1, 2]), null);
  assert.equal(jsonObjectOrNull(null), null);
  assert.equal(jsonObjectOrNull(undefined), null);
  assert.equal(jsonObjectOrNull(42), null);
});

// ---------------------------------------------------------------------------
// coveredLinesOrNull
// ---------------------------------------------------------------------------

test("coveredLinesOrNull: prefer the pre-encoded string when present", () => {
  assert.equal(coveredLinesOrNull([1, 2, 3], "[10,20]"), "[10,20]");
  assert.equal(coveredLinesOrNull([1, 2, 3], ""), "[1,2,3]");
  assert.equal(coveredLinesOrNull([1, 2, 3], undefined), "[1,2,3]");
  assert.equal(coveredLinesOrNull(null, null), null);
  assert.equal(coveredLinesOrNull(undefined, undefined), null);
});

// ---------------------------------------------------------------------------
// repoStringOrNull / languageStatsJsonOrNull
// ---------------------------------------------------------------------------

test("repoStringOrNull: explicit null and absent both collapse to null", () => {
  assert.equal(repoStringOrNull({ originUrl: "https://x" }, "originUrl"), "https://x");
  assert.equal(repoStringOrNull({ originUrl: null }, "originUrl"), null);
  assert.equal(repoStringOrNull({ originUrl: "" }, "originUrl"), null);
  assert.equal(repoStringOrNull({}, "originUrl"), null);
});

test("languageStatsJsonOrNull: byte-stable canonical JSON with sorted keys", () => {
  // canonicalJson sorts object keys deterministically.
  assert.equal(
    languageStatsJsonOrNull({ ts: 0.83, py: 0.14, md: 0.03 }),
    '{"md":0.03,"py":0.14,"ts":0.83}',
  );
  // Empty object collapses to null (the empty-stats sentinel).
  assert.equal(languageStatsJsonOrNull({}), null);
  assert.equal(languageStatsJsonOrNull(null), null);
  assert.equal(languageStatsJsonOrNull(undefined), null);
  assert.equal(languageStatsJsonOrNull("not-an-object"), null);
  assert.equal(languageStatsJsonOrNull([1, 2]), null);
});

// ---------------------------------------------------------------------------
// normalizeDeadness
// ---------------------------------------------------------------------------

test("normalizeDeadness: hyphenated unreachable-export → underscored", () => {
  assert.equal(normalizeDeadness("unreachable-export"), "unreachable_export");
  assert.equal(normalizeDeadness("live"), "live");
  assert.equal(normalizeDeadness("dead"), "dead");
  assert.equal(normalizeDeadness(undefined), undefined);
});

// ---------------------------------------------------------------------------
// frameworksJsonOrNull — polymorphic v1.0 / v2.0 shape
// ---------------------------------------------------------------------------

test("frameworksJsonOrNull: legacy flat shape when frameworksDetected is absent/empty", () => {
  assert.equal(frameworksJsonOrNull(["react"], undefined), '["react"]');
  assert.equal(frameworksJsonOrNull(["react"], []), '["react"]');
  // Explicit empty array still serializes to "[]" so a ProjectProfile node
  // that genuinely declares `frameworks: []` round-trips byte-for-byte.
  assert.equal(frameworksJsonOrNull([], undefined), "[]");
});

test("frameworksJsonOrNull: returns null when both flat and detected are absent", () => {
  // Nodes that never declared `frameworks` (every kind except
  // ProjectProfile in practice) must store SQL NULL — otherwise the
  // public-interface parity rebuilder re-attaches a spurious
  // `frameworks: []` field and graphHash byte-identity breaks across the
  // round-trip.
  assert.equal(frameworksJsonOrNull(undefined, undefined), null);
  assert.equal(frameworksJsonOrNull(undefined, []), null);
  assert.equal(frameworksJsonOrNull(null, undefined), null);
});

test("frameworksJsonOrNull: v2.0 envelope when frameworksDetected is non-empty", () => {
  const detected = [{ name: "react", version: "18" }];
  assert.equal(
    frameworksJsonOrNull(["react"], detected),
    '{"flat":["react"],"detected":[{"name":"react","version":"18"}]}',
  );
});

test("frameworksJsonOrNull: non-string entries in flat are filtered", () => {
  assert.equal(frameworksJsonOrNull(["react", 1, null], undefined), '["react"]');
});

// ---------------------------------------------------------------------------
// dedupeLastById
// ---------------------------------------------------------------------------

test("dedupeLastById: keeps the LAST value at first-seen position per id", () => {
  // Map insertion order pins each id at its first appearance; subsequent
  // duplicates overwrite the value but not the slot. The output is
  // first-seen order × last-written value — matches the existing
  // behaviour of both adapters' local helpers before the hoist.
  const items = [
    { id: "a", v: 1 },
    { id: "b", v: 2 },
    { id: "a", v: 3 },
    { id: "c", v: 4 },
    { id: "b", v: 5 },
  ];
  assert.deepEqual(
    dedupeLastById(items, (x) => x.id),
    [
      { id: "a", v: 3 },
      { id: "b", v: 5 },
      { id: "c", v: 4 },
    ],
  );
  assert.deepEqual(
    dedupeLastById([], (x: { id: string }) => x.id),
    [],
  );
});

// ---------------------------------------------------------------------------
// nodeToColumns — covers shape + a few representative slots
// ---------------------------------------------------------------------------

test("nodeToColumns: emits every NODE_COLUMNS key", () => {
  const id = makeNodeId("File", "src/x.ts", "x.ts");
  const node: GraphNode = {
    id,
    kind: "File",
    name: "x.ts",
    filePath: "src/x.ts",
  };
  const cols = nodeToColumns(node);
  for (const key of NODE_COLUMNS) {
    assert.ok(key in cols, `missing column: ${key}`);
  }
  assert.equal(Object.keys(cols).length, NODE_COLUMNS.length);
});

test("nodeToColumns: Operation maps method/path to http_method/http_path", () => {
  const id = makeNodeId("Operation", "openapi.yaml", "GET /users");
  const cols = nodeToColumns({
    id,
    kind: "Operation",
    name: "GET /users",
    filePath: "openapi.yaml",
    method: "GET",
    path: "/users",
  } as unknown as GraphNode);
  assert.equal(cols["http_method"], "GET");
  assert.equal(cols["http_path"], "/users");
  // The plain `method` slot stays NULL for Operation rows so RouteNode
  // semantics are not crossed.
  assert.equal(cols["method"], null);
});

test("nodeToColumns: deadness is normalized on write", () => {
  const id = makeNodeId("Function", "src/x.ts", "f");
  const cols = nodeToColumns({
    id,
    kind: "Function",
    name: "f",
    filePath: "src/x.ts",
    deadness: "unreachable-export",
  } as unknown as GraphNode);
  assert.equal(cols["deadness"], "unreachable_export");
});

test("nodeToColumns: Repo nullable fields collapse to null on write", () => {
  const id = makeNodeId("Repo", "", "repo");
  const cols = nodeToColumns({
    id,
    kind: "Repo",
    name: "github.com/acme/x",
    filePath: "",
    originUrl: null,
    defaultBranch: null,
    group: null,
    languageStats: {},
  } as unknown as GraphNode);
  assert.equal(cols["origin_url"], null);
  assert.equal(cols["default_branch"], null);
  assert.equal(cols["repo_group"], null);
  // Empty languageStats also collapses to NULL on write — the read-side
  // applyRepoNullables re-adds {} via coerceLanguageStats.
  assert.equal(cols["language_stats_json"], null);
});

// ---------------------------------------------------------------------------
// Sentinels: stepZeroSentinel
// ---------------------------------------------------------------------------

test("stepZeroSentinel: drops 0 / null / undefined; passes through positive integers", () => {
  assert.equal(stepZeroSentinel(0), undefined);
  assert.equal(stepZeroSentinel(null), undefined);
  assert.equal(stepZeroSentinel(undefined), undefined);
  assert.equal(stepZeroSentinel(1), 1);
  assert.equal(stepZeroSentinel(42), 42);
  // Non-finite collapses to undefined so corrupt rows don't leak NaN.
  assert.equal(stepZeroSentinel(Number.NaN), undefined);
  assert.equal(stepZeroSentinel(Number.POSITIVE_INFINITY), undefined);
});

// ---------------------------------------------------------------------------
// Sentinels: coerceLanguageStats
// ---------------------------------------------------------------------------

test("coerceLanguageStats: parse string / coerce empty / drop garbage", () => {
  assert.deepEqual(coerceLanguageStats('{"ts":0.83,"py":0.14}'), { ts: 0.83, py: 0.14 });
  // Empty string sentinel — the writer collapsed an empty stats object to
  // SQL NULL, which DuckDB reads back as null and the graph-db reads as
  // null/undefined depending on the binding; all paths converge to {}.
  assert.deepEqual(coerceLanguageStats(null), {});
  assert.deepEqual(coerceLanguageStats(undefined), {});
  assert.deepEqual(coerceLanguageStats(""), {});
  // Non-finite values get filtered silently.
  assert.deepEqual(coerceLanguageStats('{"ts":"nope","py":0.14}'), { py: 0.14 });
  // Malformed JSON falls through to {}.
  assert.deepEqual(coerceLanguageStats("{not-json"), {});
  // Arrays / non-objects → {}.
  assert.deepEqual(coerceLanguageStats("[1,2,3]"), {});
});

// ---------------------------------------------------------------------------
// Sentinels: applyRepoNullables
// ---------------------------------------------------------------------------

test("applyRepoNullables: re-attaches null fields and languageStats for Repo rows", () => {
  const rec = {
    origin_url: null,
    default_branch: null,
    repo_group: null,
    language_stats_json: '{"ts":0.83}',
  };
  const base: Record<string, unknown> = { kind: "Repo" };
  applyRepoNullables(rec, base);
  assert.equal(base["originUrl"], null);
  assert.equal(base["defaultBranch"], null);
  assert.equal(base["group"], null);
  assert.deepEqual(base["languageStats"], { ts: 0.83 });
});

test("applyRepoNullables: empty stats column → languageStats: {} sentinel", () => {
  const base: Record<string, unknown> = { kind: "Repo" };
  applyRepoNullables({ language_stats_json: null }, base);
  assert.deepEqual(base["languageStats"], {});
});

test("applyRepoNullables: no-op for non-Repo rows", () => {
  const base: Record<string, unknown> = { kind: "File" };
  applyRepoNullables({ origin_url: null, language_stats_json: null }, base);
  assert.deepEqual(base, { kind: "File" });
});

test("applyRepoNullables: populated columns stay populated (string survives the NULL re-attach)", () => {
  // When the column carries a real value, applyRepoNullables must NOT
  // overwrite it — the upstream applyNodeColumns has already attached the
  // string. Only NULL columns get the explicit-null re-attach.
  const base: Record<string, unknown> = {
    kind: "Repo",
    originUrl: "https://example.com",
  };
  applyRepoNullables({ origin_url: "https://example.com", language_stats_json: null }, base);
  assert.equal(base["originUrl"], "https://example.com");
});
