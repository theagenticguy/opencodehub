/**
 * Drift guard for the two single-sourced rosters lifted to
 * `@opencodehub/core-types`.
 *
 * `getAllRelationTypes()` (this package) and the storage `NODE_COLUMNS`
 * re-export MUST stay deep-equal to their core-types originals
 * (`RELATION_TYPES`, `NODE_COLUMNS`). Before the hoist, `relations.ts` kept a
 * hand-maintained `RELATION_KINDS` twin and the MCP schema resource kept a
 * truncated `NODE_COLUMNS` twin; both could rot silently. These assertions are
 * the guard that was missing — a future edit to either roster in core-types is
 * automatically reflected here (imports), and any accidental re-introduction of
 * a local literal that diverges trips this test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { NODE_COLUMNS as CORE_NODE_COLUMNS, RELATION_TYPES } from "@opencodehub/core-types";
import { NODE_COLUMNS as STORAGE_NODE_COLUMNS } from "./column-encode.js";
import { getAllRelationTypes } from "./relations.js";

test("getAllRelationTypes() deep-equals core-types RELATION_TYPES", () => {
  assert.deepEqual(getAllRelationTypes(), RELATION_TYPES);
  assert.equal(getAllRelationTypes().length, 25);
});

test("storage NODE_COLUMNS deep-equals core-types NODE_COLUMNS", () => {
  assert.deepEqual(STORAGE_NODE_COLUMNS, CORE_NODE_COLUMNS);
  assert.equal(STORAGE_NODE_COLUMNS.length, 73);
});
