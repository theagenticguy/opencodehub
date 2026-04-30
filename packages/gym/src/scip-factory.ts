/**
 * SCIP-backed client factory for the gym runner.
 *
 * Replaces the retired `@opencodehub/lsp-oracle`-driven factory. For
 * each (language, fixtureRoot), the factory returns a client whose
 * `start()` runs the matching SCIP indexer once (or reuses a cached
 * `.scip` file), parses the result via `@opencodehub/scip-ingest`, and
 * pre-builds per-file caller/callee/definition lookup tables. The
 * three query methods then answer from those tables in O(log n)
 * without re-decoding the index.
 *
 * The runner's existing surface stays unchanged: `start`, `stop`,
 * `warmup`, `queryReferences`, `queryImplementations`, `queryCallers`.
 * The mock factory used by `runner.test.ts` continues to implement
 * this interface directly and never exercises this code path.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { DerivedIndex, IndexerKind, ScipOccurrence } from "@opencodehub/scip-ingest";
import {
  deriveIndex,
  parseScipIndex,
  runIndexer,
  SCIP_ROLE_DEFINITION,
} from "@opencodehub/scip-ingest";
import { META_DIR_NAME } from "@opencodehub/storage";
import type { ManifestLanguage } from "./manifest.js";

export interface FilePosition {
  readonly filePath: string;
  readonly line: number;
  readonly character: number;
}

export interface CallerSite {
  readonly file: string;
  readonly line: number;
  readonly character: number;
  readonly symbolName?: string;
  readonly enclosingSymbolName?: string;
}

export interface ReferenceSite {
  readonly file: string;
  readonly line: number;
  readonly character: number;
}

export interface ImplementationSite {
  readonly file: string;
  readonly line: number;
  readonly character: number;
}

export interface QueryCallersInput extends FilePosition {
  readonly symbolKind: "class" | "function" | "method" | "property";
  readonly symbolName: string;
}
export type QueryReferencesInput = FilePosition;
export type QueryImplementationsInput = FilePosition;

/**
 * Surface the runner calls through. Kept stable across the LSP -> SCIP
 * migration so `runner.ts` / `runner.test.ts` did not need to change.
 * Tests inject their own mock; production callers receive the SCIP-
 * backed implementation below.
 */
export interface LspClientLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  queryReferences(input: QueryReferencesInput): Promise<readonly ReferenceSite[]>;
  queryImplementations(input: QueryImplementationsInput): Promise<readonly ImplementationSite[]>;
  queryCallers(input: QueryCallersInput): Promise<readonly CallerSite[]>;
  warmup?(files: readonly string[]): Promise<void>;
}

export interface LspFactory {
  create(language: ManifestLanguage, fixtureRoot: string): LspClientLike;
}

/** Map the gym's corpus language to the scip-ingest runner kind. */
function languageToIndexerKind(language: ManifestLanguage): IndexerKind {
  switch (language) {
    case "python":
      return "python";
    case "typescript":
      return "typescript";
    case "go":
      return "go";
    case "rust":
      return "rust";
    default: {
      const exhaustive: never = language;
      throw new Error(`scip-factory: unsupported language ${String(exhaustive)}`);
    }
  }
}

export const defaultLspFactory: LspFactory = {
  create(language, fixtureRoot) {
    return new ScipClient(language, fixtureRoot);
  },
};

/** Alias exported under the SCIP-forward name. */
export const defaultScipFactory: LspFactory = defaultLspFactory;

class ScipClient implements LspClientLike {
  private readonly language: ManifestLanguage;
  private readonly fixtureRoot: string;
  private derived: DerivedIndex | null = null;
  /** relative_path -> occurrences (sorted by start). */
  private occurrencesByFile: Map<string, readonly ScipOccurrence[]> = new Map();
  /** scip symbol -> definition occurrence (first seen). */
  private definitionBySymbol: Map<string, { file: string; occ: ScipOccurrence }> = new Map();

  constructor(language: ManifestLanguage, fixtureRoot: string) {
    this.language = language;
    this.fixtureRoot = fixtureRoot;
  }

