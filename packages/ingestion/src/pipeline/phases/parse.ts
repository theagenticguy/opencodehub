/**
 * Parse phase — fans the scanned files out to the worker pool, collects
 * captures, runs the matching language provider's extractors, and emits
 * the resulting symbol / call / import / heritage edges onto the graph.
 *
 * Life-cycle (W2-E.2 adds cache lookup + replay on top of the Wave 5 flow):
 *  1. Filter scan output to files with a detected language.
 *  2. For each candidate, derive a cache key from `(sha256, grammarSha,
 *     pipelineVersion)` and attempt {@link readCacheEntry}. Hits replay
 *     the stored extractions without touching the worker pool. Misses and
 *     `--force` fall through to step 3.
 *  3. Read each miss's content (already done during scan — but the scan
 *     phase does not retain buffers for memory reasons) and dispatch the
 *     combined task set through {@link ParsePool} with its default
 *     byte-budget chunker. If every candidate was a hit, the pool is not
 *     constructed at all.
 *  4. For each miss's captures, call the provider's four extract methods
 *     and write the resulting {@link CachedExtractions} back to disk. Write
 *     failures warn but never abort the pipeline.
 *  5. Emit `Function` / `Method` / `Class` / etc. nodes, `DEFINES` edges
 *     from file → top-level definitions, `HAS_METHOD` / `HAS_PROPERTY`
 *     edges from owners → members, `IMPORTS` edges at file granularity,
 *     `EXTENDS` / `IMPLEMENTS` edges via 3-tier heritage resolution, and
 *     `CALLS` edges via 3-tier callee resolution.
 *
 * Cross-file type propagation (the BindingAccumulator lifecycle referenced
 * in the explore notes) is a Wave 7 concern; at Wave 5 the parse phase
 * only runs the single-pass, per-file extractors.
 */

import { promises as fs } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import type { GraphNode, NodeKind } from "@opencodehub/core-types";
import { makeNodeId, type NodeId, SCHEMA_VERSION } from "@opencodehub/core-types";
import type { LanguageId, ParseTask } from "../../parse/types.js";
import { ParsePool } from "../../parse/worker-pool.js";
import { idForDefinition } from "../../providers/definition-ids.js";
import type {
  ExtractedCall,
  ExtractedDefinition,
  ExtractedHeritage,
  ExtractedImport,
} from "../../providers/extraction-types.js";
import { getProvider } from "../../providers/registry.js";
import {
  CONFIDENCE_BY_TIER,
  type ResolutionTier,
  resolve,
  type SymbolIndex,
} from "../../providers/resolution/context.js";
import type { LanguageProvider } from "../../providers/types.js";
import type { PipelineContext, PipelinePhase } from "../types.js";
import {
  CACHE_VERSION,
  type CachedExtractions,
  type CacheEntry,
  deriveCacheKey,
  readCacheEntry,
  writeCacheEntry,
} from "./content-cache.js";
import { SCAN_PHASE_NAME, type ScannedFile, type ScanOutput } from "./scan.js";
import { STRUCTURE_PHASE_NAME, type StructureOutput } from "./structure.js";

/** On-disk location of the parse-cache sidecar, relative to the repo root. */
const PARSE_CACHE_DIRNAME = path.join(".codehub", "parse-cache");

export interface ParseOutput {
  readonly definitionsByFile: ReadonlyMap<string, readonly ExtractedDefinition[]>;
  readonly callsByFile: ReadonlyMap<string, readonly ExtractedCall[]>;
  readonly importsByFile: ReadonlyMap<string, readonly ExtractedImport[]>;
  readonly heritageByFile: ReadonlyMap<string, readonly ExtractedHeritage[]>;
  readonly symbolIndex: SymbolIndex;
  /**
   * Raw UTF-8 source buffers keyed by repo-relative file path. Populated for
   * both cache-hit and cache-miss paths so downstream phases (accesses,
   * future body-scanning analyses) can scan file contents without re-reading
   * from disk.
   */
  readonly sourceByFile: ReadonlyMap<string, string>;
  readonly parseTimeMs: number;
  readonly fileCount: number;
  /**
   * Number of files whose parse-cache entry was found and replayed instead
   * of re-running the worker pool. Counted after `--force` filtering, so a
   * forced run always reports `cacheHits=0`. Reported alongside
   * {@link cacheMisses} so downstream meta writers can compute the ratio
   * without re-deriving it.
   */
  readonly cacheHits: number;
  /** Number of files that bypassed the cache and were parsed fresh. */
  readonly cacheMisses: number;
}

