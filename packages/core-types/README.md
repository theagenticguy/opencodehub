# @opencodehub/core-types

Shared graph schema, node/edge type definitions, and determinism primitives
used across every OpenCodeHub package. This is a schema-only library — it
imports nothing from the rest of the workspace.

## Surface

```ts
import type { SymbolNode, EdgeKind, RepoUri } from "@opencodehub/core-types";
import { hashSymbol } from "@opencodehub/core-types/hash";
```

- **Node types** — `SymbolNode`, `FileNode`, `RepoNode`, `ProcessNode`, and
  the `repo_uri` typed attribute (ADR 0012,
  `packages/core-types/src/nodes.ts:524-552`).
- **Edge kinds** — the full `EdgeKind` enum and its confidence model (0.5
  heuristic, 1.0 SCIP-confirmed, 0.2 SCIP-unconfirmed).
- **`hashSymbol`** — the canonical, determinism-enforcing hash function.
  Identical inputs must always produce the same output; this is the
  project-wide invariant.
- **`RepoUri`** — branded string type for Sourcegraph-style URIs
  (`github.com/org/repo`, `local:<hash>`).

## Design

- Zero runtime dependencies — safe to import from any environment including
  edge runtimes.
- Types are declared with `satisfies` checks so schema drift is caught at
  compile time rather than at runtime.