  async start(): Promise<void> {
    const kind = languageToIndexerKind(this.language);
    const outputDir = resolve(this.fixtureRoot, META_DIR_NAME, "gym-scip");
    await mkdir(outputDir, { recursive: true });
    const scipPath = resolve(outputDir, `${kind}.scip`);

    // Run the indexer if the artifact is missing. Gym runs are
    // deterministic; if the caller wants a rebuild they can delete
    // `.codehub/gym-scip/<lang>.scip` between runs. We pass
    // allowBuildScripts=true because fixtures are trusted corpora the
    // operator checked out themselves.
    if (!existsSync(scipPath)) {
      const result = await runIndexer(kind, {
        projectRoot: this.fixtureRoot,
        outputDir,
        allowBuildScripts: true,
      });
      if (result.skipped) {
        throw new Error(
          `scip-factory: ${kind} indexer skipped — ${result.skipReason ?? "unknown"}`,
        );
      }
    }
    if (!existsSync(scipPath)) {
      throw new Error(`scip-factory: ${kind} indexer did not produce ${scipPath}`);
    }

    const buf = await readFile(scipPath);
    const index = parseScipIndex(new Uint8Array(buf));
    this.derived = deriveIndex(index);

    // Build per-file occurrence tables + per-symbol definition lookup.
    for (const doc of index.documents) {
      const sorted = [...doc.occurrences].sort(compareOccurrence);
      this.occurrencesByFile.set(doc.relativePath, sorted);
      for (const occ of sorted) {
        if (!(occ.symbolRoles & SCIP_ROLE_DEFINITION)) continue;
        if (!occ.symbol) continue;
        if (!this.definitionBySymbol.has(occ.symbol)) {
          this.definitionBySymbol.set(occ.symbol, { file: doc.relativePath, occ });
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.derived = null;
    this.occurrencesByFile.clear();
    this.definitionBySymbol.clear();
  }

  async queryReferences(
    input: QueryReferencesInput & { readonly symbolName?: string },
  ): Promise<readonly ReferenceSite[]> {
    const symbol = this.resolveSymbolAt(input) ?? this.resolveSymbolByName(input);
    if (!symbol) return [];
    const hits: ReferenceSite[] = [];
    for (const [file, occs] of this.occurrencesByFile) {
      for (const occ of occs) {
        if (occ.symbol !== symbol) continue;
        hits.push({ file, line: occ.range.startLine + 1, character: occ.range.startChar + 1 });
      }
    }
    hits.sort(compareByLocation);
    return hits;
  }

  async queryImplementations(
    input: QueryImplementationsInput & { readonly symbolName?: string },
  ): Promise<readonly ImplementationSite[]> {
    const symbol = this.resolveSymbolAt(input) ?? this.resolveSymbolByName(input);
    if (!symbol || !this.derived) return [];
    // SCIP models "implementations" of an interface / trait as symbols
    // whose SymbolInformation.relationships include this symbol as
    // `is_implementation: true`. We read those relations directly: any
    // DerivedRelation pointing AT `symbol` identifies a subtype / impl.
    const implementers: string[] = [];
    for (const rel of this.derived.relations) {
      if (rel.kind !== "IMPLEMENTS") continue;
      if (rel.to !== symbol) continue;
      implementers.push(rel.from);
    }
    if (implementers.length > 0) {
      const hits: ImplementationSite[] = [];
      for (const impl of implementers) {
        const def = this.definitionBySymbol.get(impl);
        if (!def) continue;
        hits.push({
          file: def.file,
          line: def.occ.range.startLine + 1,
          character: def.occ.range.startChar + 1,
        });
      }
      hits.sort(compareByLocation);
      return hits;
    }
    // Fallback when the index did not emit relationships (rare with
    // the 2026 indexers): return the defining occurrence only. An empty
    // list is semantically correct for "no known implementers".
    const defHits: ImplementationSite[] = [];
    for (const [file, occs] of this.occurrencesByFile) {
      for (const occ of occs) {
        if (occ.symbol !== symbol) continue;
        if (!(occ.symbolRoles & SCIP_ROLE_DEFINITION)) continue;
        defHits.push({
          file,
          line: occ.range.startLine + 1,
          character: occ.range.startChar + 1,
        });
      }
    }
    defHits.sort(compareByLocation);
    return defHits;
  }

  async queryCallers(input: QueryCallersInput): Promise<readonly CallerSite[]> {
    if (!this.derived) return [];
    const calleeSymbol = this.resolveSymbolAt(input) ?? this.resolveSymbolByName(input);
    if (!calleeSymbol) return [];
    const hits: CallerSite[] = [];
    // Primary path: function-to-function edges from the derived graph.
    // This is precise (caller enclosing def attribution) and covers
    // method / function callees directly.
    for (const edge of this.derived.edges) {
      if (edge.callee !== calleeSymbol) continue;
      const callerDef = this.definitionBySymbol.get(edge.caller);
      if (!callerDef) continue;
      hits.push({
        file: edge.document,
        line: edge.callLine + 1,
        character: edge.callChar + 1,
        enclosingSymbolName: displayTail(edge.caller),
      });
    }
    // Fallback for class / trait / struct callees — they are "called"
    // by instantiation, not by direct function invocation, so they
    // don't appear as CALL edges. We scan non-definition occurrences
    // for the target symbol and attribute each reference to the
    // innermost enclosing definition in the same document. Matches
    // pyright's `prepareCallHierarchy(Class)` behaviour for Python
    // corpora.
    if (hits.length === 0 && !calleeSymbol.endsWith("().")) {
      for (const [file, occs] of this.occurrencesByFile) {
        const defs: { symbol: string; occ: ScipOccurrence }[] = [];
        for (const occ of occs) {
          if (!(occ.symbolRoles & SCIP_ROLE_DEFINITION)) continue;
          if (!occ.enclosingRange) continue;
          defs.push({ symbol: occ.symbol, occ });
        }
        for (const occ of occs) {
          if (occ.symbol !== calleeSymbol) continue;
          if (occ.symbolRoles & SCIP_ROLE_DEFINITION) continue;
          const enclosing = findInnermostEnclosing(defs, occ);
          if (!enclosing) continue;
          hits.push({
            file,
            line: occ.range.startLine + 1,
            character: occ.range.startChar + 1,
            enclosingSymbolName: displayTail(enclosing.symbol),
          });
        }
      }
    }
    hits.sort(compareByLocation);
    return hits;
  }

  async warmup(_files: readonly string[]): Promise<void> {
    // No-op: the full index is already resident in memory after start().
  }

  /**
   * Find the SCIP symbol whose definition or reference occurrence
   * covers the 1-indexed (file, line, char) the corpus target points
   * at. Corpus positions are 1-indexed; SCIP ranges are 0-indexed.
   */
  private resolveSymbolAt(input: FilePosition): string | null {
    const rel = this.relativize(input.filePath);
    const occs = this.occurrencesByFile.get(rel);
    if (!occs) return null;
    const line0 = input.line - 1;
    const char0 = input.character - 1;
    // Smallest range containing (line0, char0). Prefer definition
    // occurrences when multiple ranges overlap (they anchor symbol
    // identity unambiguously).
    let bestDef: string | null = null;
    let bestDefSpan = Number.POSITIVE_INFINITY;
    let bestRef: string | null = null;
    let bestRefSpan = Number.POSITIVE_INFINITY;
    for (const occ of occs) {
      if (!occ.symbol) continue;
      if (!rangeContains(occ, line0, char0)) continue;
      const span =
        (occ.range.endLine - occ.range.startLine) * 1000 +
        (occ.range.endChar - occ.range.startChar);
      const isDef = (occ.symbolRoles & SCIP_ROLE_DEFINITION) !== 0;
      if (isDef) {
        if (span < bestDefSpan) {
          bestDef = occ.symbol;
          bestDefSpan = span;
        }
      } else if (span < bestRefSpan) {
        bestRef = occ.symbol;
        bestRefSpan = span;
      }
    }
    return bestDef ?? bestRef;
  }

  /**
   * Fallback symbol resolution — used when the corpus target gives
   * (file, line=1, char=1) as a placeholder and relies on `symbolName`
   * to disambiguate. Match the SCIP symbol whose *definition* lies in
   * `input.filePath` and whose descriptor tail matches `symbolName`
   * (with dot-separated nested names mapped to SCIP's `#` / `.`
   * separators).
   */
  private resolveSymbolByName(input: {
    readonly filePath: string;
    readonly symbolName?: string;
  }): string | null {
    const name = input.symbolName;
    if (!name) return null;
    const rel = this.relativize(input.filePath);
    const occs = this.occurrencesByFile.get(rel);
    if (!occs) return null;
    const parts = name.split(".");
    for (const occ of occs) {
      if (!(occ.symbolRoles & SCIP_ROLE_DEFINITION)) continue;
      if (!occ.symbol) continue;
      if (descriptorMatches(occ.symbol, parts)) return occ.symbol;
    }
    return null;
  }

  private relativize(filePath: string): string {
    const abs = resolve(filePath);
    const root = resolve(this.fixtureRoot);
    if (abs.startsWith(`${root}/`)) return abs.slice(root.length + 1);
    return filePath;
  }
}

function compareOccurrence(a: ScipOccurrence, b: ScipOccurrence): number {
  if (a.range.startLine !== b.range.startLine) return a.range.startLine - b.range.startLine;
  if (a.range.startChar !== b.range.startChar) return a.range.startChar - b.range.startChar;
  if (a.range.endLine !== b.range.endLine) return b.range.endLine - a.range.endLine;
  return b.range.endChar - a.range.endChar;
}

function compareByLocation<T extends { file: string; line: number; character: number }>(
  a: T,
  b: T,
): number {
  if (a.file !== b.file) return a.file.localeCompare(b.file);
  if (a.line !== b.line) return a.line - b.line;
  return a.character - b.character;
}

function rangeContains(occ: ScipOccurrence, line: number, char: number): boolean {
  const { startLine, startChar, endLine, endChar } = occ.range;
  if (line < startLine) return false;
  if (line > endLine) return false;
  if (line === startLine && char < startChar) return false;
  if (line === endLine && char > endChar) return false;
  return true;
}

/**
 * Dotted `Foo.bar` corpus names → SCIP descriptors. SCIP encodes
 * nested identifiers as a chain of descriptor suffixes: `#` for types,
 * `().` for methods, `.` for terms. We compare the *tail* of the
 * descriptor chain to the dotted parts (case-sensitive). Both
 * `Agent.invoke_async` → `…/Agent#invoke_async().` and
 * `Agent` → `…/Agent#` resolve through this matcher.
 */
function descriptorMatches(scipSymbol: string, parts: readonly string[]): boolean {
  if (scipSymbol.startsWith("local ")) return false;
  const pieces = scipSymbol.split(" ");
  if (pieces.length < 4) return false;
  const desc = pieces.slice(3).join(" ");
  // Split on `/` (namespace), `#` (type), `.` (term / end-of-method)
  // but keep the trailing token. Each separator is significant for
  // identity; we only care about the *name segments*, so normalize
  // `#` → `/`, `()` → empty, trailing `.` → empty, then split on `/`.
  const normalized = desc
    .replace(/#/g, "/")
    .replace(/\(\)/g, "")
    .replace(/\.$/, "")
    .replace(/\./g, "/");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length < parts.length) return false;
  const tail = segments.slice(segments.length - parts.length);
  for (let i = 0; i < parts.length; i++) {
    if (tail[i] !== parts[i]) return false;
  }
  return true;
}

function findInnermostEnclosing(
  defs: readonly { symbol: string; occ: ScipOccurrence }[],
  site: ScipOccurrence,
): { symbol: string; occ: ScipOccurrence } | null {
  const line = site.range.startLine;
  const char = site.range.startChar;
  let best: { symbol: string; occ: ScipOccurrence } | null = null;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const def of defs) {
    const r = def.occ.enclosingRange;
    if (!r) continue;
    if (line < r.startLine || line > r.endLine) continue;
    if (line === r.startLine && char < r.startChar) continue;
    if (line === r.endLine && char > r.endChar) continue;
    const span = (r.endLine - r.startLine) * 1000 + (r.endChar - r.startChar);
    if (span < bestSpan) {
      best = def;
      bestSpan = span;
    }
  }
  return best;
}

function displayTail(scipSymbol: string): string {
  if (scipSymbol.startsWith("local ")) return scipSymbol;
  const parts = scipSymbol.split(" ");
  if (parts.length < 4) return scipSymbol;
  const desc = parts.slice(3).join(" ");
  const segs = desc.replace(/#/g, "/").split("/").filter(Boolean);
  return segs[segs.length - 1] ?? scipSymbol;
}

// Re-export under the legacy name so `runner.ts` imports don't break
// until the runner is renamed in a follow-up.
export { defaultLspFactory as _defaultLspFactoryLegacy };
