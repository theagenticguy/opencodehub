/**
 * LSP-TypeScript phase — upgrade TS / TSX / JS / JSX call / reference /
 * heritage edges with compiler-grade resolution from
 * `typescript-language-server` driving tsserver.
 *
 * Structure mirrors `lsp-python.ts`. Three differences worth calling out:
 *
 *   1. **Warmup is mandatory.** tsserver does NOT auto-index the workspace;
 *      cross-file `textDocument/references` and
 *      `callHierarchy/incomingCalls` only resolve against URIs that the
 *      client has explicitly `didOpen`ed. Before the first query we call
 *      `client.warmup(files)` with every TS/TSX/JS/JSX file from the scan
 *      output.
 *
 *   2. **Per-file language-ID routing lives in the client.** The phase
 *      never passes a `languageId` per call; `TypeScriptClient.ensureOpen`
 *      classifies each path (`.ts`/`.mts`/`.cts` → `typescript`, `.tsx` →
 *      `typescriptreact`, `.js`/`.mjs`/`.cjs` → `javascript`, `.jsx` →
 *      `javascriptreact`).
 *
 *   3. **No constructor redirect.** TypeScript's `constructor` is a named
 *      method that tsserver resolves directly; we use the base client's
 *      default `queryCallers` without the pyright-style __init__ hop.
 *
 * Provenance: edges are emitted with `confidence: 1.0` and
 * `reason: "typescript-language-server@<version>"`. Version is read from
 * `client.getStatus().tsserverVersion`; the client resolves it once at
 * construction time from the pinned `typescript-language-server` package.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { GraphNode, NodeId, RelationType } from "@opencodehub/core-types";
import type { CallerSite, ReferenceSite, SymbolKind } from "@opencodehub/lsp-oracle";
import { TypeScriptClient } from "@opencodehub/lsp-oracle";
import type { PipelineContext, PipelinePhase } from "../types.js";
import { CROSS_FILE_PHASE_NAME } from "./cross-file.js";
import {
  buildFilePathLookup,
  partitionPriorEdges,
  resolveIncrementalView,
} from "./incremental-helper.js";
import { INCREMENTAL_SCOPE_PHASE_NAME } from "./incremental-scope.js";
import { LSP_PYTHON_PHASE_NAME } from "./lsp-python.js";
import { PARSE_PHASE_NAME } from "./parse.js";
import { PROFILE_PHASE_NAME, type ProfileOutput } from "./profile.js";
import { SCAN_PHASE_NAME, type ScanOutput } from "./scan.js";

export const LSP_TYPESCRIPT_PHASE_NAME = "lsp-typescript";

/** Confidence assigned to every compiler-grade edge emitted by this phase. */
const TS_CONFIDENCE = 1.0;

/**
 * Hard ceiling on wall-clock time spent inside the phase. Mirrors the
 * pyright budget; tsserver is comparable in per-query latency on typical
 * repos once warmup completes.
 */
const PHASE_DEADLINE_MS = 9 * 60 * 1000;

/**
 * Cap on tsserver warmup wait. tsserver's project-loading step is
 * proportional to the transitive closure of `.ts` files; 60 s handles
 * medium monorepos without blowing past the deadline.
 */
const INDEX_WAIT_MS = 60_000;

/** Node kinds the phase queries. Everything else is ignored. */
const TS_SYMBOL_KINDS: ReadonlySet<string> = new Set(["Class", "Interface", "Method", "Function"]);

/** File extensions the phase owns. */
const TS_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".d.ts",
]);

/**
 * Profile-language keys that trigger the phase. The ProjectProfile schema
 * collapses `tsx` into `typescript` (see `profile-detectors/languages.ts`),
 * so the enum values we see here are `typescript` and `javascript` —
 * never `typescriptreact` / `javascriptreact` — but we accept both forms
 * defensively in case a custom profile emitter writes the richer keys.
 */
const TS_PROFILE_LANGUAGES: ReadonlySet<string> = new Set([
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
]);