export const PARSE_PHASE_NAME = "parse";

export const parsePhase: PipelinePhase<ParseOutput> = {
  name: PARSE_PHASE_NAME,
  deps: [SCAN_PHASE_NAME, STRUCTURE_PHASE_NAME],
  async run(ctx, deps) {
    const scan = deps.get(SCAN_PHASE_NAME) as ScanOutput | undefined;
    const structure = deps.get(STRUCTURE_PHASE_NAME) as StructureOutput | undefined;
    if (scan === undefined) {
      throw new Error("parse: scan output missing from dependency map");
    }
    if (structure === undefined) {
      throw new Error("parse: structure output missing from dependency map");
    }
    return runParse(ctx, scan, structure);
  },
};

function poolMaxThreads(): number {
  const cpus = availableParallelism();
  return Math.max(2, Math.min(cpus, 8));
}

async function runParse(
  ctx: PipelineContext,
  scan: ScanOutput,
  structure: StructureOutput,
): Promise<ParseOutput> {
  const start = Date.now();

  // Filter to files with a known language; everything else is noise for
  // symbol extraction.
  type ParseCandidate = ScannedFile & { readonly language: LanguageId };
  const parseCandidates: readonly ParseCandidate[] = scan.files.filter(
    (f): f is ParseCandidate => f.language !== undefined,
  );

  const cacheDir = path.join(ctx.repoPath, PARSE_CACHE_DIRNAME);
  const force = ctx.options.force === true;

  // ---- Cache lookup --------------------------------------------------------
  //
  // Split candidates into cache hits (whose extractions we can replay) and
  // cache misses (which still need the worker pool). When `--force` is set
  // we skip the read path entirely so every file routes through the worker
  // — but we still populate the cache on the way out so subsequent runs
  // benefit. Files with no `grammarSha` (unknown language grammar, missing
  // package) are treated as unconditional misses: they still parse, but
  // their results are never cached because the key would not round-trip.
  interface CacheHit {
    readonly file: ParseCandidate;
    readonly extractions: CachedExtractions;
  }
  const hits: CacheHit[] = [];
  const missFiles: ParseCandidate[] = [];

  for (const f of parseCandidates) {
    if (force || f.grammarSha === null) {
      missFiles.push(f);
      continue;
    }
    const key = deriveCacheKey(f.sha256, f.grammarSha, SCHEMA_VERSION);
    const entry = await readCacheEntry(cacheDir, key);
    if (entry === null) {
      missFiles.push(f);
      continue;
    }
    hits.push({ file: f, extractions: entry.extractions });
  }

  // ---- Build parse tasks for misses only -----------------------------------
  //
  // We only touch the filesystem for files that actually need parsing; cache
  // hits skip the read entirely. `sourceByFile` is populated on demand so
  // provider.extractImports / extractDefinitions (which require raw text)
  // receive the correct buffer.
  const tasks: ParseTask[] = [];
  const sourceByFile = new Map<string, string>();
  for (const f of missFiles) {
    try {
      const buf = await fs.readFile(f.absPath);
      tasks.push({
        filePath: f.relPath,
        content: buf,
        language: f.language,
      });
      sourceByFile.set(f.relPath, buf.toString("utf8"));
    } catch (err) {
      ctx.onProgress?.({
        phase: PARSE_PHASE_NAME,
        kind: "warn",
        message: `parse: cannot read ${f.relPath}: ${(err as Error).message}`,
      });
    }
  }

  // Skip spinning up the worker pool if every file was a cache hit — the
  // pool creation itself has non-trivial overhead on small repos.
  let parseResults: Awaited<ReturnType<ParsePool["dispatch"]>> = [];
  if (tasks.length > 0) {
    const pool = new ParsePool({ maxThreads: poolMaxThreads() });
    try {
      parseResults = await pool.dispatch(tasks);
    } finally {
      await pool.destroy();
    }
  }

  const languageByFile = new Map<string, LanguageId>();
  for (const f of parseCandidates) languageByFile.set(f.relPath, f.language);

  const definitionsByFile = new Map<string, readonly ExtractedDefinition[]>();
  const callsByFile = new Map<string, readonly ExtractedCall[]>();
  const importsByFile = new Map<string, readonly ExtractedImport[]>();
  const heritageByFile = new Map<string, readonly ExtractedHeritage[]>();

  // ---- Replay cache hits ---------------------------------------------------
  //
  // The cached extractions are already byte-deterministic outputs of the
  // provider extractors; replaying them is equivalent to re-running parse
  // + extract on the same bytes. Every field carried forward is a plain
  // JSON primitive, so no re-normalization is required.
  for (const hit of hits) {
    definitionsByFile.set(hit.file.relPath, hit.extractions.definitions);
    callsByFile.set(hit.file.relPath, hit.extractions.calls);
    importsByFile.set(hit.file.relPath, hit.extractions.imports);
    heritageByFile.set(hit.file.relPath, hit.extractions.heritage);
    // Load source text for the accesses phase and other body scanners.
    // Caching source in the parse-cache envelope would double its size;
    // re-reading from disk is cheap and keyed by sha256 anyway.
    try {
      const buf = await fs.readFile(hit.file.absPath);
      sourceByFile.set(hit.file.relPath, buf.toString("utf8"));
    } catch (err) {
      ctx.onProgress?.({
        phase: PARSE_PHASE_NAME,
        kind: "warn",
        message: `parse: cache-hit source reload failed for ${hit.file.relPath}: ${(err as Error).message}`,
      });
    }
  }

  // ---- Extract from fresh parse results + write them back to the cache ----
  //
  // The write-back is best-effort: disk-full / read-only / permission
  // errors should warn and continue, never abort the pipeline. Cache
  // correctness is never a pipeline invariant — at worst we re-parse next
  // run.
  const missFileByPath = new Map<string, ParseCandidate>();
  for (const f of missFiles) missFileByPath.set(f.relPath, f);

  for (const result of parseResults) {
    const lang = languageByFile.get(result.filePath);
    if (lang === undefined) continue;
    const provider = getProvider(lang);
    const sourceText = sourceByFile.get(result.filePath) ?? "";

    const defs = provider.extractDefinitions({
      filePath: result.filePath,
      captures: result.captures,
      sourceText,
    });
    definitionsByFile.set(result.filePath, defs);

    const calls = provider.extractCalls({
      filePath: result.filePath,
      captures: result.captures,
      definitions: defs,
    });
    callsByFile.set(result.filePath, calls);

    const imports = provider.extractImports({
      filePath: result.filePath,
      sourceText,
    });
    importsByFile.set(result.filePath, imports);

    const heritage = provider.extractHeritage({
      filePath: result.filePath,
      captures: result.captures,
      definitions: defs,
    });
    heritageByFile.set(result.filePath, heritage);

    // Only cache results whose originating file has a grammarSha; without
    // one we cannot form the composite key and would be unable to read
    // the entry back. Files missing a grammarSha skip the write silently.
    const missFile = missFileByPath.get(result.filePath);
    if (missFile === undefined || missFile.grammarSha === null) continue;
    const entry: CacheEntry = {
      cacheVersion: CACHE_VERSION,
      grammarSha: missFile.grammarSha,
      pipelineVersion: SCHEMA_VERSION,
      extractions: {
        definitions: defs,
        calls,
        imports,
        heritage,
      },
      metadata: {
        language: lang,
        byteSize: result.byteLength,
      },
    };
    const key = deriveCacheKey(missFile.sha256, missFile.grammarSha, SCHEMA_VERSION);
    try {
      await writeCacheEntry(cacheDir, key, entry);
    } catch (err) {
      ctx.onProgress?.({
        phase: PARSE_PHASE_NAME,
        kind: "warn",
        message: `parse: failed to write parse-cache for ${result.filePath}: ${(err as Error).message}`,
      });
    }
  }

  // ---- Emit definition nodes + DEFINES / HAS_* edges. --------------------
  const defIdByKey = new Map<string, NodeId>();
  const definitionsByFilePlus = new Map<string, ExtractedDefinition[]>();

  for (const [filePath, defs] of definitionsByFile) {
    // Pre-sort definitions within a file for deterministic ordering.
    const sorted = [...defs].sort((a, b) => compareDefs(a, b));
    definitionsByFilePlus.set(filePath, sorted);
    for (const d of sorted) {
      const id = idForDefinition(d);
      defIdByKey.set(`${filePath}::${d.qualifiedName}`, id);
      ctx.graph.addNode(graphNodeForDefinition(d, id));
    }
  }

  for (const [filePath, defs] of definitionsByFilePlus) {
    const fileId = makeNodeId("File", filePath, filePath);
    for (const d of defs) {
      const defId = idForDefinition(d);
      if (d.owner === undefined) {
        ctx.graph.addEdge({
          from: fileId,
          to: defId,
          type: "DEFINES",
          confidence: 1,
          reason: "file-to-top-level-definition",
        });
      } else {
        // HAS_METHOD for callable owners, HAS_PROPERTY for value owners.
        const ownerId = defIdByKey.get(`${filePath}::${d.owner}`);
        if (ownerId === undefined) {
          // Owner not materialized as a definition (e.g., TS namespace).
          ctx.graph.addEdge({
            from: fileId,
            to: defId,
            type: "DEFINES",
            confidence: 0.9,
            reason: "file-to-nested-definition",
          });
        } else {
          const relation = isCallableKind(d.kind) ? "HAS_METHOD" : "HAS_PROPERTY";
          ctx.graph.addEdge({
            from: ownerId,
            to: defId,
            type: relation,
            confidence: 1,
            reason: `owner-${relation.toLowerCase()}`,
          });
        }
      }
    }
  }

  // ---- Build symbol index + import graph for resolution. ----------------
  const inFileIndex = new Map<string, Map<string, NodeId>>();
  for (const [filePath, defs] of definitionsByFilePlus) {
    const byName = new Map<string, NodeId>();
    for (const d of defs) {
      // Most-recent-wins is fine here; over-shadowed symbols are a source
      // bug on the originating side, not something resolution can fix.
      byName.set(d.name, idForDefinition(d));
      byName.set(d.qualifiedName, idForDefinition(d));
    }
    inFileIndex.set(filePath, byName);
  }

  const globalIndex = new Map<string, NodeId[]>();
  for (const [, defs] of definitionsByFilePlus) {
    for (const d of defs) {
      const list = globalIndex.get(d.name);
      if (list === undefined) globalIndex.set(d.name, [idForDefinition(d)]);
      else list.push(idForDefinition(d));
    }
  }
  // Sort global candidates for determinism.
  for (const [name, list] of globalIndex) {
    globalIndex.set(name, [...list].sort());
  }

  // Import graph: importer file → (name → target file's NodeId).
  const importScoped = new Map<string, Map<string, NodeId>>();
  for (const [importer, imports] of importsByFile) {
    const lang = languageByFile.get(importer);
    if (lang === undefined) continue;
    const provider = getProvider(lang);
    const byName = new Map<string, NodeId>();
    for (const imp of imports) {
      const targetRel = resolveImportTarget(importer, imp.source, provider, structure);
      if (targetRel === undefined) continue;
      const targetFileDefs = definitionsByFilePlus.get(targetRel);
      if (targetFileDefs === undefined) continue;
      // Record named imports by the original identifier or alias.
      if (imp.importedNames && imp.importedNames.length > 0) {
        for (const n of imp.importedNames) {
          const hit = targetFileDefs.find((d) => d.name === n || d.qualifiedName === n);
          if (hit !== undefined) byName.set(n, idForDefinition(hit));
        }
      }
      if (imp.localAlias !== undefined) {
        // Namespace or default import — record the alias under the target
        // file id so `calleeOwner === alias` lookups succeed downstream.
        const fileId = makeNodeId("File", targetRel, targetRel);
        byName.set(imp.localAlias, fileId);
      }
    }
    importScoped.set(importer, byName);
  }

  const symbolIndex: SymbolIndex = {
    findInFile(filePath, name) {
      return inFileIndex.get(filePath)?.get(name);
    },
    findInImports(importerFile, name) {
      return importScoped.get(importerFile)?.get(name);
    },
    findGlobal(name) {
      return globalIndex.get(name) ?? [];
    },
  };

  // ---- Emit IMPORTS edges at file granularity. --------------------------
  for (const [importer, imports] of importsByFile) {
    const importerId = makeNodeId("File", importer, importer);
    const lang = languageByFile.get(importer);
    if (lang === undefined) continue;
    const provider = getProvider(lang);
    for (const imp of imports) {
      const targetRel = resolveImportTarget(importer, imp.source, provider, structure);
      if (targetRel !== undefined) {
        const targetId = makeNodeId("File", targetRel, targetRel);
        ctx.graph.addEdge({
          from: importerId,
          to: targetId,
          type: "IMPORTS",
          confidence: 1,
          reason: "file-imports-file",
        });
      }
      // Unresolved external specifiers (e.g. `npm` packages) are skipped
      // at Wave 5; Wave 7 cross-file can emit them as CodeElement stubs.
    }
  }

  // ---- Emit EXTENDS / IMPLEMENTS edges (3-tier parent resolution). ------
  for (const [filePath, heritage] of heritageByFile) {
    const lang = languageByFile.get(filePath);
    if (lang === undefined) continue;
    const provider = getProvider(lang);
    for (const h of heritage) {
      const childId = defIdByKey.get(`${filePath}::${h.childQualifiedName}`);
      if (childId === undefined) continue;
      const resolved = resolve(
        { callerFile: filePath, calleeName: h.parentName, provider },
        symbolIndex,
      );
      const first = resolved[0];
      if (first === undefined) continue;
      ctx.graph.addEdge({
        from: childId,
        to: first.targetId as NodeId,
        type: h.relation,
        confidence: first.confidence,
        reason: first.tier,
      });
    }
  }

  // ---- Emit CALLS edges (3-tier callee resolution). ---------------------
  for (const [filePath, calls] of callsByFile) {
    const lang = languageByFile.get(filePath);
    if (lang === undefined) continue;
    const provider = getProvider(lang);
    const defs = definitionsByFilePlus.get(filePath) ?? [];
    for (const c of calls) {
      const callerId = callerIdFor(c, defs, filePath);
      if (callerId === undefined) continue;
      const resolved = resolve(
        { callerFile: filePath, calleeName: c.calleeName, provider },
        symbolIndex,
      );
      const first = resolved[0];
      if (first === undefined) continue;
      ctx.graph.addEdge({
        from: callerId,
        to: first.targetId as NodeId,
        type: "CALLS",
        confidence: confidenceFor(first.tier),
        reason: first.tier,
      });
    }
  }

  return {
    definitionsByFile,
    callsByFile,
    importsByFile,
    heritageByFile,
    symbolIndex,
    sourceByFile,
    parseTimeMs: Date.now() - start,
    fileCount: parseCandidates.length,
    cacheHits: hits.length,
    cacheMisses: missFiles.length,
  };
}

