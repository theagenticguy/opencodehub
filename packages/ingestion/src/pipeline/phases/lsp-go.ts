// gopls limitations accepted for v1: (a) textDocument/references is scoped to the build config of the selected file (go.dev/issue/65755); (b) callHierarchy excludes dynamic/interface-dispatched calls.

import { readFileSync } from "node:fs";
import path from "node:path";
import type { GraphNode, NodeId, RelationType } from "@opencodehub/core-types";
import type {
  CallerSite,
  ImplementationSite,
  ReferenceSite,
  SymbolKind,
} from "@opencodehub/lsp-oracle";
import { GoplsClient } from "@opencodehub/lsp-oracle";
import type { PipelineContext, PipelinePhase } from "../types.js";
import { CROSS_FILE_PHASE_NAME } from "./cross-file.js";
import {
  buildFilePathLookup,
  partitionPriorEdges,
  resolveIncrementalView,
} from "./incremental-helper.js";
import { INCREMENTAL_SCOPE_PHASE_NAME } from "./incremental-scope.js";
import { LSP_TYPESCRIPT_PHASE_NAME } from "./lsp-typescript.js";
import { PARSE_PHASE_NAME } from "./parse.js";
import { PROFILE_PHASE_NAME, type ProfileOutput } from "./profile.js";
import { SCAN_PHASE_NAME } from "./scan.js";

export const LSP_GO_PHASE_NAME = "lsp-go";

/** Confidence assigned to every compiler-grade edge emitted by this phase. */
const GOPLS_CONFIDENCE = 1.0;

/** Hard ceiling on wall-clock time spent inside the phase. */
const PHASE_DEADLINE_MS = 9 * 60 * 1000;

/** Gopls index wait budget. */
const INDEX_WAIT_MS = 60_000;

/** Node kinds the phase queries. Everything else is ignored. */
const GO_SYMBOL_KINDS: ReadonlySet<string> = new Set([
  "Class",
  "Method",
  "Function",
  "Interface",
  "Struct",
  "Type",
]);

export interface LspGoOutput {
  readonly enabled: boolean;
  /** Populated when enabled=false; a human-readable hint for logs. */
  readonly skippedReason?: string;
  /** Populated when enabled=true; parsed from `gopls version`. */
  readonly goplsVersion?: string;
  readonly symbolsQueried: number;
  readonly callEdgesAdded: number;
  readonly referenceEdgesAdded: number;
  readonly extendsEdgesAdded: number;
  readonly edgesUpgraded: number;
  readonly durationMs: number;
}

export const lspGoPhase: PipelinePhase<LspGoOutput> = {
  name: LSP_GO_PHASE_NAME,
  deps: [
    SCAN_PHASE_NAME,
    PROFILE_PHASE_NAME,
    PARSE_PHASE_NAME,
    CROSS_FILE_PHASE_NAME,
    INCREMENTAL_SCOPE_PHASE_NAME,
    // Sequence after `lsp-typescript` so the runtime phase order pins to
    // `python → typescript → go → rust` regardless of Kahn's alphabetic
    // tiebreak. Functionally lsp-go does not read lsp-typescript's output —
    // the dep is purely an ordering constraint.
    LSP_TYPESCRIPT_PHASE_NAME,
  ],
  async run(ctx, deps) {
    return runLspGo(ctx, deps);
  },
};

/**
 * Minimal LSP client interface the phase depends on. `GoplsClient` satisfies
 * this naturally. Exposed ONLY so tests can substitute a mock without
 * spawning a real gopls subprocess.
 */
export interface LspGoClientLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): { readonly goplsVersion: string | null };
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
  }): Promise<readonly ImplementationSite[]>;
}

export interface LspGoTestHooks {
  /** Override the gopls client factory (test-only). */
  readonly clientFactory?: (opts: { readonly workspaceRoot: string }) => LspGoClientLike;
}

let testHooks: LspGoTestHooks | undefined;
export function __setLspGoTestHooks__(hooks: LspGoTestHooks | undefined): void {
  testHooks = hooks;
}

