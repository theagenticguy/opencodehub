/**
 * LSP-Python phase — upgrade Python call / reference / heritage edges
 * with compiler-grade resolution from `pyright-langserver`.
 *
 * The phase runs AFTER the tree-sitter heuristic passes (parse, crossFile)
 * and BEFORE `mro`, `communities`, and `dead-code` so the richer edge set
 * is visible to every downstream structural analysis. Its contract:
 *
 *   - OFF by default when a repo has no Python. The scan output's
 *     `profile.languages` is consulted; zero Python → instant `{enabled: false}`.
 *   - OFF when pyright cannot be resolved. The `PyrightClient`'s own
 *     `require.resolve` fallback handles this at start-time; a failed
 *     `start()` degrades to `{enabled: false}` with a one-line warn
 *     ProgressEvent. The tree-sitter baseline graph is still intact.
 *   - OFF when the escape hatch `CODEHUB_DISABLE_LSP=1` is set. Undocumented
 *     in help text — reserved for operators who need to pin the graph shape
 *     to the tree-sitter baseline while debugging pyright regressions.
 *
 * When active, for every Python `Class` / `Method` / `Function` node in
 * the current graph the phase asks pyright three questions:
 *   1. `queryCallers` — who calls this symbol (callHierarchy/incomingCalls,
 *      with a `references` fallback). Produces `CALLS` edges.
 *   2. `queryReferences` — every reference site (type annotations,
 *      imports, attribute reads). Produces `REFERENCES` edges; call-site
 *      references are filtered to avoid duplicating CALLS as REFERENCES.
 *   3. `queryImplementations` — (classes only) subclasses / implementers.
 *      Produces `EXTENDS` edges. Pyright's `textDocument/implementation`
 *      often returns empty; this is best-effort.
 *
 * Each LSP site maps back to an OpenCodeHub node id by the tightest-node
 * strategy — the smallest node whose `filePath` matches and whose
 * `[startLine, endLine]` window contains the LSP-reported line. O(n × m)
 * in the worst case but m is bounded by symbols-per-file and the phase is
 * single-threaded. Sites that don't map inside the repo (stdlib / venv /
 * outside the workspace) are silently dropped.
 *
 * ## Edge dedupe / upgrade semantics
 *
 * `KnowledgeGraph.addEdge` already dedupes by (from, type, to, step) and
 * retains the higher-confidence edge, so simply emitting pyright edges
 * with `confidence: 1.0` produces the "compiler-grade wins over heuristic"
 * rule for free. The phase counts upgrades vs new edges for reporting by
 * snapshotting the edge key set before emission and diffing after.
 *
 * ## Provenance
 *
 * We use the existing `reason` string field on `CodeRelation` as the
 * provenance carrier — no schema change. Format: `"pyright@<version>"`
 * (e.g. `"pyright@1.1.390"`). Version is read once at client start from
 * `require.resolve("pyright/package.json")` and reused per edge.
 *
 * ## Graph-hash determinism
 *
 * Pyright's reference output is stable within a pinned `pyright` npm
 * version but not byte-identical across versions. DO NOT claim
 * graph-hash determinism under this phase. The hashable canonical
 * artifact remains the base tree-sitter graph (i.e., the graph state
 * immediately after `crossFile` and before `lsp-python`). If we need a
 * hashable compiler-augmented graph later, that's a follow-up schema
 * bump where `reason` carries (tool, version) separately.
 *
 * ## Incremental mode
 *
 * When `incremental-scope` reports `mode=incremental`, the phase:
 *   - queries pyright only for symbols whose defining file is in the
 *     closure (LSP is expensive — ~0.08s per query per the spike);
 *   - carries forward every prior-graph edge whose `reason` starts with
 *     `"pyright@"` when BOTH endpoints live outside the closure. This
 *     matches the carry-forward pattern established in `mro.ts` and
 *     `cross-file.ts`. Correctness holds because incremental-scope's
 *     closure already grows by one heritage hop + two import hops, so
 *     any caller of a changed symbol is reprocessed.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GraphNode, NodeId, RelationType } from "@opencodehub/core-types";
import type { CallerSite, ReferenceSite, SymbolKind } from "@opencodehub/lsp-oracle";
import { PyrightClient } from "@opencodehub/lsp-oracle";
import type { PipelineContext, PipelinePhase } from "../types.js";
import { CROSS_FILE_PHASE_NAME } from "./cross-file.js";
import {
  buildFilePathLookup,
  partitionPriorEdges,
  resolveIncrementalView,
} from "./incremental-helper.js";
import { INCREMENTAL_SCOPE_PHASE_NAME } from "./incremental-scope.js";
import { PARSE_PHASE_NAME } from "./parse.js";
import { PROFILE_PHASE_NAME, type ProfileOutput } from "./profile.js";
import { SCAN_PHASE_NAME } from "./scan.js";

export const LSP_PYTHON_PHASE_NAME = "lsp-python";

/** Confidence assigned to every compiler-grade edge emitted by this phase. */
const PYRIGHT_CONFIDENCE = 1.0;