function confidenceFor(tier: ResolutionTier): number {
  return CONFIDENCE_BY_TIER[tier];
}

function compareDefs(a: ExtractedDefinition, b: ExtractedDefinition): number {
  if (a.startLine !== b.startLine) return a.startLine - b.startLine;
  if (a.qualifiedName < b.qualifiedName) return -1;
  if (a.qualifiedName > b.qualifiedName) return 1;
  return 0;
}

// Re-export `idForDefinition` for callers that still import from this
// module. The canonical definition lives in `providers/definition-ids.ts`
// so provider files can reach it without importing the parse phase.
export { idForDefinition };

function isCallableKind(k: NodeKind): boolean {
  return k === "Method" || k === "Function" || k === "Constructor";
}

function callerIdFor(
  call: ExtractedCall,
  defs: readonly ExtractedDefinition[],
  filePath: string,
): NodeId | undefined {
  if (call.callerQualifiedName === "<module>") {
    return makeNodeId("File", filePath, filePath);
  }
  const hit = defs.find((d) => d.qualifiedName === call.callerQualifiedName);
  if (hit === undefined) return undefined;
  return idForDefinition(hit);
}

/**
 * Best-effort module-specifier to file mapping. Rules:
 *  1. Apply the provider's `preprocessImportPath` if declared.
 *  2. Resolve relative specifiers ("./x", "../x") against the importer.
 *  3. Try the exact path as a file, then with provider-known extensions.
 *  4. Fall back to treating the specifier as an index file (`dir/index.ts`,
 *     `dir/__init__.py`, etc.).
 */
