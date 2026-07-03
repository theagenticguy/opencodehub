/**
 * Canonical relation-kind roster — pure, dependency-free.
 *
 * The single source of truth for which edge relation types exist, in their
 * load-bearing order (append new kinds, NEVER reorder — commit diffs and any
 * schema emitter depend on the order). Extracted into this pure module so the
 * single-file `SqliteStore` and the parity tests can reach it directly (the
 * prior schema module that once held it was removed in the single-file
 * migration, ADR 0019).
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