/**
 * Hard ceiling on wall-clock time spent inside the phase. Pyright on
 * sdk-python finishes in under 3 minutes per the spike; we budget 9 to
 * keep the pipeline responsive when the Python subgraph is larger than
 * expected without blowing past the operator-facing "10 minute total
 * pipeline" guidance.
 */
const PHASE_DEADLINE_MS = 9 * 60 * 1000;

/**
 * Cap on pyright warmup wait. The client's own default (15s) is fine for
 * small repos but sdk-python consistently needs ~30s before call-
 * hierarchy starts answering. We pass this through explicitly so sdk-
 * scale repos don't race the deadline.
 */
const INDEX_WAIT_MS = 60_000;

/** Node kinds the phase queries. Everything else is ignored. */
const PYTHON_SYMBOL_KINDS: ReadonlySet<string> = new Set(["Class", "Method", "Function"]);

export interface LspPythonOutput {
  readonly enabled: boolean;
  /** Populated when enabled=false; a human-readable hint for logs. */
  readonly skippedReason?: string;
  /** Populated when enabled=true; resolved from pyright's package.json. */
  readonly pyrightVersion?: string;
  readonly symbolsQueried: number;
  readonly callEdgesAdded: number;
  readonly referenceEdgesAdded: number;
  readonly extendsEdgesAdded: number;
  readonly edgesUpgraded: number;
  readonly durationMs: number;
}

export const lspPythonPhase: PipelinePhase<LspPythonOutput> = {
  name: LSP_PYTHON_PHASE_NAME,
  deps: [
    SCAN_PHASE_NAME,
    PROFILE_PHASE_NAME,
    PARSE_PHASE_NAME,
    CROSS_FILE_PHASE_NAME,
    INCREMENTAL_SCOPE_PHASE_NAME,
  ],
  async run(ctx, deps) {
    return runLspPython(ctx, deps);
  },
};

/**
 * Minimal interface on which the phase depends. `PyrightClient` satisfies
 * this naturally. Exposed ONLY so tests can substitute a mock without
 * spawning a real pyright subprocess — production callers never touch it.
 */
export interface LspClientLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  queryCallers(input: {
    readonly filePath: string;
    readonly line: number;
    readonly character: number;
    readonly symbolKind: SymbolKind;
    readonly symbolName: string;
  }): Promise<readonly CallerSite[]>;
  queryReferences(input: {
    readonly filePath: string;
    readonly line: number;
    readonly character: number;
  }): Promise<readonly ReferenceSite[]>;
  queryImplementations(input: {
    readonly filePath: string;
    readonly line: number;
    readonly character: number;
  }): Promise<
    readonly { readonly file: string; readonly line: number; readonly character: number }[]
  >;
}

export interface LspPythonTestHooks {
  /** Override the pyright client factory (test-only). */
  readonly clientFactory?: (opts: { readonly workspaceRoot: string }) => LspClientLike;
  /** Override the pyright version read (test-only). Return null to force failure. */
  readonly versionReader?: () => string | null;
}

