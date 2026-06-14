/**
 * Diff-scoped change-pack.
 *
 * `runChangePack` generalizes what `computeVerdict` already does internally
 * (diff → per-symbol upstream fan-out) but RETAINS the impacted subgraph
 * instead of collapsing it to a scalar blast radius, and SURFACES the tests
 * that impact analysis classifies-then-drops today.
 *
 * The function is read-only over the graph: it composes `runDetectChanges`,
 * `runImpact`, and `computeVerdict`, emits no new nodes or edges, calls no
 * LLM, and produces byte-deterministic output with a content hash. It never
 * throws — an empty or symbol-free diff resolves to an empty-but-valid pack,
 * mirroring the verdict engine's empty-diff path.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, sha256Hex } from "@opencodehub/core-types";
import type { IGraphStore } from "@opencodehub/storage";
import type {
  AffectedTest,
  ChangedSymbol,
  ChangePack,
  ChangePackQuery,
  CostAttribution,
  ImpactedSubgraph,
  ImpactedSubgraphEdge,
  ImpactedSubgraphNode,
} from "./change-pack-types.js";
import { runDetectChanges } from "./detect-changes.js";
import { isTestPath, runImpact } from "./impact.js";
import type { DetectChangesQuery, DetectChangesResult } from "./types.js";
import { computeVerdict } from "./verdict.js";
import type { VerdictQuery, VerdictResponse } from "./verdict-types.js";

const DEFAULT_BASE = "main";
const DEFAULT_HEAD = "HEAD";
const DEFAULT_DEPTH = 4;
const DEFAULT_MIN_CONFIDENCE = 0.7;
const DEFAULT_BUDGET = 100_000;
/** Hard ceiling on retained subgraph nodes; larger sets truncate deterministically. */
const MAX_SUBGRAPH_NODES = 5000;

/**
 * Seam for reading impacted-file source so the blind-baseline computation can
 * be exercised without touching disk. The default reads UTF-8 bytes from the
 * filesystem; tests inject an in-memory map.
 */
export type ReadFileText = (absPath: string) => Promise<string>;

const defaultReadFileText: ReadFileText = (absPath) => readFile(absPath, "utf8");

/**
 * Internal seams for hermetic testing. Production callers pass nothing — the
 * defaults wire the real `runDetectChanges` / `computeVerdict` (which shell
 * out to git) and a filesystem read. Tests inject deterministic stand-ins so
 * the suite never spawns git or touches disk.
 */
export interface ChangePackInternal {
  readonly readFileText?: ReadFileText;
  readonly detectChanges?: (
    store: IGraphStore,
    q: DetectChangesQuery,
  ) => Promise<DetectChangesResult>;
  readonly computeVerdict?: (store: IGraphStore, q: VerdictQuery) => Promise<VerdictResponse>;
}

/**
 * Character-count token heuristic. Matches the pack's degraded counter
 * (`max(1, ceil(len / 4))`). This is an estimate, not a model tokenizer.
 */
export function charHeuristicTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Resolved query envelope, folded into the hash so identical inputs hash alike. */
interface ChangePackEnvelope {
  readonly base: string;
  readonly head: string;
  readonly depth: number;
  readonly minConfidence: number;
  readonly budget: number;
  readonly includeTestsInSubgraph: boolean;
}

/**
 * Compose a change-pack for the given git range. Never throws: git failures
 * fail open to an empty diff, per-symbol traversal errors are swallowed, and
 * an unreadable impacted file is skipped without breaking determinism.
 */