function resolveImportTarget(
  importerRel: string,
  specifier: string,
  provider: LanguageProvider,
  structure: StructureOutput,
): string | undefined {
  const preprocessed =
    provider.preprocessImportPath !== undefined
      ? provider.preprocessImportPath(specifier)
      : specifier;

  // Only relative / absolute-in-repo specifiers can be resolved without a
  // package-manager layer. External packages (e.g. `react`, `numpy`) fall
  // through to `undefined` and are skipped by the caller.
  if (
    !preprocessed.startsWith("./") &&
    !preprocessed.startsWith("../") &&
    !preprocessed.startsWith("/")
  ) {
    return undefined;
  }

  const importerDir = parentDir(importerRel);
  const joined = preprocessed.startsWith("/")
    ? preprocessed.slice(1)
    : posixJoin(importerDir, preprocessed);
  const normalized = normalizePath(joined);

  const candidates = candidatePathsFor(normalized, provider.extensions, provider.id);
  for (const c of candidates) {
    if (structure.pathSet.has(c)) return c;
  }
  return undefined;
}

function candidatePathsFor(
  base: string,
  extensions: readonly string[],
  languageId: LanguageId,
): readonly string[] {
  const out: string[] = [base];
  for (const ext of extensions) {
    out.push(`${base}${ext}`);
  }
  // Index-style entry points, language-specific.
  if (languageId === "python") {
    out.push(`${base}/__init__.py`);
  } else {
    for (const ext of extensions) {
      out.push(`${base}/index${ext}`);
    }
  }
  return out;
}

