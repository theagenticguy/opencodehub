/**
 * Receiver resolver — shared helper used by the ORM and route detectors to
 * confirm that a receiver identifier (e.g. `app.get(...)`, `prisma.user.findMany`)
 * actually originates from a specific npm module before a detector emits an
 * edge. Two paths are wired:
 *
 *   1. **Import-graph path** (fast, always available). Walks the per-file
 *      `ExtractedImport[]` list populated by the parse phase and returns the
 *      matched module when the identifier is declared as the `localAlias`
 *      of, or is one of the `importedNames` of, an import declaration.
 *
 *   2. **Type-check path** (optional, opt-in). Only invoked when the
 *      import-graph path misses AND a `ts-morph` project was passed in via
 *      {@link TsMorphProject}. Uses
 *      `getApparentType()` → `getSymbol()` → `getDeclarations()[0].getSourceFile()`
 *      to recover the declaring source file for the receiver's inferred
 *      type. If that file's path sits under a known `node_modules/<pkg>/`
 *      segment the module is returned.
 *
 * The ts-morph dependency is declared as an `optionalDependencies` entry on
 * `@opencodehub/ingestion` so repos that don't need type-check precision
 * never pay for it. When ts-morph isn't wired — or when any step in its
 * chain throws — the helper silently degrades to "no resolution" and the
 * caller decides whether to emit heuristically or skip.
 *
 * The helper makes no filesystem calls and no network calls. It is pure
 * over its inputs.
 */

import type { ExtractedImport } from "../providers/extraction-types.js";

/**
 * Per-symbol import record the resolver accepts. This is a structural
 * subset of {@link ExtractedImport} so test fixtures can pass in plain
 * objects without reaching for the full provider types.
 */
export interface ImportedSymbol {
  /** Raw module specifier as written in source (e.g. `@prisma/client`). */
  readonly source: string;
  /** Names introduced by a named import, or `undefined` for default / namespace imports. */
  readonly importedNames?: readonly string[];
  /** Local alias (default / namespace import, or aliased named import). */
  readonly localAlias?: string;
}

/**
 * Light wrapper over a `ts-morph` project handle. We deliberately keep the
 * shape structural so the resolver avoids a hard dependency on the ts-morph
 * type surface — callers pass any object that can resolve a symbol at a
 * `(filePath, identifier)` pair back to its declaring source file.
 */
export interface TsMorphProject {
  /**
   * Return the resolved module specifier (e.g. `@prisma/client`) for the
   * identifier's apparent type, or `null` when ts-morph cannot figure it out
   * (missing file, unresolved import, type alias to `any`, etc.).
   */
  resolveReceiverModule(filePath: string, identifier: string): ResolvedTypeInfo | null;
}

/** Output of {@link TsMorphProject.resolveReceiverModule}. */
export interface ResolvedTypeInfo {
  /** Module specifier recovered from the declaring source file's path. */
  readonly moduleName: string;
  /** Symbol name of the apparent type (e.g. `PrismaClient`). */
  readonly typeName?: string;
}

/** The resolution outcome returned by {@link resolveReceiver}. */
export interface ReceiverOrigin {
  readonly identifier: string;
  /** Module specifier the identifier is imported from, when known. */
  readonly moduleName?: string;
  /** Resolved type symbol name (ts-morph path only). */
  readonly resolvedType?: string;
  /** Which resolution path succeeded. */
  readonly source: "import-graph" | "type-check";
}

/**
 * Resolve the origin of `identifier` as used inside `filePath`. Returns
 * `null` when neither the import-graph nor the ts-morph path produced a
 * match.
 */
export function resolveReceiver(
  identifier: string,
  filePath: string,
  importsByFile: ReadonlyMap<string, readonly ImportedSymbol[]> | undefined,
  tsMorphProject?: TsMorphProject,
): ReceiverOrigin | null {
  // ---- Path 1: import graph --------------------------------------------
  const imports = importsByFile?.get(filePath);
  if (imports !== undefined) {
    for (const imp of imports) {
      if (imp.localAlias !== undefined && imp.localAlias === identifier) {
        return { identifier, moduleName: imp.source, source: "import-graph" };
      }
      if (imp.importedNames !== undefined && imp.importedNames.includes(identifier)) {
        return { identifier, moduleName: imp.source, source: "import-graph" };
      }
    }
  }

  // ---- Path 2: ts-morph type check -------------------------------------
  if (tsMorphProject !== undefined) {
    try {
      const info = tsMorphProject.resolveReceiverModule(filePath, identifier);
      if (info !== null) {
        return {
          identifier,
          moduleName: info.moduleName,
          ...(info.typeName !== undefined ? { resolvedType: info.typeName } : {}),
          source: "type-check",
        };
      }
    } catch {
      // DET-UN-001 — ts-morph may throw on a corrupt tsconfig / missing
      // file / internal invariant. Silent degradation: the caller treats
      // a `null` return as "unknown" and the strict-detectors flag decides
      // whether to emit heuristically.
    }
  }

  return null;
}

/**
 * Adapt a `ReadonlyMap<string, readonly ExtractedImport[]>` (the shape the
 * parse phase actually populates) into the structural {@link ImportedSymbol}
 * shape the resolver wants. This is a zero-cost view — no copies are made.
 */
export function importsMapFromExtracted(
  importsByFile: ReadonlyMap<string, readonly ExtractedImport[]>,
): ReadonlyMap<string, readonly ImportedSymbol[]> {
  return importsByFile as ReadonlyMap<string, readonly ImportedSymbol[]>;
}