export async function runChangePack(
  store: IGraphStore,
  query: ChangePackQuery,
  internal: ChangePackInternal = {},
): Promise<ChangePack> {
  const repoPath = query.repoPath;
  const base = query.base ?? DEFAULT_BASE;
  const head = query.head ?? DEFAULT_HEAD;
  const depth = query.depth ?? DEFAULT_DEPTH;
  const minConfidence = query.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const budget = query.budget ?? DEFAULT_BUDGET;
  const includeTestsInSubgraph = query.includeTestsInSubgraph ?? false;
  const readFileText = internal.readFileText ?? defaultReadFileText;
  const detectChanges = internal.detectChanges ?? runDetectChanges;
  const computeVerdictFn = internal.computeVerdict ?? computeVerdict;
  const envelope: ChangePackEnvelope = {
    base,
    head,
    depth,
    minConfidence,
    budget,
    includeTestsInSubgraph,
  };

  // ---- 1. diff → changed symbols (two-dot compare range, PR semantics) ----
  const compareRef = `${base}..${head}`;
  const changes = await detectChanges(store, {
    scope: "compare",
    compareRef,
    repoPath,
  });

  // The verdict section is always computed, even on an empty diff, so callers
  // get a coherent 5-tier signal regardless of blast radius.
  const verdict = await computeVerdictFn(store, { repoPath, base, head });

  const changedFiles = sortStrings(changes.changedFiles);
  const changedSymbols = sortChangedSymbols(
    changes.affectedSymbols.map((s) => ({
      id: s.id,
      name: s.name,
      filePath: s.filePath,
      kind: s.kind,
    })),
  );

  if (changedSymbols.length === 0) {
    // Empty or symbol-free diff: empty subgraph + tests, zero-savings cost.
    return finalisePack({
      changedFiles,
      changedSymbols,
      impactedSubgraph: emptySubgraph(),
      verdict,
      affectedTests: [],
      costAttribution: await emptyCostAttribution(store),
      envelope,
    });
  }

  // ---- 2. per-symbol upstream fan-out → union the subgraph + collect tests ----
  // One `includeTests:true` pass per changed symbol yields both the impacted
  // subgraph nodes/edges AND the test nodes (with depth) in a single
  // traversal. We post-filter: the subgraph excludes test paths by default
  // (production-only, matching the verdict), while the test set keeps only
  // test paths.
  const subgraphNodes = new Map<string, ImpactedSubgraphNode>();
  const tests = new Map<string, AffectedTest>();
  // Every traversed edge, deduped by (from,type,to). We retain or drop edges
  // in a single post-pass once the full node set is known, so an edge incident
  // to a test node is only dropped when that node is genuinely excluded.
  const allEdges = new Map<string, ImpactedSubgraphEdge>();
  // Node ids that resolve to a test path — used to filter edges when tests are
  // excluded from the subgraph.
  const testNodeIds = new Set<string>();
  // Ids of the changed symbols (the fan-out roots). Edges incident to a root
  // are always retained: the root is a production symbol the diff touched.
  const changedSymbolIds = new Set(changedSymbols.map((s) => s.id));

  for (const sym of changedSymbols) {
    let result: Awaited<ReturnType<typeof runImpact>>;
    try {
      result = await runImpact(store, {
        // `targetUid` is the zero-ambiguity resolver path; `target` is a
        // required field used only as the fallback label.
        target: sym.id,
        targetUid: sym.id,
        direction: "upstream",
        maxDepth: depth,
        minConfidence,
        includeTests: true,
      });
    } catch {
      // Partial data is acceptable; a failed traversal contributes nothing.
      continue;
    }

    for (const bucket of result.byDepth) {
      for (const node of bucket.nodes) {
        const isTest = isTestPath(node.filePath);
        if (isTest) {
          testNodeIds.add(node.id);
          // Affected-test selection: keep the shallowest depth. The first
          // reachedFromSymbol wins by changed-symbol id order; because
          // `changedSymbols` is pre-sorted by id and iterated in order, the
          // earliest writer already holds the lowest id, so we only update
          // reachedFromSymbol when we improve on depth from the same writer is
          // not needed — keep the first one recorded.
          const existing = tests.get(node.id);
          if (existing === undefined) {
            tests.set(node.id, {
              id: node.id,
              name: node.name,
              filePath: node.filePath,
              reachedFromSymbol: sym.id,
              depth: bucket.depth,
            });
          } else if (bucket.depth < existing.depth) {
            tests.set(node.id, {
              ...existing,
              depth: bucket.depth,
            });
          }
        }
        // Subgraph retention: exclude test paths unless the caller opts in.
        if (isTest && !includeTestsInSubgraph) continue;
        const prior = subgraphNodes.get(node.id);
        const minDepth =
          prior === undefined ? bucket.depth : Math.min(prior.minDepth, bucket.depth);
        if (prior === undefined || minDepth < prior.minDepth) {
          subgraphNodes.set(node.id, {
            id: node.id,
            name: node.name,
            filePath: node.filePath,
            kind: node.kind,
            minDepth,
          });
        }
      }
    }

    for (const edge of result.traversedEdges) {
      const key = `${edge.fromId}|${edge.type}|${edge.toId}`;
      if (!allEdges.has(key)) {
        allEdges.set(key, {
          fromId: edge.fromId,
          toId: edge.toId,
          type: edge.type,
          confidence: edge.confidence,
        });
      }
    }
  }

  const impactedSubgraph = buildSubgraph(
    subgraphNodes,
    allEdges,
    includeTestsInSubgraph ? new Set<string>() : testNodeIds,
    changedSymbolIds,
  );
  const affectedTests = sortAffectedTests([...tests.values()]);

  const costAttribution = await computeCostAttribution({
    store,
    repoPath,
    impactedSubgraph,
    affectedTests,
    body: buildHashBody({
      changedFiles,
      changedSymbols,
      impactedSubgraph,
      verdict,
      affectedTests,
    }),
    readFileText,
  });

  return finalisePack({
    changedFiles,
    changedSymbols,
    impactedSubgraph,
    verdict,
    affectedTests,
    costAttribution,
    envelope,
  });
}

