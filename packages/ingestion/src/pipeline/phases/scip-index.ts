/**
 * `scip-index` phase — replaces the four per-language LSP upgrade
 * phases (lsp-python / lsp-typescript / lsp-go / lsp-rust) with a
 * single pass over SCIP (https://scip-code.org) indexes.
 *
 * For every language detected in the profile we:
 *   1. Run the appropriate SCIP indexer into
 *      `.codehub/scip/<lang>.scip`, unless the artifact is fresh
 *      (mtime newer than every source file for that language).
 *   2. Parse the index with `@opencodehub/scip-ingest`, derive caller
 *      -> callee edges via innermost-enclosing-range attribution.
 *   3. Map each SCIP call site (document, line) back to the tightest
 *      OpenCodeHub symbol node via the same file+line lookup the LSP
 *      phases used.
 *   4. Emit CodeRelation edges. First-party (Tier-1) indexers emit
 *      `confidence = 1.0` + `reason = scip:<indexer>@<version>` so the
 *      downstream `confidence-demote`, `summarize`, `mcp/confidence`, and
 *      `cli/analyze` consumers keep treating them as oracle-confirmed (see
 *      `SCIP_PROVENANCE_PREFIXES`). Third-party / pre-alpha (Tier-1.5)
 *      indexers (php, dart) emit `confidence = 0.7` +
 *      `reason = scip-unofficial:<indexer>@<version>` (see
 *      `SCIP_UNOFFICIAL_PROVENANCE_PREFIXES`) — SCIP-shaped and deterministic
 *      but NOT oracle confirmers. The reason class + confidence both flow from
 *      the `LANG_REGISTRY` `tier` so the writer never drifts from the readers.
 *
 * Skip semantics:
 *   - `CODEHUB_DISABLE_SCIP=1`       -> entire phase no-op.
 *   - Indexer binary missing         -> per-language skip with a warn
 *                                       ProgressEvent; tree-sitter
 *                                       heuristic tier keeps its
 *                                       low-confidence edges.
 *   - `options.offline && !cached`   -> per-language skip (no network
 *                                       install path).
 */

import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { GraphNode, NodeId } from "@opencodehub/core-types";
import type {
  DerivedEdge,
  DerivedRelation,
  IndexerKind,
  IndexerResult,
  ScipIndexerName,
  ScipUnofficialIndexerName,
} from "@opencodehub/scip-ingest";
import {
  buildSymbolDefIndex,
  deriveIndex,
  detectLanguages,
  parseScipIndex,
  runIndexer,
  scipProvenanceReason,
  scipUnofficialProvenanceReason,
} from "@opencodehub/scip-ingest";
import { META_DIR_NAME } from "@opencodehub/storage";
import type { PipelineContext, PipelinePhase } from "../types.js";
import { ACCESSES_PHASE_NAME } from "./accesses.js";
import { CROSS_FILE_PHASE_NAME } from "./cross-file.js";
import { PARSE_PHASE_NAME } from "./parse.js";
import { PROFILE_PHASE_NAME, type ProfileOutput } from "./profile.js";
import { SCAN_PHASE_NAME } from "./scan.js";

export const SCIP_INDEX_PHASE_NAME = "scip-index";

/** First-party oracle confidence (Tier 1) — `scip:` provenance. */
const SCIP_CONFIDENCE = 1.0;
/**
 * Tier-1.5 (`scip-unofficial:`) confidence for third-party / pre-alpha indexers
 * (php, dart). Distinct from the 1.0 oracle ceiling and the 0.5 tree-sitter
 * heuristic floor: it sits in the (0.5, 0.95) band so these edges are NOT auto-
 * confirmed and are NOT demoted, while the `scip-unofficial:` reason prefix lets
 * every consumer surface them as their own tier (see SCIP_UNOFFICIAL_PROVENANCE_PREFIXES).
 */
const SCIP_UNOFFICIAL_CONFIDENCE = 0.7;