// Module-scoped test hook slot. The phase reads these when present and
// the default phase instance ignores them in production. Tests set and
// unset via the exported `__setLspPythonTestHooks__` helper; they must
// reset in `afterEach` so unrelated tests keep the production path.
let testHooks: LspPythonTestHooks | undefined;
export function __setLspPythonTestHooks__(hooks: LspPythonTestHooks | undefined): void {
  testHooks = hooks;
}

async function runLspPython(
  ctx: PipelineContext,
  deps: ReadonlyMap<string, unknown>,
): Promise<LspPythonOutput> {
  const start = Date.now();

  // ---- Escape hatch -----------------------------------------------------
  if (process.env["CODEHUB_DISABLE_LSP"] === "1") {
    return zeroOutput(start, {
      enabled: false,
      skippedReason: "CODEHUB_DISABLE_LSP=1",
    });
  }

  // ---- Python gate ------------------------------------------------------
  const profile = deps.get(PROFILE_PHASE_NAME) as ProfileOutput | undefined;
  const profileNode = findProfileNode(ctx);
  if (profile === undefined || profileNode === undefined) {
    return zeroOutput(start, {
      enabled: false,
      skippedReason: "no-profile-output",
    });
  }
  if (!profileNode.languages.includes("python")) {
    return zeroOutput(start, {
      enabled: false,
      skippedReason: "no-python-in-profile",
    });
  }

  // ---- Collect Python symbols we want to query --------------------------
  const pythonSymbols = collectPythonSymbols(ctx);
  if (pythonSymbols.length === 0) {
    return zeroOutput(start, {
      enabled: false,
      skippedReason: "no-python-symbols-in-graph",
    });
  }

  // ---- Resolve pyright version BEFORE spawning the client ----------------
  //
  // This doubles as a "is pyright resolvable at all" smoke test. If
  // `require.resolve` fails here we can bail without ever touching a
  // subprocess.
  let pyrightVersion: string;
  try {
    const readVersion = testHooks?.versionReader ?? readPyrightVersion;
    const v = readVersion();
    if (v === null || v === undefined) {
      throw new Error("version reader returned null");
    }
    pyrightVersion = v;
  } catch (err) {
    ctx.onProgress?.({
      phase: LSP_PYTHON_PHASE_NAME,
      kind: "warn",
      message: `lsp-python: pyright not resolvable — skipping (${(err as Error).message})`,
    });
    return zeroOutput(start, {
      enabled: false,
      skippedReason: "pyright-not-resolvable",
    });
  }

  // ---- Incremental view -------------------------------------------------
  const view = resolveIncrementalView(ctx);
  const carriedFromPrior = carryForwardPyrightEdges(ctx, view);

  // Incremental scope narrows which Python symbols we actually query.
  // Symbols outside the closure keep their carried-forward edges; re-
  // querying them would double the work without changing the output.
  const symbolsInScope = view.active
    ? pythonSymbols.filter((s) => view.closure.has(s.filePath))
    : pythonSymbols;

  if (symbolsInScope.length === 0) {
    return {
      enabled: true,
      pyrightVersion,
      symbolsQueried: 0,
      callEdgesAdded: 0,
      referenceEdgesAdded: 0,
      extendsEdgesAdded: 0,
      edgesUpgraded: carriedFromPrior,
      durationMs: Date.now() - start,
    };
  }

  // ---- Start pyright ----------------------------------------------------
  const client: LspClientLike = testHooks?.clientFactory
    ? testHooks.clientFactory({ workspaceRoot: ctx.repoPath })
    : new PyrightClient({
        workspaceRoot: ctx.repoPath,
        indexWaitMs: INDEX_WAIT_MS,
      });
  try {
    await client.start();
  } catch (err) {
    ctx.onProgress?.({
      phase: LSP_PYTHON_PHASE_NAME,
      kind: "warn",
      message: `lsp-python: pyright failed to start — skipping (${(err as Error).message})`,
    });
    // Client may or may not have a live subprocess. `stop()` is safe on a
    // client that never finished starting.
    try {
      await client.stop();
    } catch {
      // ignore — we're already on the degraded path
    }
    return zeroOutput(start, {
      enabled: false,
      skippedReason: "pyright-start-failed",
    });
  }

  // ---- Drive the queries ------------------------------------------------
  const reason = `pyright@${pyrightVersion}`;
  const deadline = start + PHASE_DEADLINE_MS;
  const provenanceIndex = buildProvenanceIndex(ctx);

  let symbolsQueried = 0;
  let callEdgesAdded = 0;
  let referenceEdgesAdded = 0;
  let extendsEdgesAdded = 0;
  let edgesUpgraded = 0;

  // Build the node index once. Maps filePath → array of (symbol nodes
  // sorted by (startLine, endLine)) for the tightest-enclosing-node
  // lookup. Every site returned by pyright drives one lookup, so this
  // lives for the duration of the phase.
  const nodesByFile = indexNodesByFile(ctx);

  // Per-file source cache so we can resolve the 1-indexed column of each
  // symbol name on its header line. Pyright's prepareCallHierarchy is
  // position-sensitive — `character: 1` lands on leading whitespace for
  // any nested `def` / `class`, and pyright returns `[]` for positions
  // that don't cover a symbol token. Reading the header line's text and
  // finding the `<simple_name>` substring yields the correct column.
  const sourceLineCache = new Map<string, readonly string[]>();
  const symbolCharCache = new Map<string, number>();
  function lookupCharacter(sym: SymbolRecord): number {
    const cacheKey = `${sym.filePath}:${sym.startLine}:${sym.qualifiedName}`;
    const cached = symbolCharCache.get(cacheKey);
    if (cached !== undefined) return cached;
    let lines = sourceLineCache.get(sym.filePath);
    if (lines === undefined) {
      try {
        const abs = path.isAbsolute(sym.filePath)
          ? sym.filePath
          : path.join(ctx.repoPath, sym.filePath);
        lines = readFileSync(abs, "utf-8").split(/\r?\n/);
      } catch {
        lines = [];
      }
      sourceLineCache.set(sym.filePath, lines);
    }
    const headerLine = lines[sym.startLine - 1] ?? "";
    const simpleName = sym.qualifiedName.split(".").pop() ?? sym.qualifiedName;
    // Look for `<keyword> <name>` — `def` / `async def` / `class`.
    // Falls back to the first occurrence of `<name>` in the line.
    const patterns = [
      new RegExp(`\\bdef\\s+(${escapeRegex(simpleName)})\\b`),
      new RegExp(`\\bclass\\s+(${escapeRegex(simpleName)})\\b`),
      new RegExp(`\\b(${escapeRegex(simpleName)})\\b`),
    ];
    let col = 1;
    for (const pat of patterns) {
      const m = pat.exec(headerLine);
      if (m?.index !== undefined) {
        // `m.index` points to the keyword. Advance to the captured group.
        col = m.index + m[0].indexOf(simpleName) + 1;
        break;
      }
    }
    symbolCharCache.set(cacheKey, col);
    return col;
  }

  try {
    for (const sym of symbolsInScope) {
      if (Date.now() > deadline) {
        ctx.onProgress?.({
          phase: LSP_PYTHON_PHASE_NAME,
          kind: "warn",
          message: `lsp-python: deadline exceeded after ${symbolsQueried} symbols — stopping early`,
        });
        break;
      }

      // Pyright position queries land on the symbol's identifier TOKEN —
      // not the line start. `character: 1` works only for top-level
      // declarations (column 1 is the `d` of `def` / `c` of `class`);
      // nested methods/classes need the actual identifier column, which
      // `lookupCharacter` recovers from the source. Pyright's
      // prepareCallHierarchy silently returns `[]` for positions that
      // don't cover a symbol token, which is why the naive column=1
      // approach misses 99% of methods — all the 4-space-indented ones.
      const symKind = toLspSymbolKind(sym.kind);
      if (symKind === undefined) continue;
      const character = lookupCharacter(sym);

      const callers = await runSafe(ctx, () =>
        client.queryCallers({
          filePath: sym.filePath,
          line: sym.startLine,
          character,
          symbolKind: symKind,
          symbolName: sym.qualifiedName,
        }),
      );
      const references =
        sym.kind === "Class" || sym.kind === "Method"
          ? await runSafe(ctx, () =>
              client.queryReferences({
                filePath: sym.filePath,
                line: sym.startLine,
                character,
              }),
            )
          : [];
      const implementations =
        sym.kind === "Class"
          ? await runSafe(ctx, () =>
              client.queryImplementations({
                filePath: sym.filePath,
                line: sym.startLine,
                character,
              }),
            )
          : [];

      symbolsQueried += 1;

      // ---- Emit CALLS edges ---------------------------------------------
      const callSiteFingerprints = new Set<string>();
      for (const site of callers ?? []) {
        const fromId = findEnclosingSymbolId(nodesByFile, site.file, site.line);
        if (fromId === undefined) continue;
        if (fromId === sym.id) continue; // skip self-loops — pyright occasionally reports them on mutually recursive hits
        callSiteFingerprints.add(`${site.file}:${site.line}`);
        const stats = upsertEdge(ctx, provenanceIndex, {
          from: fromId,
          to: sym.id,
          type: "CALLS",
          confidence: PYRIGHT_CONFIDENCE,
          reason,
        });
        callEdgesAdded += stats.added;
        edgesUpgraded += stats.upgraded;
      }

      // ---- Emit REFERENCES edges ----------------------------------------
      for (const site of references ?? []) {
        // Skip when this reference was already emitted as a CALLS edge.
        if (callSiteFingerprints.has(`${site.file}:${site.line}`)) continue;
        const fromId = findEnclosingSymbolId(nodesByFile, site.file, site.line);
        if (fromId === undefined) continue;
        if (fromId === sym.id) continue;
        const stats = upsertEdge(ctx, provenanceIndex, {
          from: fromId,
          to: sym.id,
          type: "REFERENCES",
          confidence: PYRIGHT_CONFIDENCE,
          reason,
        });
        referenceEdgesAdded += stats.added;
        edgesUpgraded += stats.upgraded;
      }

      // ---- Emit EXTENDS edges -------------------------------------------
      //
      // `textDocument/implementation` returns IMPLEMENTERS of the class —
      // i.e. subclasses. The OpenCodeHub convention is `EXTENDS: child →
      // parent`, so each implementation site's enclosing class becomes
      // the `from` end and the queried class is `to`.
      for (const site of implementations ?? []) {
        const fromId = findEnclosingSymbolId(nodesByFile, site.file, site.line, new Set(["Class"]));
        if (fromId === undefined) continue;
        if (fromId === sym.id) continue;
        const stats = upsertEdge(ctx, provenanceIndex, {
          from: fromId,
          to: sym.id,
          type: "EXTENDS",
          confidence: PYRIGHT_CONFIDENCE,
          reason,
        });
        extendsEdgesAdded += stats.added;
        edgesUpgraded += stats.upgraded;
      }
    }
  } finally {
    try {
      await client.stop();
    } catch (err) {
      ctx.onProgress?.({
        phase: LSP_PYTHON_PHASE_NAME,
        kind: "warn",
        message: `lsp-python: pyright shutdown error (ignored): ${(err as Error).message}`,
      });
    }
  }

  return {
    enabled: true,
    pyrightVersion,
    symbolsQueried,
    callEdgesAdded,
    referenceEdgesAdded,
    extendsEdgesAdded,
    edgesUpgraded: edgesUpgraded + carriedFromPrior,
    durationMs: Date.now() - start,
  };
}