// ---------------------------------------------------------------------------
// Subgraph assembly
// ---------------------------------------------------------------------------

function emptySubgraph(): ImpactedSubgraph {
  return { nodes: [], edges: [], nodeCount: 0, edgeCount: 0, truncated: false };
}

/**
 * Build the retained subgraph from the deduped node + edge maps. Nodes are
 * sorted by `(minDepth, id)` and capped at `MAX_SUBGRAPH_NODES`; edges are
 * filtered to those whose endpoints survive (both ends are either a retained
 * node or a changed-symbol root) and dropped if incident to an excluded test
 * node. Final ordering is `(fromId, type, toId)` for byte-identity.
 */
function buildSubgraph(
  nodeMap: ReadonlyMap<string, ImpactedSubgraphNode>,
  edgeMap: ReadonlyMap<string, ImpactedSubgraphEdge>,
  excludedNodeIds: ReadonlySet<string>,
  rootIds: ReadonlySet<string>,
): ImpactedSubgraph {
  // Deterministic node ordering: shallowest depth first, then id. Truncate
  // past the hard ceiling so the subgraph is always bounded.
  const orderedNodes = [...nodeMap.values()].sort((a, b) => {
    if (a.minDepth !== b.minDepth) return a.minDepth - b.minDepth;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const truncated = orderedNodes.length > MAX_SUBGRAPH_NODES;
  const keptNodes = truncated ? orderedNodes.slice(0, MAX_SUBGRAPH_NODES) : orderedNodes;

  // An edge endpoint is valid when it is a retained node or a changed-symbol
  // root (the roots are diff-touched production symbols, never in byDepth).
  const keptNodeIds = new Set(keptNodes.map((n) => n.id));
  const endpointValid = (id: string): boolean => keptNodeIds.has(id) || rootIds.has(id);

  const keptEdges: ImpactedSubgraphEdge[] = [];
  for (const edge of edgeMap.values()) {
    if (excludedNodeIds.has(edge.fromId) || excludedNodeIds.has(edge.toId)) continue;
    if (!endpointValid(edge.fromId) || !endpointValid(edge.toId)) continue;
    keptEdges.push(edge);
  }
  keptEdges.sort((a, b) => {
    if (a.fromId !== b.fromId) return a.fromId < b.fromId ? -1 : 1;
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    if (a.toId !== b.toId) return a.toId < b.toId ? -1 : 1;
    return 0;
  });

  // Re-sort retained nodes by id for the emitted collection (deterministic
  // node ordering). Depth ordering above is only the truncation key.
  const emittedNodes = [...keptNodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    nodes: emittedNodes,
    edges: keptEdges,
    nodeCount: emittedNodes.length,
    edgeCount: keptEdges.length,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Cost attribution
// ---------------------------------------------------------------------------

interface CostAttributionInput {
  readonly store: IGraphStore;
  readonly repoPath: string;
  readonly impactedSubgraph: ImpactedSubgraph;
  readonly affectedTests: readonly AffectedTest[];
  /** The change-pack context body (minus costAttribution + hash) the agent consumes. */
  readonly body: unknown;
  readonly readFileText: ReadFileText;
}

async function computeCostAttribution(input: CostAttributionInput): Promise<CostAttribution> {
  const { store, repoPath, impactedSubgraph, affectedTests, body, readFileText } = input;

  const changePackTokens = charHeuristicTokens(canonicalJson(body));

  // Blind baseline: the cost an agent pays by reading every impacted file
  // whole. Distinct File paths in the subgraph; read each once from disk.
  const distinctFiles = new Set<string>();
  for (const node of impactedSubgraph.nodes) {
    if (node.filePath.length > 0) distinctFiles.add(node.filePath);
  }
  // Deterministic read order (irrelevant to the sum, but keeps any future
  // logging stable).
  const orderedFiles = [...distinctFiles].sort();
  let blindBaselineTokens = 0;
  for (const relPath of orderedFiles) {
    let text: string;
    try {
      text = await readFileText(path.join(repoPath, relPath));
    } catch {
      // Unreadable file (deleted, permissions): skip, stay deterministic.
      continue;
    }
    blindBaselineTokens += charHeuristicTokens(text);
  }

  const tokensSaved = Math.max(0, blindBaselineTokens - changePackTokens);
  const tokensSavedPct =
    blindBaselineTokens > 0 ? Math.round((tokensSaved / blindBaselineTokens) * 100) : 0;

  const totalTestCount = await countTestFiles(store);
  const affectedTestCount = affectedTests.length;
  const ciTestsSkipped = Math.max(0, totalTestCount - affectedTestCount);

  return {
    estimate: true,
    tokenizerModel: "char-heuristic-v1",
    changePackTokens,
    blindBaselineTokens,
    tokensSaved,
    tokensSavedPct,
    affectedTestCount,
    totalTestCount,
    ciTestsSkipped,
  };
}

async function emptyCostAttribution(store: IGraphStore): Promise<CostAttribution> {
  // An empty pack consumes a fixed, tiny body; the blind baseline is zero
  // because there are no impacted files. Report total tests for context.
  const totalTestCount = await countTestFiles(store);
  return {
    estimate: true,
    tokenizerModel: "char-heuristic-v1",
    changePackTokens: 0,
    blindBaselineTokens: 0,
    tokensSaved: 0,
    tokensSavedPct: 0,
    affectedTestCount: 0,
    totalTestCount,
    ciTestsSkipped: totalTestCount,
  };
}

/** Count distinct test-path File nodes in the repo graph (approximation of suite size). */
async function countTestFiles(store: IGraphStore): Promise<number> {
  try {
    const files = await store.listNodesByKind("File");
    let count = 0;
    for (const node of files) {
      if (isTestPath(node.filePath)) count += 1;
    }
    return count;
  } catch {
    // File-kind enumeration unavailable on a partial index: report zero.
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Hashing + finalisation
// ---------------------------------------------------------------------------

interface PackBody {
  readonly changedFiles: readonly string[];
  readonly changedSymbols: readonly ChangedSymbol[];
  readonly impactedSubgraph: ImpactedSubgraph;
  readonly verdict: VerdictResponse;
  readonly affectedTests: readonly AffectedTest[];
}

/**
 * The context body the agent consumes — the change-pack minus its
 * cost-attribution block and content hash. Cost tokens are counted over this.
 */
function buildHashBody(body: PackBody): PackBody {
  return body;
}

interface FinaliseInput extends PackBody {
  readonly costAttribution: CostAttribution;
  readonly envelope: ChangePackEnvelope;
}

/**
 * Assemble the final ChangePack and compute `changePackHash` over the
 * canonical-JSON form with the hash field blanked, folding the query envelope
 * (base/head/depth/minConfidence/budget/includeTestsInSubgraph) into the
 * preimage so identical inputs hash alike and different ones diverge.
 */
function finalisePack(input: FinaliseInput): ChangePack {
  const pack: ChangePack = {
    changedFiles: input.changedFiles,
    changedSymbols: input.changedSymbols,
    impactedSubgraph: input.impactedSubgraph,
    verdict: input.verdict,
    affectedTests: input.affectedTests,
    costAttribution: input.costAttribution,
    changePackHash: "",
  };
  const preimage = canonicalJson({ ...pack, changePackHash: "", envelope: input.envelope });
  const changePackHash = sha256Hex(preimage);
  return { ...pack, changePackHash };
}

// ---------------------------------------------------------------------------
// Deterministic sorters
// ---------------------------------------------------------------------------

function sortStrings(values: readonly string[]): readonly string[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function sortChangedSymbols(symbols: readonly ChangedSymbol[]): readonly ChangedSymbol[] {
  return [...symbols].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function sortAffectedTests(tests: readonly AffectedTest[]): readonly AffectedTest[] {
  return [...tests].sort((a, b) => {
    if (a.filePath !== b.filePath) return a.filePath < b.filePath ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
