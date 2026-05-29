/**
 * Route response-shape classification.
 *
 * `classifyShape` compares the property names a consumer file actually
 * reads off a response against the Route's statically-detected
 * `responseKeys`. Lifted verbatim from the MCP `shape_check` tool so both
 * the MCP surface and the `api-impact` analysis fn share one impl.
 *
 *   - MATCH    — every accessed key is in responseKeys.
 *   - MISMATCH — at least one accessed key is NOT in responseKeys.
 *   - PARTIAL  — no accessed keys found (can't check).
 */

export type ShapeStatus = "MATCH" | "MISMATCH" | "PARTIAL";

/** Classify a set of accessed keys against responseKeys. */
export function classifyShape(
  accessedKeys: readonly string[],
  responseKeys: readonly string[],
): { status: ShapeStatus; missing: readonly string[] } {
  if (accessedKeys.length === 0) return { status: "PARTIAL", missing: [] };
  const known = new Set(responseKeys);
  const missing = accessedKeys.filter((k) => !known.has(k));
  if (missing.length === 0) return { status: "MATCH", missing: [] };
  return { status: "MISMATCH", missing };
}
