/**
 * Stable NodeId derivation for extracted symbol definitions.
 *
 * Kept in the providers directory (not pipeline/phases) so every provider
 * that needs an enclosing-symbol id can import it without dragging in the
 * parse-phase's full transitive graph. The phase-level consumer
 * (`pipeline/phases/parse.ts`) re-exports this for backward compatibility.
 */

import { makeNodeId, type NodeId } from "@opencodehub/core-types";
import type { ExtractedDefinition } from "./extraction-types.js";

/**
 * Deterministic NodeId for an extracted definition. Mirrors the encoding
 * the parse phase uses when emitting graph nodes, so downstream extractors
 * that never see the graph can still produce matching ids for `from` /
 * `to` endpoints on derived edges (e.g. ACCESSES, QUERIES).
 */
export function idForDefinition(d: ExtractedDefinition): NodeId {
  return makeNodeId(d.kind, d.filePath, d.qualifiedName, {
    ...(d.parameterCount !== undefined ? { parameterCount: d.parameterCount } : {}),
    ...(d.parameterTypes !== undefined ? { parameterTypes: d.parameterTypes } : {}),
    ...(d.isConst !== undefined ? { isConst: d.isConst } : {}),
  });
}
