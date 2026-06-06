# @opencodehub/core-types

Shared graph schema, node/edge type definitions, and determinism primitives
used across every OpenCodeHub package. This is a schema-only library — it
imports nothing from the rest of the workspace.

## Surface

Everything ships from the single `.` entry point — there is no `/hash`
subpath.

```ts
import {
  type GraphNode,
  type RepoNode,
  type RelationType,
  type CodeRelation,
  type NodeId,
  makeNodeId,
  graphHash,
  canonicalJson,
} from "@opencodehub/core-types";
```

- **Node types** — `GraphNode` is the discriminated union over the concrete
  `*Node` interfaces (`FileNode`, `FunctionNode`, `ClassNode`, `RepoNode`,
  `ProcessNode`, …) in `src/nodes.ts`. `RepoNode.repoUri` is a plain
  `readonly string` carrying the Sourcegraph-style handle —
  `github.com/org/repo`, or `local:<sha256(absolute-path)[:12]>` when no git
  remote exists (`src/nodes.ts`, ADR 0012).
- **Relation types** — `RelationType` is the string-literal union of every
  edge label (`CONTAINS`, `CALLS`, `DEPENDS_ON`, …); `RELATION_TYPES` is the
  matching runtime array, append-only because its order feeds downstream
  hashes. Edges are `CodeRelation` records, whose `confidence` field is a bare
  `number` in `[0, 1]` doubling as an edge weight.
- **Identity** — `makeNodeId(kind, filePath, qualifiedName, opts)` builds the
  canonical, branded `NodeId`; `makeEdgeId` does the same for `EdgeId`.
  `parseNodeId` recovers the structured parts.
- **Determinism primitives** — `graphHash(graph)` is the canonical SHA-256 of
  a `KnowledgeGraph`'s `{edges, nodes}` projection; identical graph content
  must always produce the same digest, regardless of insertion order. It is
  built on `canonicalJson` / `writeCanonicalJson` (sorted keys, streaming) and
  the `sha256Hex` / `hash6` helpers.
- **Provenance** — `PROVENANCE_PREFIXES` and `SCIP_PROVENANCE_PREFIXES`
  classify where a relation came from. Confidence tiers (heuristic vs.
  SCIP-confirmed vs. SCIP-unconfirmed) are assigned by the ingestion pipeline's
  confidence-demote phase, not by this package.
- **Schema version** — `SCHEMA_VERSION` plus `compareSchemaVersion`, which
  classifies an indexed graph's version against the running binary
  (`major-drift` / `minor-drift` / `forward-incompat` / `ok`).

## Design

- Zero runtime dependencies — safe to import from any environment.
- Determinism is the project-wide invariant: `makeNodeId` and `graphHash` are
  pure functions of their inputs, so two indexes of the same commit produce
  byte-identical graph hashes.
