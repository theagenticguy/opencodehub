/**
 * Canonical relation-kind roster accessor.
 *
 * The single source of truth for which edge relation types exist, in their
 * load-bearing order, is `RELATION_TYPES` in `@opencodehub/core-types`
 * (`edges.ts`) — append new kinds there, NEVER reorder (commit diffs and any
 * schema emitter depend on the order). This module previously held a hand-kept
 * `RELATION_KINDS` duplicate; it now delegates to core-types so the two can
 * never drift.
 */
import { RELATION_TYPES } from "@opencodehub/core-types";

/** Every relation kind, in canonical order. Source of truth for finders + tests. */
export function getAllRelationTypes(): readonly string[] {
  return RELATION_TYPES;
}