function graphNodeForDefinition(d: ExtractedDefinition, id: NodeId): GraphNode {
  // We synthesize the graph node based on NodeKind. Each branch sets only
  // the fields valid on that kind so `@opencodehub/core-types` sees a
  // well-typed record.
  const base = {
    id,
    name: d.name,
    filePath: d.filePath,
    startLine: d.startLine,
    endLine: d.endLine,
  } as const;

  switch (d.kind) {
    case "Function":
      return {
        ...base,
        kind: "Function",
        ...(d.signature !== undefined ? { signature: d.signature } : {}),
        ...(d.parameterCount !== undefined ? { parameterCount: d.parameterCount } : {}),
        ...(d.returnType !== undefined ? { returnType: d.returnType } : {}),
        isExported: d.isExported,
      };
    case "Method":
      return {
        ...base,
        kind: "Method",
        ...(d.owner !== undefined ? { owner: d.owner } : {}),
        ...(d.signature !== undefined ? { signature: d.signature } : {}),
        ...(d.parameterCount !== undefined ? { parameterCount: d.parameterCount } : {}),
        ...(d.returnType !== undefined ? { returnType: d.returnType } : {}),
        isExported: d.isExported,
      };
    case "Constructor":
      return {
        ...base,
        kind: "Constructor",
        ...(d.owner !== undefined ? { owner: d.owner } : {}),
        ...(d.signature !== undefined ? { signature: d.signature } : {}),
        ...(d.parameterCount !== undefined ? { parameterCount: d.parameterCount } : {}),
        ...(d.returnType !== undefined ? { returnType: d.returnType } : {}),
        isExported: d.isExported,
      };
    case "Class":
      return { ...base, kind: "Class", isExported: d.isExported };
    case "Interface":
      return { ...base, kind: "Interface", isExported: d.isExported };
    case "Struct":
      return { ...base, kind: "Struct", isExported: d.isExported };
    case "Trait":
      return { ...base, kind: "Trait", isExported: d.isExported };
    case "Enum":
      return { ...base, kind: "Enum", isExported: d.isExported };
    case "Impl":
      return { ...base, kind: "Impl", isExported: d.isExported };
    case "TypeAlias":
      return { ...base, kind: "TypeAlias", isExported: d.isExported };
    case "Const":
      return {
        ...base,
        kind: "Const",
        isExported: d.isExported,
        ...(d.returnType !== undefined ? { declaredType: d.returnType } : {}),
      };
    case "Static":
      return {
        ...base,
        kind: "Static",
        isExported: d.isExported,
        ...(d.returnType !== undefined ? { declaredType: d.returnType } : {}),
      };
    case "Variable":
      return {
        ...base,
        kind: "Variable",
        isExported: d.isExported,
        ...(d.returnType !== undefined ? { declaredType: d.returnType } : {}),
      };
    case "Property":
      return {
        ...base,
        kind: "Property",
        ...(d.owner !== undefined ? { owner: d.owner } : {}),
        ...(d.returnType !== undefined ? { declaredType: d.returnType } : {}),
      };
    case "Macro":
      return { ...base, kind: "Macro", isExported: d.isExported };
    case "Typedef":
      return { ...base, kind: "Typedef", isExported: d.isExported };
    case "Union":
      return { ...base, kind: "Union", isExported: d.isExported };
    case "Namespace":
      return { ...base, kind: "Namespace", isExported: d.isExported };
    case "Record":
      return { ...base, kind: "Record", isExported: d.isExported };
    case "Delegate":
      return {
        ...base,
        kind: "Delegate",
        isExported: d.isExported,
        ...(d.signature !== undefined ? { signature: d.signature } : {}),
      };
    case "Annotation":
      return { ...base, kind: "Annotation", isExported: d.isExported };
    case "Template":
      return { ...base, kind: "Template", isExported: d.isExported };
    case "Module":
      return { ...base, kind: "Module", isExported: d.isExported };
    case "Section":
      return { ...base, kind: "Section" };
    case "CodeElement":
      return { ...base, kind: "CodeElement" };
    default:
      // `File`, `Folder`, `Community`, `Process`, `Route`, `Tool` should
      // never be emitted by provider extractors. If one slips through we
      // fall back to CodeElement so the downstream graph stays consistent.
      return { ...base, kind: "CodeElement" };
  }
}

function parentDir(p: string): string {
  const idx = p.lastIndexOf("/");
  if (idx <= 0) return "";
  return p.slice(0, idx);
}

function posixJoin(dir: string, rel: string): string {
  if (dir === "") return rel;
  if (rel === "") return dir;
  return `${dir}/${rel}`;
}

function normalizePath(p: string): string {
  const parts = p.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}