async function runLspGo(
  ctx: PipelineContext,
  deps: ReadonlyMap<string, unknown>,
): Promise<LspGoOutput> {
  const start = Date.now();

  if (process.env["CODEHUB_DISABLE_LSP"] === "1") {
    return zeroOutput(start, {
      enabled: false,
      skippedReason: "CODEHUB_DISABLE_LSP=1",
    });
  }

  const profile = deps.get(PROFILE_PHASE_NAME) as ProfileOutput | undefined;
  const profileNode = findProfileNode(ctx);
  if (profile === undefined || profileNode === undefined) {
    return zeroOutput(start, {
      enabled: false,
      skippedReason: "no-profile-output",
    });
  }
  if (!profileNode.languages.includes("go")) {
    return zeroOutput(start, {
      enabled: false,
      skippedReason: "no-go-in-profile",
    });
  }

  const goSymbols = collectGoSymbols(ctx);
  if (goSymbols.length === 0) {
    return zeroOutput(start, {
      enabled: false,
      skippedReason: "no-go-symbols-in-graph",
    });
  }

  const view = resolveIncrementalView(ctx);
  const carriedFromPrior = carryForwardGoplsEdges(ctx, view);

  const symbolsInScope = view.active
    ? goSymbols.filter((s) => view.closure.has(s.filePath))
    : goSymbols;

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

  const client: LspGoClientLike = testHooks?.clientFactory
    ? testHooks.clientFactory({ workspaceRoot: ctx.repoPath })
    : new GoplsClient({
        workspaceRoot: ctx.repoPath,
        indexWaitMs: INDEX_WAIT_MS,
      });
  try {
    await client.start();
  } catch (err) {
    ctx.onProgress?.({
      phase: LSP_GO_PHASE_NAME,
      kind: "warn",
      message: `lsp-go: gopls failed to start — skipping (${(err as Error).message})`,
    });
    try {
      await client.stop();
    } catch {
      // ignore — we're already on the degraded path
    }
    return zeroOutput(start, {
      enabled: false,
      skippedReason: "gopls-start-failed",
    });
  }

  const version = client.getStatus().goplsVersion ?? "unknown";
  const reason = `gopls@${version}`;
  const deadline = start + PHASE_DEADLINE_MS;
  const provenanceIndex = buildProvenanceIndex(ctx);

  let symbolsQueried = 0;
  let callEdgesAdded = 0;
  let referenceEdgesAdded = 0;
  let extendsEdgesAdded = 0;
  let edgesUpgraded = 0;

  const nodesByFile = indexNodesByFile(ctx);

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
    const col = identifierColumn(headerLine, simpleName);
    symbolCharCache.set(cacheKey, col);
    return col;
  }

  try {
    for (const sym of symbolsInScope) {
      if (Date.now() > deadline) {
        ctx.onProgress?.({
          phase: LSP_GO_PHASE_NAME,
          kind: "warn",
          message: `lsp-go: deadline exceeded after ${symbolsQueried} symbols — stopping early`,
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
      const references = await runSafe(ctx, () =>
        client.queryReferences({
          filePath: sym.filePath,
          line: sym.startLine,
          character,
        }),
      );
      const implementations =
        sym.kind === "Interface" ||
        sym.kind === "Struct" ||
        sym.kind === "Type" ||
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
          confidence: GOPLS_CONFIDENCE,
          reason,
        });
        callEdgesAdded += stats.added;
        edgesUpgraded += stats.upgraded;
      }

      for (const site of references ?? []) {
        if (callSiteFingerprints.has(`${site.file}:${site.line}`)) continue;
        const fromId = findEnclosingSymbolId(nodesByFile, site.file, site.line);
        if (fromId === undefined) continue;
        if (fromId === sym.id) continue;
        const stats = upsertEdge(ctx, provenanceIndex, {
          from: fromId,
          to: sym.id,
          type: "REFERENCES",
          confidence: GOPLS_CONFIDENCE,
          reason,
        });
        referenceEdgesAdded += stats.added;
        edgesUpgraded += stats.upgraded;
      }

      for (const site of implementations ?? []) {
        const fromId = findEnclosingSymbolId(nodesByFile, site.file, site.line);
        if (fromId === undefined) continue;
        if (fromId === sym.id) continue;
        const stats = upsertEdge(ctx, provenanceIndex, {
          from: fromId,
          to: sym.id,
          type: "EXTENDS",
          confidence: GOPLS_CONFIDENCE,
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
        phase: LSP_GO_PHASE_NAME,
        kind: "warn",
        message: `lsp-go: gopls shutdown error (ignored): ${(err as Error).message}`,
      });
    }
  }

  return {
    enabled: true,
    goplsVersion: version,
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
): LspGoOutput {
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
  readonly kind: string;
  readonly qualifiedName: string;
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
}

function collectGoSymbols(ctx: PipelineContext): readonly SymbolRecord[] {
  const out: SymbolRecord[] = [];
  for (const n of ctx.graph.nodes()) {
    if (!GO_SYMBOL_KINDS.has(n.kind)) continue;
    if (!isGoFile(n.filePath)) continue;
    const startLine = (n as { startLine?: number }).startLine;
    const endLine = (n as { endLine?: number }).endLine;
    if (startLine === undefined || endLine === undefined) continue;
    out.push({
      id: n.id as NodeId,
      kind: n.kind,
      qualifiedName: extractQualifiedName(n),
      filePath: n.filePath,
      startLine,
      endLine,
    });
  }
  out.sort((a, b) => (a.id as string).localeCompare(b.id as string));
  return out;
}

function isGoFile(filePath: string): boolean {
  return filePath.endsWith(".go");
}

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
    case "Struct":
    case "Interface":
    case "Type":
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
 * Find the 1-indexed column of the identifier token on its header line for
 * a Go declaration. Supports:
 *   - `func <name>(`
 *   - `func (<recv> <type>) <name>(`   (method with receiver)
 *   - `type <name>`
 *   - `var <name>`
 *   - `const <name>`
 *   - `package <name>`
 *
 * Falls back to the first whole-word occurrence of the name, then to column 1.
 */
export function identifierColumn(headerLine: string, simpleName: string): number {
  const n = escapeRegex(simpleName);
  const patterns: readonly RegExp[] = [
    new RegExp(`\\bfunc\\s*\\([^)]*\\)\\s+(${n})\\b`),
    new RegExp(`\\bfunc\\s+(${n})\\b`),
    new RegExp(`\\btype\\s+(${n})\\b`),
    new RegExp(`\\bvar\\s+(${n})\\b`),
    new RegExp(`\\bconst\\s+(${n})\\b`),
    new RegExp(`\\bpackage\\s+(${n})\\b`),
    new RegExp(`\\b(${n})\\b`),
  ];
  for (const pat of patterns) {
    const m = pat.exec(headerLine);
    if (m?.index !== undefined) {
      const idxInMatch = m[0].lastIndexOf(simpleName);
      if (idxInMatch >= 0) {
        return m.index + idxInMatch + 1;
      }
    }
  }
  return 1;
}

type NodesByFile = ReadonlyMap<string, readonly SymbolRecord[]>;

function indexNodesByFile(ctx: PipelineContext): NodesByFile {
  const map = new Map<string, SymbolRecord[]>();
  for (const n of ctx.graph.nodes()) {
    if (!GO_SYMBOL_KINDS.has(n.kind)) continue;
    if (!isGoFile(n.filePath)) continue;
    const startLine = (n as { startLine?: number }).startLine;
    const endLine = (n as { endLine?: number }).endLine;
    if (startLine === undefined || endLine === undefined) continue;
    const rec: SymbolRecord = {
      id: n.id as NodeId,
      kind: n.kind,
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

/**
 * Find the tightest OpenCodeHub node id that contains (filePath, line).
 */
export function findEnclosingSymbolId(
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

function carryForwardGoplsEdges(
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
    if (e.reason === undefined || !e.reason.startsWith("gopls@")) continue;
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

async function runSafe<T>(
  ctx: PipelineContext,
  fn: () => Promise<readonly T[]>,
): Promise<readonly T[]> {
  try {
    return await fn();
  } catch (err) {
    ctx.onProgress?.({
      phase: LSP_GO_PHASE_NAME,
      kind: "warn",
      message: `lsp-go: query failed (ignored): ${(err as Error).message}`,
    });
    return [];
  }
}

export type LspGoCallerSite = CallerSite;
export type LspGoReferenceSite = ReferenceSite;
export type LspGoImplementationSite = ImplementationSite;