// ---- Helpers ------------------------------------------------------------

function zeroOutput(
  start: number,
  partial: { enabled: false; skippedReason: string },
): LspPythonOutput {
  return {
    enabled: partial.enabled,
    skippedReason: partial.skippedReason,
    symbolsQueried: 0,
    callEdgesAdded: 0,
    referenceEdgesAdded: 0,
    extendsEdgesAdded: 0,
    edgesUpgraded: 0,
    durationMs: Date.now() - start,
  };
}

function findProfileNode(
  ctx: PipelineContext,
): { readonly languages: readonly string[] } | undefined {
  for (const n of ctx.graph.nodes()) {
    if (n.kind === "ProjectProfile") {
      return { languages: n.languages };
    }
  }
  return undefined;
}

interface SymbolRecord {
  readonly id: NodeId;
  readonly kind: "Class" | "Method" | "Function";
  readonly qualifiedName: string;
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
}

function collectPythonSymbols(ctx: PipelineContext): readonly SymbolRecord[] {
  const out: SymbolRecord[] = [];
  for (const n of ctx.graph.nodes()) {
    if (!PYTHON_SYMBOL_KINDS.has(n.kind)) continue;
    if (!isPythonFile(n.filePath)) continue;
    const startLine = (n as { startLine?: number }).startLine;
    const endLine = (n as { endLine?: number }).endLine;
    if (startLine === undefined || endLine === undefined) continue;
    out.push({
      id: n.id as NodeId,
      kind: n.kind as "Class" | "Method" | "Function",
      qualifiedName: extractQualifiedName(n),
      filePath: n.filePath,
      startLine,
      endLine,
    });
  }
  // Sort for determinism; pyright is order-insensitive but ctx.graph.nodes()
  // iteration order isn't guaranteed stable across Node versions.
  out.sort((a, b) => (a.id as string).localeCompare(b.id as string));
  return out;
}