export interface ScipIndexPerLanguage {
  readonly kind: IndexerKind;
  readonly tool: string;
  readonly version: string;
  readonly skipped: boolean;
  readonly skipReason?: string;
  readonly scipPath: string;
  readonly edgesAdded: number;
  readonly edgesUpgraded: number;
}

export interface ScipIndexOutput {
  readonly enabled: boolean;
  readonly skippedReason?: string;
  readonly languages: readonly ScipIndexPerLanguage[];
  readonly totalEdgesAdded: number;
  readonly totalEdgesUpgraded: number;
  readonly durationMs: number;
}

export const scipIndexPhase: PipelinePhase<ScipIndexOutput> = {
  name: SCIP_INDEX_PHASE_NAME,
  deps: [
    SCAN_PHASE_NAME,
    PROFILE_PHASE_NAME,
    PARSE_PHASE_NAME,
    CROSS_FILE_PHASE_NAME,
    ACCESSES_PHASE_NAME,
  ],
  async run(ctx, deps) {
    return runScipIndex(ctx, deps);
  },
};

async function runScipIndex(
  ctx: PipelineContext,
  deps: ReadonlyMap<string, unknown>,
): Promise<ScipIndexOutput> {
  const start = Date.now();

  if (process.env["CODEHUB_DISABLE_SCIP"] === "1") {
    return {
      enabled: false,
      skippedReason: "CODEHUB_DISABLE_SCIP=1",
      languages: [],
      totalEdgesAdded: 0,
      totalEdgesUpgraded: 0,
      durationMs: Date.now() - start,
    };
  }

  const profile = deps.get(PROFILE_PHASE_NAME) as ProfileOutput | undefined;
  const profileNode = findProfileNode(ctx);
  if (profile === undefined || profileNode === undefined) {
    return {
      enabled: false,
      skippedReason: "no-profile-output",
      languages: [],
      totalEdgesAdded: 0,
      totalEdgesUpgraded: 0,
      durationMs: Date.now() - start,
    };
  }

  const projectLanguages = new Set(profileNode.languages);
  const candidates = detectLanguages(ctx.repoPath).filter((k: IndexerKind) =>
    projectLanguages.has(scipLangToOchLang(k)),
  );

  if (candidates.length === 0) {
    return {
      enabled: false,
      skippedReason: "no-scip-supported-languages",
      languages: [],
      totalEdgesAdded: 0,
      totalEdgesUpgraded: 0,
      durationMs: Date.now() - start,
    };
  }

  const outputDir = join(ctx.repoPath, META_DIR_NAME, "scip");
  const offline = Boolean(ctx.options.offline);
  const allowBuildScripts = process.env["CODEHUB_ALLOW_BUILD_SCRIPTS"] === "1";

  const perLang: ScipIndexPerLanguage[] = [];
  const nodesByFile = indexNodesByFile(ctx);

  // Fan out: per-language indexer runs are independent.
  const results = await Promise.all(
    candidates.map(async (kind: IndexerKind) => {
      const scipPath = join(outputDir, `${kind}.scip`);
      let result: IndexerResult;
      if (offline && !existsSync(scipPath)) {
        result = {
          kind,
          scipPath,
          tool: kindToTool(kind),
          version: "",
          skipped: true,
          skipReason: "offline-no-cached-index",
          durationMs: 0,
        };
      } else if (isCacheFresh(scipPath, ctx.repoPath, kind)) {
        result = {
          kind,
          scipPath,
          tool: kindToTool(kind),
          version: probeCachedVersion(scipPath),
          skipped: false,
          durationMs: 0,
        };
      } else {
        try {
          result = await runIndexer(kind, {
            projectRoot: ctx.repoPath,
            outputDir,
            allowBuildScripts,
          });
        } catch (err) {
          ctx.onProgress?.({
            phase: SCIP_INDEX_PHASE_NAME,
            kind: "warn",
            message: `scip-index: ${kind} indexer failed — ${(err as Error).message}`,
          });
          result = {
            kind,
            scipPath,
            tool: kindToTool(kind),
            version: "",
            skipped: true,
            skipReason: `indexer-error:${(err as Error).message}`,
            durationMs: 0,
          };
        }
      }
      return result;
    }),
  );

  let totalAdded = 0;
  let totalUpgraded = 0;
  const existingEdgeKeys = snapshotEdgeKeys(ctx);

  for (const result of results) {
    if (result.skipped) {
      ctx.onProgress?.({
        phase: SCIP_INDEX_PHASE_NAME,
        kind: "warn",
        message: `scip-index: ${result.kind} skipped — ${result.skipReason ?? "unknown"}`,
      });
      perLang.push({
        kind: result.kind,
        tool: result.tool,
        version: result.version,
        skipped: true,
        skipReason: result.skipReason ?? "skipped",
        scipPath: result.scipPath,
        edgesAdded: 0,
        edgesUpgraded: 0,
      });
      continue;
    }
    if (!existsSync(result.scipPath)) {
      perLang.push({
        kind: result.kind,
        tool: result.tool,
        version: result.version,
        skipped: true,
        skipReason: "scip-output-missing",
        scipPath: result.scipPath,
        edgesAdded: 0,
        edgesUpgraded: 0,
      });
      continue;
    }
    const buf = await readFile(result.scipPath);
    const index = parseScipIndex(new Uint8Array(buf));
    const derived = deriveIndex(index);
    const symbolDef = buildSymbolDefIndex(index);
    // Tier-aware: first-party kinds emit `scip:` at oracle confidence (1.0);
    // Tier-1.5 kinds (php, dart) emit `scip-unofficial:` at 0.7. Both the reason
    // class AND the confidence flow from the LANG_REGISTRY `tier` so the writer
    // can never drift from the readers (confidence-demote, mcp/confidence).
    const { reason, confidence } = buildScipReasonAndConfidence(
      result.kind,
      result.version || index.tool.version || "unknown",
    );

    const { added: edgeAdded, upgraded: edgeUpgraded } = emitEdges(
      ctx,
      nodesByFile,
      derived.edges,
      symbolDef,
      reason,
      confidence,
      existingEdgeKeys,
    );
    const { added: relAdded, upgraded: relUpgraded } = emitRelations(
      ctx,
      nodesByFile,
      derived.relations,
      symbolDef,
      reason,
      confidence,
      existingEdgeKeys,
    );
    const added = edgeAdded + relAdded;
    const upgraded = edgeUpgraded + relUpgraded;
    totalAdded += added;
    totalUpgraded += upgraded;
    perLang.push({
      kind: result.kind,
      tool: result.tool,
      version: result.version || index.tool.version || "unknown",
      skipped: false,
      scipPath: result.scipPath,
      edgesAdded: added,
      edgesUpgraded: upgraded,
    });
  }

  return {
    enabled: perLang.some((p) => !p.skipped),
    languages: perLang,
    totalEdgesAdded: totalAdded,
    totalEdgesUpgraded: totalUpgraded,
    durationMs: Date.now() - start,
  };
}

