import type { EdgeId, NodeId } from "./id.js";

export type RelationType =
  | "CONTAINS"
  | "DEFINES"
  | "IMPORTS"
  | "CALLS"
  | "EXTENDS"
  | "IMPLEMENTS"
  | "HAS_METHOD"
  | "HAS_PROPERTY"
  | "ACCESSES"
  | "METHOD_OVERRIDES"
  | "OVERRIDES"
  | "METHOD_IMPLEMENTS"
  | "MEMBER_OF"
  | "PROCESS_STEP"
  | "HANDLES_ROUTE"
  | "FETCHES"
  | "HANDLES_TOOL"
  | "ENTRY_POINT_OF"
  | "WRAPS"
  | "QUERIES"
  | "REFERENCES"
  | "FOUND_IN"
  | "DEPENDS_ON"
  | "OWNED_BY";

// Insertion order is load-bearing: graphHash serializes edges ordered by
// (from, type, to, step) but the RELATION_TYPES runtime array is referenced by
// SCHEMA_HINT and DDL generators whose outputs feed into hashes downstream.
// New relation types must be APPENDED at the end.
export const RELATION_TYPES: readonly RelationType[] = [
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
] as const;

/**
 * Edge connecting two graph nodes.
 *
 * `confidence` (range [0, 1]) doubles as an edge weight. For `OWNED_BY`, ingestion
 * writes the normalized blame-line share (contributor lines ÷ total lines for the
 * target) into `confidence`, so higher-confidence edges identify primary owners.
 */
export interface CodeRelation {
  readonly id: EdgeId;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly type: RelationType;
  readonly confidence: number;
  readonly reason?: string;
  readonly step?: number;
}