function isPythonFile(filePath: string): boolean {
  return filePath.endsWith(".py") || filePath.endsWith(".pyi");
}

/**
 * Recover the qualified name from a graph node id. Node ids are encoded as
 * `kind:filePath:qualifiedName(optional-suffixes)`; we take the last segment
 * and strip any trailing suffix. The node's `name` field only holds the
 * simple (unqualified) name, which is insufficient for pyright's
 * constructor-redirect heuristic (needs `Foo.__init__`).
 */
function extractQualifiedName(node: GraphNode): string {
  const id = node.id as string;
  // `makeNodeId` encodes as `<kind>:<filePath>:<qualifiedName>[:<suffix>...]`
  // — split on ":" and reconstruct from the third segment onward, stopping
  // at the first segment that starts with a "(" (the parameter-count suffix).
  const parts = id.split(":");
  if (parts.length < 3) return node.name;
  // `filePath` itself may contain colons on Windows, but our scan phase
  // emits POSIX-style paths so we're safe with simple split semantics.
  // Heuristic: after the `kind:` prefix, the qualified name starts at
  // index 2 and ends at the first segment that looks like a hash or a
  // parameter-count suffix.
  const afterKind = parts.slice(1);
  // Discard the filePath segments (everything before the last "." in the
  // path — e.g. `src/a/b.py` is one filePath segment when POSIX-split
  // doesn't contain colons).
  const fp = node.filePath;
  const afterFile = id.startsWith(`${node.kind}:${fp}:`)
    ? id.slice(node.kind.length + 1 + fp.length + 1)
    : afterKind.join(":");
  // Strip any `(...)` suffix used by makeNodeId for overload disambiguation.
  const firstParen = afterFile.indexOf("(");
  return firstParen >= 0 ? afterFile.slice(0, firstParen) : afterFile;
}

