// rust-analyzer client defaults `procMacro.enable=false`; serde/tokio derive-generated refs will be missing. Flipping requires toolchain pin discipline.
/**
 * LSP-Rust phase — upgrade Rust call / reference / implementation edges
 * with compiler-grade resolution from `rust-analyzer`.
 *
 * Mirrors the contract of `lsp-python.ts`:
 *
 *   - OFF by default when a repo has no Rust. The scan output's
 *     `profile.languages` is consulted; zero Rust → instant `{enabled: false}`.
 *   - OFF when rust-analyzer is not on PATH. `RustAnalyzerClient.start()`
 *     throws a clear "not on PATH" error in that case; we degrade to
 *     `{enabled: false}` with a one-line warn ProgressEvent and leave the
 *     tree-sitter baseline graph intact.
 *   - OFF when the escape hatch `CODEHUB_DISABLE_LSP=1` is set.
 *
 * When active, for every Rust `Class` / `Method` / `Function` node the
 * phase asks rust-analyzer three questions:
 *   1. `queryCallers` — `textDocument/prepareCallHierarchy` +
 *      `callHierarchy/incomingCalls` (with a references fallback baked
 *      into `BaseLspClient`). Produces `CALLS` edges.
 *   2. `queryReferences` — `textDocument/references` for every reference
 *      site. Produces `REFERENCES` edges; call-site references are filtered
 *      to avoid duplicating CALLS as REFERENCES.
 *   3. `queryImplementations` — (classes only) `textDocument/implementation`.
 *      In Rust, `Class`-kind nodes stand in for `struct` / `enum` / `trait`
 *      definitions; implementers are `impl` blocks for the type or
 *      `impl Trait for Type` sites. Produces `EXTENDS` edges.
 *
 * ## Identifier column lookup
 *
 * rust-analyzer's call-hierarchy is position-sensitive: the request must
 * land on the identifier TOKEN, not the start of the line. We recover the
 * column of the simple name by scanning the symbol's header line for the
 * Rust item keyword. The regex tolerates visibility prefixes (`pub`,
 * `pub(crate)`, `pub(super)`, `pub(in path)`) and the `async` / `unsafe` /
 * `extern [ABI]` modifiers, across these item keywords:
 * `fn`, `struct`, `enum`, `trait`, `impl`, `mod`, `const`, `static`, `type`.
 * `impl Trait for Type` is supported — the regex's `<name>` capture grabs
 * the trait name when the line starts with `impl <Trait> for <Type>`; a
 * separate fallback resolves to the first occurrence of the simple name.
 *
 * ## Warmup
 *
 * rust-analyzer's `initialize` response arrives long before the symbol
 * cache is primed. Without `warmup()` the first `textDocument/references`
 * query returns empty or partial results. After `client.start()` we call
 * `client.warmup(120_000)` — resolves when the cachePriming END
 * notification arrives, rejects after 120s (network / cargo failure).
 *
 * ## Provenance
 *
 * Each LSP-sourced edge carries `reason: "rust-analyzer@<version>"`, read
 * from `client.getStatus().rustAnalyzerVersion`. When the version probe
 * could not parse `--version` output (e.g. a corrupt install), we fall
 * back to `"rust-analyzer@unknown"` rather than dropping the provenance.
 *
 * ## Proc-macro tradeoff
 *
 * `RustAnalyzerClient` sets `procMacro.enable=false` by default. Derive-
 * and attribute-macro-synthesized code (serde `Serialize::serialize`
 * impls, tokio `#[tokio::main]`, etc.) is opaque to rust-analyzer under
 * that default. Flipping proc-macros on requires that the ingestion host's
 * rustc matches the project's `rust-toolchain` pin — we accept the lossy-
 * but-stable default here.
 *
 * ## No constructor redirect
 *
 * Rust has no constructors. `Foo::new(..)` is a plain associated-function
 * call and rust-analyzer already resolves it directly to the `fn new`
 * item. Unlike the Python phase we issue no special redirect.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { GraphNode, NodeId, RelationType } from "@opencodehub/core-types";
import type { CallerSite, ReferenceSite, SymbolKind } from "@opencodehub/lsp-oracle";
import { RustAnalyzerClient } from "@opencodehub/lsp-oracle";
import type { PipelineContext, PipelinePhase } from "../types.js";
import { CROSS_FILE_PHASE_NAME } from "./cross-file.js";
import {
  buildFilePathLookup,
  partitionPriorEdges,
  resolveIncrementalView,
} from "./incremental-helper.js";
import { INCREMENTAL_SCOPE_PHASE_NAME } from "./incremental-scope.js";
import { LSP_GO_PHASE_NAME } from "./lsp-go.js";
import { PARSE_PHASE_NAME } from "./parse.js";
import { PROFILE_PHASE_NAME, type ProfileOutput } from "./profile.js";
import { SCAN_PHASE_NAME } from "./scan.js";

export const LSP_RUST_PHASE_NAME = "lsp-rust";

/** Confidence assigned to every compiler-grade edge emitted by this phase. */
const RUST_ANALYZER_CONFIDENCE = 1.0;