export interface LspTypescriptOutput {
  readonly enabled: boolean;
  readonly skippedReason?: string;
  readonly tsserverVersion?: string;
  readonly symbolsQueried: number;
  readonly callEdgesAdded: number;
  readonly referenceEdgesAdded: number;
  readonly extendsEdgesAdded: number;
  readonly edgesUpgraded: number;
  readonly durationMs: number;
}

export const lspTypescriptPhase: PipelinePhase<LspTypescriptOutput> = {
  name: LSP_TYPESCRIPT_PHASE_NAME,
  deps: [
    SCAN_PHASE_NAME,
    PROFILE_PHASE_NAME,
    PARSE_PHASE_NAME,
    CROSS_FILE_PHASE_NAME,
    INCREMENTAL_SCOPE_PHASE_NAME,
    // Sequence after `lsp-python` so the runtime phase order pins to
    // `python → typescript → go → rust` regardless of Kahn's alphabetic
    // tiebreak. Functionally lsp-typescript does not read lsp-python's
    // output — the dep is purely an ordering constraint.
    LSP_PYTHON_PHASE_NAME,
  ],
  async run(ctx, deps) {
    return runLspTypescript(ctx, deps);
  },
};

/**
 * Minimal interface on which the phase depends. `TypeScriptClient`
 * satisfies this naturally. Exposed ONLY so tests can substitute a mock
 * without spawning tsserver.
 */
export interface LspTypescriptClientLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  warmup(files: readonly string[]): Promise<void>;
  getStatus(): { readonly tsserverVersion: string };
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

export interface LspTypescriptTestHooks {
  readonly clientFactory?: (opts: { readonly workspaceRoot: string }) => LspTypescriptClientLike;
}

let testHooks: LspTypescriptTestHooks | undefined;
export function __setLspTypescriptTestHooks__(hooks: LspTypescriptTestHooks | undefined): void {
  testHooks = hooks;
}