function toLspSymbolKind(kind: string): SymbolKind | undefined {
  switch (kind) {
    case "Class":
      return "class";
    case "Method":
      return "method";
    case "Function":
      return "function";
    case "Property":
      return "property";
    default:
      return undefined;
  }
}

/** Per-file, line-sorted node index for the tightest-enclosing lookup. */
type NodesByFile = ReadonlyMap<string, readonly SymbolRecord[]>;

function indexNodesByFile(ctx: PipelineContext): NodesByFile {
  const map = new Map<string, SymbolRecord[]>();
  for (const n of ctx.graph.nodes()) {
    if (!PYTHON_SYMBOL_KINDS.has(n.kind)) continue;
    if (!isPythonFile(n.filePath)) continue;
    const startLine = (n as { startLine?: number }).startLine;
    const endLine = (n as { endLine?: number }).endLine;
    if (startLine === undefined || endLine === undefined) continue;
    const rec: SymbolRecord = {
      id: n.id as NodeId,
      kind: n.kind as "Class" | "Method" | "Function",
      qualifiedName: extractQualifiedName(n),
      filePath: n.filePath,
      startLine,
      endLine,
    };
    const arr = map.get(n.filePath);
    if (arr === undefined) {
      map.set(n.filePath, [rec]);
    } else {
      arr.push(rec);
    }
  }
  // Sort each file's list by (startLine asc, endLine asc). The tightest
  // enclosing node is the one with the largest startLine <= target that
  // still contains the line; sorting lets us find it via linear scan.
  for (const arr of map.values()) {
    arr.sort((a, b) => {
      if (a.startLine !== b.startLine) return a.startLine - b.startLine;
      return a.endLine - b.endLine;
    });
  }
  return map;
}

