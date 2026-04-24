/**
 * Default pipeline phase set — full 14-phase DAG.
 *
 * The runner treats this array as the canonical ordering source. Adding or
 * removing a phase is a one-line change here; the DAG validator catches
 * missing dependencies and cycles on the next run.
 *
 * Phase ordering (topologically):
 *   scan → profile
 *        → structure → markdown → parse → complexity → routes → tools →
 *                                         orm → crossFile → mro →
 *                                         communities → dead-code →
 *                                         processes → temporal → annotate
 *
 * `markdown` depends on `structure` and could run alongside `parse`; the
 * runner serialises everything since determinism dominates the latency
 * win at MVP scale. `profile` and `temporal` are pure leaves on `scan`
 * and could run in parallel with any post-scan phase once the runner
 * learns to fan out. `profile` emits a single ProjectProfile node that
 * scanner phases will consult to decide which scanners to invoke.
 */

import type { PipelinePhase } from "../types.js";
import { accessesPhase } from "./accesses.js";
import { annotatePhase } from "./annotate.js";
import { cochangePhase } from "./cochange.js";
import { communitiesPhase } from "./communities.js";
import { complexityPhase } from "./complexity.js";
import { confidenceDemotePhase } from "./confidence-demote.js";
import { crossFilePhase } from "./cross-file.js";
import { deadCodePhase } from "./dead-code.js";
import { dependenciesPhase } from "./dependencies.js";
import { embeddingsPhase } from "./embeddings.js";
import { fetchesPhase } from "./fetches.js";
import { incrementalScopePhase } from "./incremental-scope.js";
import { lspGoPhase } from "./lsp-go.js";
import { lspPythonPhase } from "./lsp-python.js";
import { lspRustPhase } from "./lsp-rust.js";
import { lspTypescriptPhase } from "./lsp-typescript.js";
import { markdownPhase } from "./markdown.js";
import { mroPhase } from "./mro.js";
import { openapiPhase } from "./openapi.js";
import { ormPhase } from "./orm.js";
import { ownershipPhase } from "./ownership.js";
import { parsePhase } from "./parse.js";
import { processesPhase } from "./processes.js";
import { profilePhase } from "./profile.js";
import { riskSnapshotPhase } from "./risk-snapshot.js";
import { routesPhase } from "./routes.js";
import { sbomPhase } from "./sbom.js";
import { scanPhase } from "./scan.js";
import { structurePhase } from "./structure.js";
import { summarizePhase } from "./summarize.js";
import { temporalPhase } from "./temporal.js";
import { toolsPhase } from "./tools.js";

export const DEFAULT_PHASES: readonly PipelinePhase[] = [
  scanPhase,
  profilePhase,
  structurePhase,
  markdownPhase,
  parsePhase,
  // incremental-scope is passive at v1.0: it consumes scan output and emits
  // a closure hint for future consumers. Placed after parse so later phases
  // can plumb `ctx.phaseOutputs.incremental-scope.closureFiles` once they
  // learn to honour it. It has no downstream dependents today.
  incrementalScopePhase,
  complexityPhase,
  routesPhase,
  openapiPhase,
  toolsPhase,
  ormPhase,
  crossFilePhase,
  // `accesses` depends on parse (symbol boundaries + source) and cross-file
  // (stable CALLS graph before we layer ACCESSES on top). Runs before
  // communities so ACCESSES can participate in Leiden weights if we later
  // decide to surface receiver ↔ field coupling.
  accessesPhase,
  // `lsp-python` runs after the tree-sitter heuristic passes (parse,
  // crossFile, accesses) so its compiler-grade edges UPGRADE existing
  // low-confidence heuristic edges instead of racing them. It runs before
  // `mro` (so MRO sees upgraded EXTENDS edges), `communities` (so
  // clustering sees the richer edge set), and `dead-code` (so reachability
  // sees real callers). The phase is a no-op on non-Python repos.
  lspPythonPhase,
  // `lsp-typescript` mirrors `lsp-python` for TS / TSX / JS / JSX, driving
  // tsserver via `typescript-language-server`. Runs immediately after
  // `lsp-python` so all LSP phases sit contiguously before
  // `confidence-demote`. No-op on non-TS/JS repos.
  lspTypescriptPhase,
  // `lsp-go` upgrades Go CALLS / REFERENCES / EXTENDS edges with
  // compiler-grade resolution from gopls. No-op on non-Go repos.
  lspGoPhase,
  // `lsp-rust` upgrades Rust CALLS / REFERENCES / EXTENDS edges with
  // compiler-grade resolution from rust-analyzer. No-op on non-Rust repos.
  // rust-analyzer defaults to `procMacro.enable=false`, so derive- and
  // attribute-macro-synthesized references (serde, tokio) are intentionally
  // missing — see the header comment of `lsp-rust.ts` for the tradeoff.
  lspRustPhase,
  // `confidence-demote` runs immediately after every LSP phase and before
  // `mro`. It walks the graph once and demotes any confidence-0.5 heuristic
  // CALLS / REFERENCES / EXTENDS edge whose `(from, type, to)` triple is
  // also covered by a confidence-1.0 LSP-sourced edge — the heuristic is
  // kept at 0.2 with a `+lsp-unconfirmed` reason suffix so downstream
  // consumers can filter without losing provenance.
  confidenceDemotePhase,
  mroPhase,
  communitiesPhase,
  // Dead-code classification. Depends on cross-file (for inbound
  // edges), MRO (for METHOD_OVERRIDES / METHOD_IMPLEMENTS keep-alive edges),
  // and communities (for ghost-community rollups). Runs before processes so
  // later phases can observe `deadness` on callable nodes.
  deadCodePhase,
  processesPhase,
  // Outbound HTTP → Route detection runs after processes so enclosing-symbol
  // anchors are consistent with Process entry-point ids, and after routes so
  // local Route nodes are available for matching.
  fetchesPhase,
  temporalPhase,
  cochangePhase,
  // Ownership depends on temporal (for decayedChurn / top-contributor-last-seen /
  // coauthorCount), communities (to denormalise truck-factor + drift), and parse
  // (for symbol boundaries). Runs once per analyse cycle so blame happens once.
  ownershipPhase,
  dependenciesPhase,
  // `sbom` depends on `dependencies` and is a silent no-op unless
  // `options.sbom === true`. When enabled, it emits
  // `.codehub/sbom.cyclonedx.json` + `.codehub/sbom.spdx.json`.
  sbomPhase,
  annotatePhase,
  // `risk-snapshot` depends on `annotate` and captures a per-community +
  // findings-histogram snapshot under `.codehub/history/` for trend analysis.
  // Rotation keeps the last 100 snapshots.
  riskSnapshotPhase,
  // `summarize` runs after every LSP phase (via its dep on
  // `confidence-demote`) so trust filtering observes finalised edge
  // provenance, and BEFORE `embeddings` so a future follow-up can embed
  // summary text alongside the existing signature/description vectors.
  // The phase is a silent no-op unless `options.summaries === true`, and
  // it is a hard no-op whenever `options.offline === true`.
  summarizePhase,
  // `embeddings` depends on `annotate` so it observes the final graph. The
  // phase is a silent no-op unless `options.embeddings === true`. Keeping it
  // at the tail means downstream hashing can key embeddings to graph state.
  embeddingsPhase,
];