// ---- helpers ------------------------------------------------------------

function findProfileNode(ctx: PipelineContext): ProfileNodeLike | undefined {
  for (const n of ctx.graph.nodes()) {
    if (n.kind === "ProjectProfile") {
      const langs = (n as { languages?: readonly string[] }).languages ?? [];
      return { languages: [...langs] };
    }
  }
  return undefined;
}

interface ProfileNodeLike {
  readonly languages: readonly string[];
}

/**
 * Single source of truth for "is this language wired end-to-end". Each
 * `IndexerKind` maps to its OpenCodeHub language token (`ochLang`), its
 * indexer tool name (`tool`), and the canonical SCIP provenance name
 * (`provenance`) used to build oracle-edge reason strings.
 *
 * `clang` covers C + C++. Downstream LanguageId is a single token; "c"
 * matches existing code paths that look up C-derived sources by
 * extension. C++-specific consumers see `clang` under the indexer name
 * in provenance reasons.
 *
 * `cobol-proleap` has `provenance: null`: COBOL relations are emitted by
 * the in-process tree-sitter/regex bridge during the parse phase, not via
 * SCIP derivation, and `detectLanguages` never yields the proleap kind as
 * a scip-index candidate — so `result.kind` at the `lookupProvenance`
 * call site can never be `cobol-proleap`. The `null` states that honestly
 * instead of the prior `scip-typescript` placeholder that only existed to
 * satisfy switch exhaustiveness.
 *
 * `tier` discriminates the provenance CLASS the edge reason is built from:
 *   - `"first-party"` — CSC-governed oracle. Edges emit `scip:<indexer>@<v>`
 *     at confidence 1.0 (`SCIP_CONFIDENCE`); they are oracle confirmers.
 *   - `"scip-unofficial"` — third-party / pre-alpha (php, dart). Edges emit
 *     `scip-unofficial:<indexer>@<v>` at `SCIP_UNOFFICIAL_CONFIDENCE` (0.7);
 *     they are Tier 1.5 and MUST NOT act as oracle confirmers.
 * For `cobol-proleap` (`provenance: null`) the tier is irrelevant — it never
 * reaches SCIP edge emission — so it is pinned `"first-party"` for type
 * uniformity.
 *
 * `Record<IndexerKind, LangEntry>` keeps the same compile-time
 * exhaustiveness the per-kind switches got from
 * `noFallthroughCasesInSwitch`: tsc errors if a kind is missing or unknown.
 */