/**
 * Hard ceiling on wall-clock time spent inside the phase. rust-analyzer
 * is the slowest of our LSP servers (cargo metadata + cachePriming); we
 * reuse the same 9-minute budget the Python phase uses so the pipeline
 * stays within the operator-facing 10-minute guidance.
 */
const PHASE_DEADLINE_MS = 9 * 60 * 1000;

/**
 * Base-class indexingEnd wait. rust-analyzer's real "ready" signal is the
 * cachePriming END handled by `warmup()`, but we still want the base
 * initialize / initialized dance to be generous on large workspaces.
 */
const INDEX_WAIT_MS = 60_000;

/**
 * Warmup timeout for cache priming. rust-analyzer's own default (120s)
 * matches what rustc's first metadata pass takes on a cold cargo cache;
 * we pass it explicitly so intent is visible at the call site.
 */
const WARMUP_TIMEOUT_MS = 120_000;

/** Node kinds the phase queries. Everything else is ignored. */
const RUST_SYMBOL_KINDS: ReadonlySet<string> = new Set(["Class", "Method", "Function"]);

export interface LspRustOutput {
  readonly enabled: boolean;
  /** Populated when enabled=false; a human-readable hint for logs. */
  readonly skippedReason?: string;
  /** Populated when enabled=true; resolved from `rust-analyzer --version`. */
  readonly rustAnalyzerVersion?: string;
  readonly symbolsQueried: number;
  readonly callEdgesAdded: number;
  readonly referenceEdgesAdded: number;
  readonly extendsEdgesAdded: number;
  readonly edgesUpgraded: number;
  readonly durationMs: number;
}

export const lspRustPhase: PipelinePhase<LspRustOutput> = {
  name: LSP_RUST_PHASE_NAME,
  deps: [
    SCAN_PHASE_NAME,
    PROFILE_PHASE_NAME,
    PARSE_PHASE_NAME,
    CROSS_FILE_PHASE_NAME,
    INCREMENTAL_SCOPE_PHASE_NAME,
    // Sequence after `lsp-go` so the runtime phase order pins to
    // `python → typescript → go → rust` regardless of Kahn's alphabetic
    // tiebreak. Functionally lsp-rust does not read lsp-go's output —
    // the dep is purely an ordering constraint.
    LSP_GO_PHASE_NAME,
  ],
  async run(ctx, deps) {
    return runLspRust(ctx, deps);
  },
};

/**
 * Minimal interface on which the phase depends. `RustAnalyzerClient`
 * satisfies this naturally. Exposed ONLY so tests can substitute a mock
 * without spawning a real rust-analyzer subprocess.
 */
export interface LspClientLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  warmup(timeoutMs?: number): Promise<void>;
  getStatus(): { readonly rustAnalyzerVersion: string | null };
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

export interface LspRustTestHooks {
  /** Override the rust-analyzer client factory (test-only). */
  readonly clientFactory?: (opts: { readonly workspaceRoot: string }) => LspClientLike;
}

// Module-scoped test hook slot. Identical contract to `lsp-python.ts`.
let testHooks: LspRustTestHooks | undefined;
export function __setLspRustTestHooks__(hooks: LspRustTestHooks | undefined): void {
  testHooks = hooks;
}