/**
 * Find the tightest OpenCodeHub node id that contains (filePath, line).
 * Optionally restrict to a specific set of kinds (used for EXTENDS where
 * we only want Class-enclosing nodes).
 */
function findEnclosingSymbolId(
  nodesByFile: NodesByFile,
  filePath: string,
  line: number,
  restrictKinds?: ReadonlySet<string>,
): NodeId | undefined {
  const candidates = nodesByFile.get(filePath);
  if (candidates === undefined) return undefined;
  let best: SymbolRecord | undefined;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const rec of candidates) {
    if (rec.startLine > line) break; // sorted by startLine, no more candidates can contain `line`
    if (rec.endLine < line) continue;
    if (restrictKinds !== undefined && !restrictKinds.has(rec.kind)) continue;
    const span = rec.endLine - rec.startLine;
    if (span < bestSpan) {
      best = rec;
      bestSpan = span;
    }
  }
  return best?.id;
}

// ---- Edge upsert with provenance tracking -------------------------------

interface ProvenanceEntry {
  readonly confidence: number;
  readonly reason: string | undefined;
}

/**
 * Snapshot of edge confidence + reason BEFORE we start emitting. Used to
 * classify each `addEdge` call as "new" vs "upgraded" for the phase's
 * summary. We can't easily read back from the graph post-emit because
 * `addEdge` mutates in place.
 */
type ProvenanceIndex = Map<string, ProvenanceEntry>;

function buildProvenanceIndex(ctx: PipelineContext): ProvenanceIndex {
  const m = new Map<string, ProvenanceEntry>();
  for (const e of ctx.graph.edges()) {
    m.set(edgeKey(e.from as string, e.type, e.to as string), {
      confidence: e.confidence,
      reason: e.reason,
    });
  }
  return m;
}