type ProvenanceTier = "first-party" | "scip-unofficial";

interface LangEntry {
  readonly ochLang: string;
  readonly tool: string;
  readonly provenance: ScipIndexerName | ScipUnofficialIndexerName | null;
  readonly tier: ProvenanceTier;
}

export const LANG_REGISTRY: Record<IndexerKind, LangEntry> = {
  typescript: {
    ochLang: "typescript",
    tool: "scip-typescript",
    provenance: "scip-typescript",
    tier: "first-party",
  },
  python: {
    ochLang: "python",
    tool: "scip-python",
    provenance: "scip-python",
    tier: "first-party",
  },
  go: { ochLang: "go", tool: "scip-go", provenance: "scip-go", tier: "first-party" },
  rust: {
    ochLang: "rust",
    tool: "rust-analyzer",
    provenance: "rust-analyzer",
    tier: "first-party",
  },
  java: { ochLang: "java", tool: "scip-java", provenance: "scip-java", tier: "first-party" },
  clang: { ochLang: "c", tool: "scip-clang", provenance: "scip-clang", tier: "first-party" },
  "cobol-proleap": {
    ochLang: "cobol",
    tool: "scip-cobol-proleap",
    provenance: null,
    tier: "first-party",
  },
  ruby: { ochLang: "ruby", tool: "scip-ruby", provenance: "scip-ruby", tier: "first-party" },
  dotnet: {
    ochLang: "csharp",
    tool: "scip-dotnet",
    provenance: "scip-dotnet",
    tier: "first-party",
  },
  kotlin: {
    ochLang: "kotlin",
    tool: "scip-kotlin",
    provenance: "scip-kotlin",
    tier: "first-party",
  },
  // Tier 1.5 — third-party / pre-alpha SCIP indexers. `scip-unofficial:` reason
  // class, mid confidence, never an oracle confirmer.
  php: { ochLang: "php", tool: "scip-php", provenance: "scip-php", tier: "scip-unofficial" },
  dart: { ochLang: "dart", tool: "scip-dart", provenance: "scip-dart", tier: "scip-unofficial" },
};

function scipLangToOchLang(k: IndexerKind): string {
  return LANG_REGISTRY[k].ochLang;
}

function kindToTool(k: IndexerKind): string {
  return LANG_REGISTRY[k].tool;
}

function kindToProvenance(k: IndexerKind): ScipIndexerName | ScipUnofficialIndexerName {
  const provenance = LANG_REGISTRY[k].provenance;
  if (provenance === null) {
    throw new Error(
      `scip-index: no SCIP provenance for ${k} (handled by the in-process bridge, not SCIP derivation)`,
    );
  }
  return provenance;
}