async function runLspRust(
  ctx: PipelineContext,
  deps: ReadonlyMap<string, unknown>,
): Promise<LspRustOutput> {
  const start = Date.now();

  // ---- Escape hatch -----------------------------------------------------
  if (process.env["CODEHUB_DISABLE_LSP"] === "1") {
    return zeroOutput(start, {
      enabled: false,
      skippedReason: "CODEHUB_DISABLE_LSP=1",
    });
  }

  // ---- Rust gate --------------------------------------------------------
  const profile = deps.get(PROFILE_PHASE_NAME) as ProfileOutput | undefined;
  const profileNode = findProfileNode(ctx);
  if (profile === undefined || profileNode === undefined) {
    return zeroOutput(start, {
      enabled: false,
      skippedReason: "no-profile-output",
    });
  }
  if (!profileNode.languages.includes("rust")) {
    return zeroOutput(start, {
      enabled: false,
      skippedReason: "no-rust-in-profile",
    });
  }

  // ---- Collect Rust symbols we want to query ----------------------------
  const rustSymbols = collectRustSymbols(ctx);
  if (rustSymbols.length === 0) {
    return zeroOutput(start, {
      enabled: false,
      skippedReason: "no-rust-symbols-in-graph",
    });
  }

  // ---- Incremental view -------------------------------------------------
  const view = resolveIncrementalView(ctx);
  const carriedFromPrior = carryForwardRustAnalyzerEdges(ctx, view);

  const symbolsInScope = view.active
    ? rustSymbols.filter((s) => view.closure.has(s.filePath))
    : rustSymbols;

  // ---- Start rust-analyzer ----------------------------------------------
  const client: LspClientLike = testHooks?.clientFactory
    ? testHooks.clientFactory({ workspaceRoot: ctx.repoPath })
    : new RustAnalyzerClient({
        workspaceRoot: ctx.repoPath,
        indexWaitMs: INDEX_WAIT_MS,
      });
  try {
    await client.start();
  } catch (err) {
    ctx.onProgress?.({
      phase: LSP_RUST_PHASE_NAME,
      kind: "warn",
      message: `lsp-rust: rust-analyzer failed to start — skipping (${(err as Error).message})`,
    });
    try {
      await client.stop();
    } catch {
      // ignore — we're already on the degraded path
    }
    return zeroOutput(start, {
      enabled: false,
      skippedReason: "rust-analyzer-start-failed",
    });
  }

  // ---- Warmup (REQUIRED for rust-analyzer) ------------------------------
  //
  // Without this, the first `textDocument/references` query against a
  // cold rust-analyzer returns empty results. We budget 120s, matching
  // cargo's first-metadata worst case.
  try {
    await client.warmup(WARMUP_TIMEOUT_MS);
  } catch (err) {
    ctx.onProgress?.({
      phase: LSP_RUST_PHASE_NAME,
      kind: "warn",
      message: `lsp-rust: warmup failed — skipping (${(err as Error).message})`,
    });
    try {
      await client.stop();
    } catch {
      // ignore
    }
    return zeroOutput(start, {
      enabled: false,
      skippedReason: "rust-analyzer-warmup-failed",
    });
  }

  // ---- Resolve rust-analyzer version ------------------------------------
  //
  // `getStatus().rustAnalyzerVersion` is populated by the client's
  // `--version` probe. A null value means the probe failed (mock server,
  // custom build without `--version` support); we fall back to "unknown"
  // so every edge still carries provenance rather than an empty reason.
  const rustAnalyzerVersion = client.getStatus().rustAnalyzerVersion ?? "unknown";

  if (symbolsInScope.length === 0) {
    try {
      await client.stop();
    } catch {
      // ignore
    }
    return {
      enabled: true,
      rustAnalyzerVersion,
      symbolsQueried: 0,
      callEdgesAdded: 0,
      referenceEdgesAdded: 0,
      extendsEdgesAdded: 0,
      edgesUpgraded: carriedFromPrior,
      durationMs: Date.now() - start,
    };
  }

  // ---- Drive the queries ------------------------------------------------
  const reason = `rust-analyzer@${rustAnalyzerVersion}`;
  const deadline = start + PHASE_DEADLINE_MS;
  const provenanceIndex = buildProvenanceIndex(ctx);

  let symbolsQueried = 0;
  let callEdgesAdded = 0;
  let referenceEdgesAdded = 0;
  let extendsEdgesAdded = 0;
  let edgesUpgraded = 0;

  const nodesByFile = indexNodesByFile(ctx);

  // Per-file source cache + per-symbol identifier column cache. Rust's
  // prepareCallHierarchy is position-sensitive: the request must land
  // on the identifier token.
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
    const simpleName = sym.qualifiedName.split(/[.:]/).pop() ?? sym.qualifiedName;
    const col = findRustIdentifierColumn(headerLine, simpleName);
    symbolCharCache.set(cacheKey, col);
    return col;
  }

  try {
    for (const sym of symbolsInScope) {
      if (Date.now() > deadline) {
        ctx.onProgress?.({
          phase: LSP_RUST_PHASE_NAME,
          kind: "warn",
          message: `lsp-rust: deadline exceeded after ${symbolsQueried} symbols — stopping early`,
        });
        break;
      }

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
        if (fromId === sym.id) continue; // skip self-loops on recursive hits
        callSiteFingerprints.add(`${site.file}:${site.line}`);
        const stats = upsertEdge(ctx, provenanceIndex, {
          from: fromId,
          to: sym.id,
          type: "CALLS",
          confidence: RUST_ANALYZER_CONFIDENCE,
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
          confidence: RUST_ANALYZER_CONFIDENCE,
          reason,
        });
        referenceEdgesAdded += stats.added;
        edgesUpgraded += stats.upgraded;
      }

      // ---- Emit EXTENDS edges -------------------------------------------
      //
      // rust-analyzer's `textDocument/implementation` on a trait returns
      // `impl Trait for Type` sites; on a struct / enum it returns
      // `impl Type` blocks. We emit EXTENDS from the enclosing Class-kind
      // node of the impl site to the queried symbol — matching the Python
      // convention where child → parent is the edge direction.
      for (const site of implementations ?? []) {
        const fromId = findEnclosingSymbolId(nodesByFile, site.file, site.line, new Set(["Class"]));
        if (fromId === undefined) continue;
        if (fromId === sym.id) continue;
        const stats = upsertEdge(ctx, provenanceIndex, {
          from: fromId,
          to: sym.id,
          type: "EXTENDS",
          confidence: RUST_ANALYZER_CONFIDENCE,
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
        phase: LSP_RUST_PHASE_NAME,
        kind: "warn",
        message: `lsp-rust: rust-analyzer shutdown error (ignored): ${(err as Error).message}`,
      });
    }
  }

  return {
    enabled: true,
    rustAnalyzerVersion,
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
): LspRustOutput {
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

function collectRustSymbols(ctx: PipelineContext): readonly SymbolRecord[] {
  const out: SymbolRecord[] = [];
  for (const n of ctx.graph.nodes()) {
    if (!RUST_SYMBOL_KINDS.has(n.kind)) continue;
    if (!isRustFile(n.filePath)) continue;
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
  out.sort((a, b) => (a.id as string).localeCompare(b.id as string));
  return out;
}

function isRustFile(filePath: string): boolean {
  return filePath.endsWith(".rs");
}

/**
 * Recover the qualified name from a graph node id. Node ids are encoded
 * as `kind:filePath:qualifiedName(optional-suffixes)`; we strip the
 * `kind:filePath:` prefix and any trailing `(...)` parameter-count suffix.
 * Mirrors the same logic as `lsp-python.ts`.
 */
function extractQualifiedName(node: GraphNode): string {
  const id = node.id as string;
  const fp = node.filePath;
  const afterFile = id.startsWith(`${node.kind}:${fp}:`)
    ? id.slice(node.kind.length + 1 + fp.length + 1)
    : id.split(":").slice(1).join(":");
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

type NodesByFile = ReadonlyMap<string, readonly SymbolRecord[]>;

function indexNodesByFile(ctx: PipelineContext): NodesByFile {
  const map = new Map<string, SymbolRecord[]>();
  for (const n of ctx.graph.nodes()) {
    if (!RUST_SYMBOL_KINDS.has(n.kind)) continue;
    if (!isRustFile(n.filePath)) continue;
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
  for (const arr of map.values()) {
    arr.sort((a, b) => {
      if (a.startLine !== b.startLine) return a.startLine - b.startLine;
      return a.endLine - b.endLine;
    });
  }
  return map;
}

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
    if (rec.startLine > line) break;
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

function carryForwardRustAnalyzerEdges(
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
  const filePathByNodeId = buildFilePathLookup(view.previousGraph.nodes);
  const carriedCandidates = partitionPriorEdges(
    view.previousGraph.edges,
    filePathByNodeId,
    view.closure,
    new Set<string>(["CALLS", "REFERENCES", "EXTENDS"]),
  );
  let carried = 0;
  for (const e of carriedCandidates) {
    if (e.reason === undefined || !e.reason.startsWith("rust-analyzer@")) continue;
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

// ---- Rust identifier column lookup --------------------------------------

/**
 * Regex cache for the Rust item-declaration lookup. Keyed by the simple
 * name so we compile one regex per unique identifier even if we hit the
 * same name on many header lines. Module-scoped so the cache spans a
 * whole phase run.
 */
const rustIdentifierRegexCache = new Map<string, RegExp>();

/**
 * Find the 1-indexed column of a Rust identifier on its header line.
 *
 * Tolerates:
 *   - Visibility prefixes: `pub`, `pub(crate)`, `pub(super)`, `pub(in path)`.
 *   - Modifiers: `async`, `unsafe`, `extern`, `extern "C"`, `extern "Rust"`.
 *   - Item keywords: `fn`, `struct`, `enum`, `trait`, `impl`, `mod`,
 *     `const`, `static`, `type`.
 *
 * `impl Trait for Type` lines are supported — the regex matches
 * `impl <name>` which captures the trait name first. For inherent
 * `impl Type` lines the captured name is the type itself. When neither
 * pattern matches, falls back to the first word-boundary match of
 * `<name>` on the line. Returns 1 when nothing matches.
 */
export function findRustIdentifierColumn(headerLine: string, simpleName: string): number {
  const keywordRe = getKeywordRegex(simpleName);
  const m = keywordRe.exec(headerLine);
  if (m?.index !== undefined) {
    const nameOffsetInMatch = m[0].lastIndexOf(simpleName);
    if (nameOffsetInMatch >= 0) {
      return m.index + nameOffsetInMatch + 1;
    }
  }
  // Fallback: first word-boundary occurrence of the simple name.
  const fallback = new RegExp(`(^|[^A-Za-z0-9_])(${escapeRegex(simpleName)})(?![A-Za-z0-9_])`);
  const fm = fallback.exec(headerLine);
  if (fm?.index !== undefined) {
    const nameOffsetInMatch = fm[0].lastIndexOf(simpleName);
    if (nameOffsetInMatch >= 0) {
      return fm.index + nameOffsetInMatch + 1;
    }
  }
  return 1;
}

function getKeywordRegex(simpleName: string): RegExp {
  const cached = rustIdentifierRegexCache.get(simpleName);
  if (cached !== undefined) return cached;
  const name = escapeRegex(simpleName);
  // Visibility prefix (optional): `pub`, `pub(crate)`, `pub(super)`,
  // `pub(in some::path)`.
  const visibility = String.raw`(?:pub(?:\([^)]*\))?\s+)?`;
  // Modifiers (any order, zero or more): `async`, `unsafe`,
  // `extern`, `extern "C"`.
  const modifier = String.raw`(?:(?:async|unsafe|extern(?:\s+"[^"]+")?)\s+)*`;
  // Item keywords that introduce a named Rust item.
  const keyword = "(?:fn|struct|enum|trait|impl|mod|const|static|type)";
  const re = new RegExp(
    `(?:^|[^A-Za-z0-9_])${visibility}${modifier}${keyword}${String.raw`\s+`}${name}(?![A-Za-z0-9_])`,
  );
  rustIdentifierRegexCache.set(simpleName, re);
  return re;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---- runSafe: narrow the exception surface of per-symbol queries --------

async function runSafe<T>(
  ctx: PipelineContext,
  fn: () => Promise<readonly T[]>,
): Promise<readonly T[]> {
  try {
    return await fn();
  } catch (err) {
    ctx.onProgress?.({
      phase: LSP_RUST_PHASE_NAME,
      kind: "warn",
      message: `lsp-rust: query failed (ignored): ${(err as Error).message}`,
    });
    return [];
  }
}

// Keep these imports in the emitted .d.ts so downstream consumers can
// type-check against the phase's CallerSite / ReferenceSite shape without
// depending on lsp-oracle directly.
export type LspCallerSite = CallerSite;
export type LspReferenceSite = ReferenceSite;