function edgeKey(from: string, type: string, to: string): string {
  return `${from}\x00${type}\x00${to}`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function upsertEdge(
  ctx: PipelineContext,
  provenance: ProvenanceIndex,
  edge: {
    readonly from: NodeId;
    readonly to: NodeId;
    readonly type: RelationType;
    readonly confidence: number;
    readonly reason: string;
  },
): { added: number; upgraded: number } {
  const key = edgeKey(edge.from as string, edge.type, edge.to as string);
  const prior = provenance.get(key);
  ctx.graph.addEdge(edge);
  // After addEdge, the graph's dedupe rule keeps the higher-confidence
  // edge. Classify as:
  //   - "added" when we had no prior entry for the key
  //   - "upgraded" when a prior entry existed with lower confidence
  //   - zero when the prior edge had equal or higher confidence (graph
  //     silently retained it)
  if (prior === undefined) {
    provenance.set(key, { confidence: edge.confidence, reason: edge.reason });
    return { added: 1, upgraded: 0 };
  }
  if (prior.confidence < edge.confidence) {
    provenance.set(key, { confidence: edge.confidence, reason: edge.reason });
    return { added: 0, upgraded: 1 };
  }
  return { added: 0, upgraded: 0 };
}

// ---- Incremental carry-forward ------------------------------------------

function carryForwardPyrightEdges(
  ctx: PipelineContext,
  view: ReturnType<typeof resolveIncrementalView>,
): number {
  if (
    !view.active ||
    view.previousGraph?.nodes === undefined ||
    view.previousGraph.edges === undefined
  ) {
    return 0;
  }

  // Consider only edges whose provenance identifies pyright. Any other
  // reason string means the edge was emitted by a different phase (parse,
  // crossFile, mro) and those phases run their own carry-forward logic.
  const filePathByNodeId = buildFilePathLookup(view.previousGraph.nodes);
  const carriedCandidates = partitionPriorEdges(
    view.previousGraph.edges,
    filePathByNodeId,
    view.closure,
    new Set<string>(["CALLS", "REFERENCES", "EXTENDS"]),
  );
  let carried = 0;
  for (const e of carriedCandidates) {
    if (e.reason === undefined || !e.reason.startsWith("pyright@")) continue;
    ctx.graph.addEdge({
      from: e.from,
      to: e.to,
      type: e.type,
      confidence: e.confidence,
      reason: e.reason,
    });
    carried += 1;
  }
  return carried;
}

// ---- Pyright version resolution -----------------------------------------

function readPyrightVersion(): string {
  // pyright is a dependency of @opencodehub/lsp-oracle, not of
  // @opencodehub/ingestion directly, AND lsp-oracle's exports map does
  // NOT expose `package.json` — so the naive `require.resolve` paths
  // fail with ERR_PACKAGE_PATH_NOT_EXPORTED.
  //
  // Node 20.6+ ships `import.meta.resolve` synchronously, which bypasses
  // the CJS exports restriction because it's an ESM resolver. We use it
  // to locate the lsp-oracle entry module, then hop two levels from
  // there (entry → pyright/package.json) through a `createRequire` that
  // IS scoped to lsp-oracle's own node_modules tree. This mirrors the
  // resolution `PyrightClient` performs for the langserver binary, so a
  // success here guarantees `PyrightClient.start()` will find the
  // binary as well.
  //
  // If lsp-oracle or pyright is truly missing we throw here; the caller
  // catches and degrades to `enabled: false`.
  const lspOracleEntryUrl = import.meta.resolve("@opencodehub/lsp-oracle");
  const lspOracleEntryPath = fileURLToPath(lspOracleEntryUrl);
  const innerRequire = createRequire(lspOracleEntryPath);
  const pyrightPkgPath = innerRequire.resolve("pyright/package.json");
  const raw = readFileSync(pyrightPkgPath, "utf-8");
  const pkg = JSON.parse(raw) as { version?: unknown };
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error("pyright/package.json has no version field");
  }
  return pkg.version;
}

// ---- runSafe: narrow the exception surface of per-symbol queries --------

/**
 * Run an async LSP query with a single-symbol exception boundary. Pyright
 * occasionally throws on pathological symbols (empty file, encoding
 * errors). We downgrade the failure to an empty result + a warn event so
 * one bad symbol doesn't abort the whole phase.
 */
async function runSafe<T>(
  ctx: PipelineContext,
  fn: () => Promise<readonly T[]>,
): Promise<readonly T[]> {
  try {
    return await fn();
  } catch (err) {
    ctx.onProgress?.({
      phase: LSP_PYTHON_PHASE_NAME,
      kind: "warn",
      message: `lsp-python: query failed (ignored): ${(err as Error).message}`,
    });
    return [];
  }
}

// Keep these imports in the emitted .d.ts so downstream consumers can
// type-check against the phase's CallerSite / ReferenceSite shape without
// depending on lsp-oracle directly.
export type LspCallerSite = CallerSite;
export type LspReferenceSite = ReferenceSite;