/**
 * Build the `(reason, confidence)` pair for a SCIP-derived edge, branching on
 * the LANG_REGISTRY `tier`:
 *   - `"first-party"` → `scip:<indexer>@<v>` at {@link SCIP_CONFIDENCE} (1.0).
 *   - `"scip-unofficial"` (php, dart) → `scip-unofficial:<indexer>@<v>` at
 *     {@link SCIP_UNOFFICIAL_CONFIDENCE} (0.7). These edges are Tier 1.5 and are
 *     deliberately NOT emitted as oracle (1.0, `scip:`) edges, so the
 *     confidence-demote phase never treats them as confirmers.
 */
function buildScipReasonAndConfidence(
  kind: IndexerKind,
  version: string,
): { reason: string; confidence: number } {
  const provenance = kindToProvenance(kind);
  if (LANG_REGISTRY[kind].tier === "scip-unofficial") {
    return {
      reason: scipUnofficialProvenanceReason(provenance as ScipUnofficialIndexerName, version),
      confidence: SCIP_UNOFFICIAL_CONFIDENCE,
    };
  }
  return {
    reason: scipProvenanceReason(provenance as ScipIndexerName, version),
    confidence: SCIP_CONFIDENCE,
  };
}

function isCacheFresh(scipPath: string, repoPath: string, _kind: IndexerKind): boolean {
  if (!existsSync(scipPath)) return false;
  // Coarse heuristic: if the .scip file exists and is newer than the
  // repo root mtime, treat it as fresh. A finer walk would compare
  // against every source file for the language, but that duplicates the
  // scan phase work. Callers can force a rebuild by deleting the file
  // or touching the repo root.
  try {
    const scipMtime = statSync(scipPath).mtimeMs;
    const rootMtime = statSync(repoPath).mtimeMs;
    return scipMtime >= rootMtime;
  } catch {
    return false;
  }
}

function probeCachedVersion(scipPath: string): string {
  try {
    // We don't parse-scan twice — return "cached" and let the actual
    // decode phase read the real tool version from Metadata. Callers
    // replace this string when emitting edges.
    return statSync(scipPath).mtimeMs ? "cached" : "";
  } catch {
    return "";
  }
}

/** Per-file, line-sorted node index for the tightest-enclosing lookup. */
type NodesByFile = ReadonlyMap<string, readonly SymbolRec[]>;
interface SymbolRec {
  readonly id: NodeId;
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
}

const SCIP_SYMBOL_KINDS: ReadonlySet<string> = new Set([
  "Class",
  "Method",
  "Function",
  "Interface",
  "Struct",
  "Enum",
  "Trait",
]);

function indexNodesByFile(ctx: PipelineContext): NodesByFile {
  const map = new Map<string, SymbolRec[]>();
  for (const n of ctx.graph.nodes()) {
    if (!SCIP_SYMBOL_KINDS.has(n.kind)) continue;
    const startLine = (n as { startLine?: number }).startLine;
    const endLine = (n as { endLine?: number }).endLine;
    if (startLine === undefined || endLine === undefined) continue;
    const rec: SymbolRec = {
      id: n.id as NodeId,
      filePath: n.filePath,
      startLine,
      endLine,
    };
    const arr = map.get(n.filePath);
    if (arr === undefined) map.set(n.filePath, [rec]);
    else arr.push(rec);
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => {
      if (a.startLine !== b.startLine) return a.startLine - b.startLine;
      return a.endLine - b.endLine;
    });
  }
  return map;
}

function findEnclosingNodeId(
  nodesByFile: NodesByFile,
  filePath: string,
  line: number,
): NodeId | undefined {
  const candidates = nodesByFile.get(filePath);
  if (candidates === undefined) return undefined;
  let best: SymbolRec | undefined;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const rec of candidates) {
    if (rec.startLine > line) break;
    if (rec.endLine < line) continue;
    const span = rec.endLine - rec.startLine;
    if (span < bestSpan) {
      best = rec;
      bestSpan = span;
    }
  }
  return best?.id;
}

function edgeKey(from: string, type: string, to: string): string {
  return `${from}\x00${type}\x00${to}`;
}

