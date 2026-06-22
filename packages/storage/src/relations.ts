/**
 * Canonical relation-kind roster — pure, dependency-free.
 *
 * The single source of truth for which edge relation types exist, in their
 * load-bearing order (append new kinds, NEVER reorder — commit diffs and any
 * schema emitter depend on the order). Lived in `graphdb-schema.ts`; extracted
 * here so the single-file `SqliteStore` and the parity tests can reach it
 * without importing the lbug-era schema module (deleted in the single-file
 * migration).
 */
const RELATION_KINDS: readonly string[] = [
  "CONTAINS",
  "DEFINES",
  "IMPORTS",
  "CALLS",
  "EXTENDS",
  "IMPLEMENTS",
  "HAS_METHOD",
  "HAS_PROPERTY",
  "ACCESSES",
  "METHOD_OVERRIDES",
  "OVERRIDES",
  "METHOD_IMPLEMENTS",
  "MEMBER_OF",
  "PROCESS_STEP",
  "HANDLES_ROUTE",
  "FETCHES",
  "HANDLES_TOOL",
  "ENTRY_POINT_OF",
  "WRAPS",
  "QUERIES",
  "REFERENCES",
  "FOUND_IN",
  "DEPENDS_ON",
  "OWNED_BY",
  "TYPE_OF",
];

/** Every relation kind, in canonical order. Source of truth for finders + tests. */
export function getAllRelationTypes(): readonly string[] {
  return RELATION_KINDS;
}