async function runLspTypescript(
  ctx: PipelineContext,
  deps: ReadonlyMap<string, unknown>,
): Promise<LspTypescriptOutput> {
  const start = Date.now();

  // ---- Escape hatch -----------------------------------------------------
  if (process.env["CODEHUB_DISABLE_LSP"] === "1") {
    return zeroOutput(start, {
      enabled: false,
      skippedReason: "CODEHUB_DISABLE_LSP=1",
    });
  }

  // ---- TS gate ----------------------------------------------------------
  const profile = deps.get(PROFILE_PHASE_NAME) as ProfileOutput | undefined;
  const profileNode = findProfileNode(ctx);
  if (profile === undefined || profileNode === undefined) {
    return zeroOutput(start, {
      enabled: false,
      skippedReason: "no-profile-output",
    });
  }
  const hasTs = profileNode.languages.some((l) => TS_PROFILE_LANGUAGES.has(l));
  if (!hasTs) {
    return zeroOutput(start, {
      enabled: false,
      skippedReason: "no-typescript-in-profile",
    });
  }

  // ---- Collect TS symbols we want to query ------------------------------
  const tsSymbols = collectTsSymbols(ctx);
  if (tsSymbols.length === 0) {
    return zeroOutput(start, {
      enabled: false,
      skippedReason: "no-typescript-symbols-in-graph",
    });
  }

  // ---- Incremental view -------------------------------------------------
  const view = resolveIncrementalView(ctx);
  const carriedFromPrior = carryForwardTsEdges(ctx, view);

  const symbolsInScope = view.active
    ? tsSymbols.filter((s) => view.closure.has(s.filePath))
    : tsSymbols;

  if (symbolsInScope.length === 0) {
    return {
      enabled: true,
      symbolsQueried: 0,
      callEdgesAdded: 0,
      referenceEdgesAdded: 0,
      extendsEdgesAdded: 0,
      edgesUpgraded: carriedFromPrior,
      durationMs: Date.now() - start,
    };
  }

  // ---- Start tsserver ---------------------------------------------------
  const client: LspTypescriptClientLike = testHooks?.clientFactory
    ? testHooks.clientFactory({ workspaceRoot: ctx.repoPath })
    : new TypeScriptClient({
        workspaceRoot: ctx.repoPath,
        indexWaitMs: INDEX_WAIT_MS,
      });
  try {
    await client.start();
  } catch (err) {
    ctx.onProgress?.({
      phase: LSP_TYPESCRIPT_PHASE_NAME,
      kind: "warn",
      message: `lsp-typescript: tsserver failed to start — skipping (${(err as Error).message})`,
    });
    try {
      await client.stop();
    } catch {
      // ignore — we're already on the degraded path
    }
    return zeroOutput(start, {
      enabled: false,
      skippedReason: "tsserver-start-failed",
    });
  }

  // ---- Warmup -----------------------------------------------------------
  //
  // tsserver does not auto-index the workspace. We prime it with every
  // TS/TSX/JS/JSX file from the scan output; once warmup returns,
  // cross-file queries resolve correctly.
  const warmupFiles = collectWarmupFiles(ctx, deps);
  try {
    await client.warmup(warmupFiles);
  } catch (err) {
    ctx.onProgress?.({
      phase: LSP_TYPESCRIPT_PHASE_NAME,
      kind: "warn",
      message: `lsp-typescript: warmup failed — continuing (${(err as Error).message})`,
    });
  }

  // ---- Resolve tsserver version (post-start) ----------------------------
  let tsserverVersion: string;
  try {
    const status = client.getStatus();
    tsserverVersion = status.tsserverVersion;
  } catch {
    tsserverVersion = "";
  }
  const reason =
    tsserverVersion.length > 0
      ? `typescript-language-server@${tsserverVersion}`
      : "typescript-language-server";

  // ---- Drive the queries ------------------------------------------------
  const deadline = start + PHASE_DEADLINE_MS;
  const provenanceIndex = buildProvenanceIndex(ctx);

  let symbolsQueried = 0;
  let callEdgesAdded = 0;
  let referenceEdgesAdded = 0;
  let extendsEdgesAdded = 0;
  let edgesUpgraded = 0;

  const nodesByFile = indexNodesByFile(ctx);

  // Per-file source cache for identifier-column lookup. tsserver is
  // position-sensitive — column=1 lands on leading whitespace for any
  // nested declaration and tsserver returns `[]` for positions that
  // don't cover a symbol token.
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
    const col = findIdentifierColumn(headerLine, simpleName);
    symbolCharCache.set(cacheKey, col);
    return col;
  }

  try {
    for (const sym of symbolsInScope) {
      if (Date.now() > deadline) {
        ctx.onProgress?.({
          phase: LSP_TYPESCRIPT_PHASE_NAME,
          kind: "warn",
          message: `lsp-typescript: deadline exceeded after ${symbolsQueried} symbols — stopping early`,
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
        sym.kind === "Class" || sym.kind === "Interface" || sym.kind === "Method"
          ? await runSafe(ctx, () =>
              client.queryReferences({
                filePath: sym.filePath,
                line: sym.startLine,
                character,
              }),
            )
          : [];
      const implementations =
        sym.kind === "Class" || sym.kind === "Interface"
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
        if (fromId === sym.id) continue;
        callSiteFingerprints.add(`${site.file}:${site.line}`);
        const stats = upsertEdge(ctx, provenanceIndex, {
          from: fromId,
          to: sym.id,
          type: "CALLS",
          confidence: TS_CONFIDENCE,
          reason,
        });
        callEdgesAdded += stats.added;
        edgesUpgraded += stats.upgraded;
      }

      // ---- Emit REFERENCES edges ----------------------------------------
      for (const site of references ?? []) {
        if (callSiteFingerprints.has(`${site.file}:${site.line}`)) continue;
        const fromId = findEnclosingSymbolId(nodesByFile, site.file, site.line);
        if (fromId === undefined) continue;
        if (fromId === sym.id) continue;
        const stats = upsertEdge(ctx, provenanceIndex, {
          from: fromId,
          to: sym.id,
          type: "REFERENCES",
          confidence: TS_CONFIDENCE,
          reason,
        });
        referenceEdgesAdded += stats.added;
        edgesUpgraded += stats.upgraded;
      }

      // ---- Emit EXTENDS edges -------------------------------------------
      //
      // `textDocument/implementation` on a class returns implementing /
      // extending classes; on an interface it returns implementing
      // classes. The OpenCodeHub convention is `EXTENDS: child → parent`,
      // so each implementation site's enclosing Class/Interface becomes
      // the `from` end and the queried symbol is `to`.
      for (const site of implementations ?? []) {
        const fromId = findEnclosingSymbolId(
          nodesByFile,
          site.file,
          site.line,
          new Set(["Class", "Interface"]),
        );
        if (fromId === undefined) continue;
        if (fromId === sym.id) continue;
        const stats = upsertEdge(ctx, provenanceIndex, {
          from: fromId,
          to: sym.id,
          type: "EXTENDS",
          confidence: TS_CONFIDENCE,
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
        phase: LSP_TYPESCRIPT_PHASE_NAME,
        kind: "warn",
        message: `lsp-typescript: tsserver shutdown error (ignored): ${(err as Error).message}`,
      });
    }
  }

  return {
    enabled: true,
    ...(tsserverVersion.length > 0 ? { tsserverVersion } : {}),
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
): LspTypescriptOutput {
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
  readonly kind: "Class" | "Interface" | "Method" | "Function";
  readonly qualifiedName: string;
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
}

function collectTsSymbols(ctx: PipelineContext): readonly SymbolRecord[] {
  const out: SymbolRecord[] = [];
  for (const n of ctx.graph.nodes()) {
    if (!TS_SYMBOL_KINDS.has(n.kind)) continue;
    if (!isTsFile(n.filePath)) continue;
    const startLine = (n as { startLine?: number }).startLine;
    const endLine = (n as { endLine?: number }).endLine;
    if (startLine === undefined || endLine === undefined) continue;
    out.push({
      id: n.id as NodeId,
      kind: n.kind as "Class" | "Interface" | "Method" | "Function",
      qualifiedName: extractQualifiedName(n),
      filePath: n.filePath,
      startLine,
      endLine,
    });
  }
  out.sort((a, b) => (a.id as string).localeCompare(b.id as string));
  return out;
}

function isTsFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".d.ts")) return true;
  for (const ext of TS_EXTENSIONS) {
    if (ext === ".d.ts") continue;
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

/**
 * Collect the TS/TSX/JS/JSX file set that tsserver must `didOpen` before
 * cross-file references / callHierarchy return results. Reads from the
 * scan phase output (authoritative source) and falls back to walking the
 * graph's File nodes when scan is unavailable.
 */
function collectWarmupFiles(
  ctx: PipelineContext,
  deps: ReadonlyMap<string, unknown>,
): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const scan = deps.get(SCAN_PHASE_NAME) as ScanOutput | undefined;
  if (scan !== undefined) {
    for (const f of scan.files) {
      if (!isTsFile(f.relPath)) continue;
      const abs = path.isAbsolute(f.absPath) ? f.absPath : path.join(ctx.repoPath, f.relPath);
      if (seen.has(abs)) continue;
      seen.add(abs);
      out.push(abs);
    }
    return out;
  }
  // Fallback — iterate File nodes already in the graph.
  for (const n of ctx.graph.nodes()) {
    if (n.kind !== "File") continue;
    if (!isTsFile(n.filePath)) continue;
    const abs = path.isAbsolute(n.filePath) ? n.filePath : path.join(ctx.repoPath, n.filePath);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

/** Mirror of lsp-python's `extractQualifiedName` — node-id decoding. */
function extractQualifiedName(node: GraphNode): string {
  const id = node.id as string;
  const parts = id.split(":");
  if (parts.length < 3) return node.name;
  const fp = node.filePath;
  const afterFile = id.startsWith(`${node.kind}:${fp}:`)
    ? id.slice(node.kind.length + 1 + fp.length + 1)
    : parts.slice(1).join(":");
  const firstParen = afterFile.indexOf("(");
  return firstParen >= 0 ? afterFile.slice(0, firstParen) : afterFile;
}

function toLspSymbolKind(kind: string): SymbolKind | undefined {
  switch (kind) {
    case "Class":
      return "class";
    // LSP's SymbolKind union (pyright-facing) has no `interface` slot;
    // tsserver treats an interface header position the same as a class
    // header position for prepareCallHierarchy, so we map up to `class`.
    case "Interface":
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

/**
 * Resolve the 1-indexed column at which `name` begins on `line`, given the
 * variety of TS declaration syntaxes. Regex patterns are applied in
 * priority order; the first hit wins. Tolerates `export`,
 * `export default`, and `declare` prefixes. Falls back to the first
 * bare-word occurrence of `name`, and finally column 1.
 *
 * Public for unit tests to exercise the full dispatch table without
 * spinning up the phase.
 */
export function findIdentifierColumn(line: string, name: string): number {
  if (name.length === 0) return 1;
  const esc = escapeRegex(name);
  const patterns: RegExp[] = [
    // `function foo` / `async function foo`
    new RegExp(`\\b(?:async\\s+)?function\\s+(${esc})\\b`),
    // `class Foo`
    new RegExp(`\\bclass\\s+(${esc})\\b`),
    // `interface Foo`
    new RegExp(`\\binterface\\s+(${esc})\\b`),
    // `type Foo`
    new RegExp(`\\btype\\s+(${esc})\\b`),
    // `enum Foo`
    new RegExp(`\\benum\\s+(${esc})\\b`),
    // `const foo = (` / `let foo = (` / `var foo = (`
    new RegExp(`\\b(?:const|let|var)\\s+(${esc})\\s*=\\s*(?:async\\s*)?\\(`),
    // Arrow assignment without the leading keyword: `foo = (` / `foo = async (`
    new RegExp(`(?:^|[^\\w$])(${esc})\\s*=\\s*(?:async\\s*)?\\(`),
    // Method inside a class: `foo(` with optional access modifier prefix.
    // We look for `<modifiers?> <name>(` anchored to start-of-line or
    // whitespace so we don't match random `bar.foo(` inside expressions.
    new RegExp(
      `(?:^|\\s)(?:public\\s+|private\\s+|protected\\s+|static\\s+|readonly\\s+|async\\s+|\\*\\s*)*(${esc})\\s*[<(]`,
    ),
    // Typed field: `foo:` (methods eat the `(` pattern above first).
    new RegExp(`(?:^|\\s)(${esc})\\s*:`),
    // Bare identifier fallback.
    new RegExp(`\\b(${esc})\\b`),
  ];
  for (const pat of patterns) {
    const m = pat.exec(line);
    if (m?.index === undefined) continue;
    // The captured group is always `name` itself; locate it within the
    // matched span so access-modifier prefixes don't throw us off.
    const matchStart = m.index;
    const idx = line.indexOf(name, matchStart);
    if (idx >= 0) return idx + 1;
  }
  return 1;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Per-file, line-sorted node index for the tightest-enclosing lookup. */
type NodesByFile = ReadonlyMap<string, readonly SymbolRecord[]>;

function indexNodesByFile(ctx: PipelineContext): NodesByFile {
  const map = new Map<string, SymbolRecord[]>();
  for (const n of ctx.graph.nodes()) {
    if (!TS_SYMBOL_KINDS.has(n.kind)) continue;
    if (!isTsFile(n.filePath)) continue;
    const startLine = (n as { startLine?: number }).startLine;
    const endLine = (n as { endLine?: number }).endLine;
    if (startLine === undefined || endLine === undefined) continue;
    const rec: SymbolRecord = {
      id: n.id as NodeId,
      kind: n.kind as "Class" | "Interface" | "Method" | "Function",
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

function carryForwardTsEdges(
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
    if (e.reason === undefined || !e.reason.startsWith("typescript-language-server")) continue;
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

// ---- runSafe: narrow the exception surface of per-symbol queries --------

async function runSafe<T>(
  ctx: PipelineContext,
  fn: () => Promise<readonly T[]>,
): Promise<readonly T[]> {
  try {
    return await fn();
  } catch (err) {
    ctx.onProgress?.({
      phase: LSP_TYPESCRIPT_PHASE_NAME,
      kind: "warn",
      message: `lsp-typescript: query failed (ignored): ${(err as Error).message}`,
    });
    return [];
  }
}

export type LspCallerSite = CallerSite;
export type LspReferenceSite = ReferenceSite;