function snapshotEdgeKeys(ctx: PipelineContext): Set<string> {
  const s = new Set<string>();
  for (const e of ctx.graph.edges()) {
    s.add(edgeKey(e.from as string, e.type, e.to as string));
  }
  return s;
}

function emitEdges(
  ctx: PipelineContext,
  nodesByFile: NodesByFile,
  edges: readonly DerivedEdge[],
  symbolDef: ReadonlyMap<string, { file: string; line: number }>,
  reason: string,
  confidence: number,
  existingKeys: Set<string>,
): { added: number; upgraded: number } {
  let added = 0;
  let upgraded = 0;
  // SCIP symbol strings are not OpenCodeHub node ids. Every derived edge
  // needs two lookups: the caller's enclosing OCH node at the call site
  // `(e.document, e.callLine)`, and the callee's enclosing OCH node at
  // the callee's actual definition site. `symbolDef` carries the
  // definition `(file, line)` for every SCIP symbol that has a
  // DEFINITION occurrence anywhere in the index, so callee resolution is
  // disambiguated even when multiple in-repo symbols share a display
  // name. Symbols without a DEFINITION occurrence are external
  // (stdlib / vendored / absent typings) and their edges are dropped.
  // Each edge carries its own `kind` (CALLS or REFERENCES) so this loop
  // routes both function-call and read-side reference fanout through the
  // same caller→callee join shape.
  for (const e of edges) {
    const fromId = findEnclosingNodeId(nodesByFile, e.document, e.callLine + 1);
    if (!fromId) continue;
    const calleeDef = symbolDef.get(e.callee);
    if (!calleeDef) continue;
    const toId = findEnclosingNodeId(nodesByFile, calleeDef.file, calleeDef.line + 1);
    if (!toId) continue;
    if (fromId === toId) continue;

    const key = edgeKey(fromId, e.kind, toId);
    const priorExists = existingKeys.has(key);

    ctx.graph.addEdge({
      from: fromId,
      to: toId,
      type: e.kind,
      confidence,
      reason,
    });

    existingKeys.add(key);
    if (priorExists) upgraded += 1;
    else added += 1;
  }
  return { added, upgraded };
}

/**
 * Emit IMPLEMENTS / TYPE_OF graph edges from `derived.relations`.
 *
 * `collectRels` in `@opencodehub/scip-ingest/derive.ts` translates the
 * SCIP `Relationship` message (`is_implementation`, `is_type_definition`)
 * into structural relations between two SCIP symbols. Both ends need to
 * resolve to OCH nodes via `symbolDef` — a relation whose source or
 * target has no DEFINITION anywhere in the index is dropped (the
 * relation lives entirely outside the indexed corpus). Otherwise the
 * lookup uses the same `+1` boundary translation as `emitEdges` because
 * SCIP `range.startLine` is 0-indexed and OCH graph nodes are 1-indexed.
 */
function emitRelations(
  ctx: PipelineContext,
  nodesByFile: NodesByFile,
  relations: readonly DerivedRelation[],
  symbolDef: ReadonlyMap<string, { file: string; line: number }>,
  reason: string,
  confidence: number,
  existingKeys: Set<string>,
): { added: number; upgraded: number } {
  let added = 0;
  let upgraded = 0;
  for (const r of relations) {
    const fromDef = symbolDef.get(r.from);
    if (!fromDef) continue;
    const toDef = symbolDef.get(r.to);
    if (!toDef) continue;
    const fromId = findEnclosingNodeId(nodesByFile, fromDef.file, fromDef.line + 1);
    if (!fromId) continue;
    const toId = findEnclosingNodeId(nodesByFile, toDef.file, toDef.line + 1);
    if (!toId) continue;
    if (fromId === toId) continue;

    const key = edgeKey(fromId, r.kind, toId);
    const priorExists = existingKeys.has(key);

    ctx.graph.addEdge({
      from: fromId,
      to: toId,
      type: r.kind,
      confidence,
      reason,
    });

    existingKeys.add(key);
    if (priorExists) upgraded += 1;
    else added += 1;
  }
  return { added, upgraded };
}

export type _NodeShape = GraphNode;
