/**
 * Parse phase — fans the scanned files out to the worker pool, collects
 * captures, runs the matching language provider's extractors, and emits
 * the resulting symbol / call / import / heritage edges onto the graph.
 *
 * Life-cycle:
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
 * Cross-file type propagation (the BindingAccumulator lifecycle) runs in
 * the `crossFile` phase; this phase only runs the single-pass, per-file
 * extractors.
 */

import { promises as fs } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import type { GraphNode, NodeKind, RelationType } from "@opencodehub/core-types";
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

  // ---- Collect @doc captures per file for description backfill. --------
  //
  // The parse result carries a flat capture list per file. We keep the
  // doc captures around so `graphNodeForDefinition` can attach a
  // description when one of them aligns with the definition per the
  // per-language heuristic implemented in `descriptionForDefinition`.
  const docCapturesByFile = new Map<
    string,
    { startLine: number; endLine: number; text: string }[]
  >();
  for (const result of parseResults) {
    const docs = result.captures
      .filter((c) => c.tag === "doc")
      .map((c) => ({ startLine: c.startLine, endLine: c.endLine, text: c.text }));
    if (docs.length > 0) docCapturesByFile.set(result.filePath, docs);
  }

  // ---- Emit definition nodes + DEFINES / HAS_* edges. --------------------
  const defIdByKey = new Map<string, NodeId>();
  const definitionsByFilePlus = new Map<string, ExtractedDefinition[]>();
  // Secondary index: owner resolution by short name (`d.name`) when unique
  // within the file. Needed for providers (Python, TS) that populate
  // `d.owner` with the owner's LOCAL name even when the owner itself is
  // nested (e.g. `class Outer { class Inner {} }` produces Inner.owner ==
  // "Outer" for inner_method while Inner's qualifiedName is "Outer.Inner").
  // Without this fallback, nested-class members skip HAS_METHOD emission.
  const shortNameCounts = new Map<string, number>();
  const shortNameIds = new Map<string, NodeId>();

  for (const [filePath, defs] of definitionsByFile) {
    // Pre-sort definitions within a file for deterministic ordering.
    const sorted = [...defs].sort((a, b) => compareDefs(a, b));
    definitionsByFilePlus.set(filePath, sorted);
    const lang = languageByFile.get(filePath);
    const docs = docCapturesByFile.get(filePath) ?? [];
    for (const d of sorted) {
      const id = idForDefinition(d);
      defIdByKey.set(`${filePath}::${d.qualifiedName}`, id);
      const description = lang !== undefined ? descriptionForDefinition(d, docs, lang) : undefined;
      ctx.graph.addNode(graphNodeForDefinition(d, id, description));

      const shortKey = `${filePath}::${d.name}`;
      shortNameCounts.set(shortKey, (shortNameCounts.get(shortKey) ?? 0) + 1);
      shortNameIds.set(shortKey, id);
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
        // Owner lookup is two-tier: first try the full qualified name
        // (covers common non-nested cases), then fall back to the owner's
        // short name when it's uniquely defined in this file. The
        // short-name fallback handles providers that emit `d.owner` as the
        // owner's local identifier even when the owner is itself nested.
        let ownerId = defIdByKey.get(`${filePath}::${d.owner}`);
        if (ownerId === undefined) {
          const shortKey = `${filePath}::${d.owner}`;
          if ((shortNameCounts.get(shortKey) ?? 0) === 1) {
            ownerId = shortNameIds.get(shortKey);
          }
        }
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
          // HAS_METHOD for callable owners (Method/Function/Constructor),
          // HAS_PROPERTY for value owners (Property/Const/Static/Variable).
          // Owner resolution above restricts emission to the innermost
          // enclosing definition, so nested classes get the correct owner —
          // the outer class never claims a method of the inner class.
          const relation: RelationType = isCallableKind(d.kind) ? "HAS_METHOD" : "HAS_PROPERTY";
          ctx.graph.addEdge({
            from: ownerId,
            to: defId,
            type: relation,
            confidence: 1,
            reason: "parse/ast",
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
  // External-stub emission: imports whose specifier doesn't resolve to an
  // in-repo file become `CodeElement:<external>:<pkg>:<symbol>` nodes, one
  // per (specifier, imported-name) pair. The resulting IMPORTS edge
  // documents the dependency in a form that downstream phases (impact,
  // wiki, cross-repo contracts) can reason about. Emission is
  // deterministic: we iterate `importsByFile` in insertion order (parse
  // phase already sorts files) and dedupe by stub id inside the loop.
  const EXTERNAL_PATH = "<external>";
  const emittedStubIds = new Set<NodeId>();
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
        continue;
      }
      // Unresolved external specifier. Skip purely-relative specifiers
      // that failed to resolve (those would be emitted as `<external>`
      // but by convention only truly external package names get stubs).
      if (isRelativeSpecifier(imp.source)) continue;
      // Build one stub per imported name when the import explicitly
      // named symbols; fall back to the module alias (namespace /
      // default) or the bare module name.
      const symbolNames: readonly string[] =
        imp.importedNames !== undefined && imp.importedNames.length > 0
          ? imp.importedNames
          : imp.localAlias !== undefined
            ? [imp.localAlias]
            : [imp.source];
      for (const symbol of symbolNames) {
        const stubId = makeNodeId("CodeElement", EXTERNAL_PATH, `${imp.source}:${symbol}`);
        if (!emittedStubIds.has(stubId)) {
          emittedStubIds.add(stubId);
          ctx.graph.addNode({
            id: stubId,
            kind: "CodeElement",
            name: symbol,
            filePath: EXTERNAL_PATH,
            content: `external import: ${imp.source}:${symbol}`,
          });
        }
        ctx.graph.addEdge({
          from: importerId,
          to: stubId,
          type: "IMPORTS",
          confidence: 0.8,
          reason: "file-imports-external",
        });
      }
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

function graphNodeForDefinition(
  d: ExtractedDefinition,
  id: NodeId,
  description?: string,
): GraphNode {
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

  const descField = description !== undefined ? { description } : {};

  switch (d.kind) {
    case "Function":
      return {
        ...base,
        kind: "Function",
        ...(d.signature !== undefined ? { signature: d.signature } : {}),
        ...(d.parameterCount !== undefined ? { parameterCount: d.parameterCount } : {}),
        ...(d.returnType !== undefined ? { returnType: d.returnType } : {}),
        isExported: d.isExported,
        ...descField,
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
        ...descField,
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
        ...descField,
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

/**
 * `true` when the specifier is a file-system relative / absolute path
 * rather than an external package name. Detects JS/TS (`./x`, `../x`,
 * `/x`), Python (dotted starts with `.`), and Go-style absolute module
 * paths (`example.com/...` do NOT match; those are treated as external
 * even though they are absolute, because Go's package resolution goes
 * through the module graph, not the filesystem).
 */
function isRelativeSpecifier(source: string): boolean {
  if (source.length === 0) return false;
  if (source.startsWith("./") || source.startsWith("../") || source.startsWith("/")) return true;
  if (source.startsWith(".") && !source.includes("/")) {
    // Python relative import shapes: `.`, `..mod`, `.sibling`.
    return true;
  }
  return false;
}

function posixJoin(dir: string, rel: string): string {
  if (dir === "") return rel;
  if (rel === "") return dir;
  return `${dir}/${rel}`;
}

/**
 * Resolve a description (docstring / JSDoc / rustdoc / godoc) for a
 * definition by matching the captured `@doc` locations against the
 * definition's body range, per per-language rules.
 *
 * Match rules:
 *   - Python: the first doc capture strictly inside the definition
 *     body (captured by the `(string) @doc` query).
 *   - TS/JS/TSX: a JSDoc block comment whose end line is 1-2 lines
 *     before the definition's start line.
 *   - Rust: a contiguous block of triple-slash line comments or
 *     rustdoc block comments immediately above the definition.
 *   - Go: a contiguous `//` comment group immediately above the
 *     definition.
 */
function descriptionForDefinition(
  d: ExtractedDefinition,
  docs: readonly { startLine: number; endLine: number; text: string }[],
  lang: LanguageId,
): string | undefined {
  if (docs.length === 0) return undefined;
  if (lang === "python") {
    for (const doc of docs) {
      if (doc.startLine >= d.startLine && doc.endLine <= d.endLine) {
        return stripPythonDocstring(doc.text);
      }
    }
    return undefined;
  }
  if (lang === "typescript" || lang === "tsx" || lang === "javascript") {
    // JSDoc: find the CLOSEST `/** */` block whose end line sits within
    // two lines of the definition start.
    let best: { startLine: number; endLine: number; text: string } | undefined;
    for (const doc of docs) {
      if (!doc.text.startsWith("/**")) continue;
      const delta = d.startLine - doc.endLine;
      if (delta < 0 || delta > 2) continue;
      if (best === undefined || doc.endLine > best.endLine) best = doc;
    }
    return best !== undefined ? stripJsDoc(best.text) : undefined;
  }
  if (lang === "rust") {
    // Rustdoc: collect contiguous `///` or `/** */` captures ending
    // right above the definition start.
    let lineCursor = d.startLine - 1;
    const accum: string[] = [];
    for (let i = docs.length - 1; i >= 0; i--) {
      const doc = docs[i];
      if (doc === undefined) continue;
      const isLineDoc = doc.text.startsWith("///");
      const isBlockDoc = doc.text.startsWith("/**") && doc.text.endsWith("*/");
      if (!isLineDoc && !isBlockDoc) continue;
      if (doc.endLine !== lineCursor) continue;
      accum.unshift(stripRustDoc(doc.text));
      lineCursor = doc.startLine - 1;
    }
    if (accum.length === 0) return undefined;
    const joined = accum.join(" ").trim();
    return joined.length > 0 ? joined : undefined;
  }
  if (lang === "go") {
    // godoc: contiguous `// ...` comments ending right above the decl.
    let lineCursor = d.startLine - 1;
    const accum: string[] = [];
    for (let i = docs.length - 1; i >= 0; i--) {
      const doc = docs[i];
      if (doc === undefined) continue;
      if (!doc.text.startsWith("//")) continue;
      if (doc.endLine !== lineCursor) continue;
      accum.unshift(doc.text.replace(/^\/\/\s?/, "").trim());
      lineCursor = doc.startLine - 1;
    }
    if (accum.length === 0) return undefined;
    const joined = accum.join(" ").trim();
    return joined.length > 0 ? joined : undefined;
  }
  return undefined;
}

/** Strip leading/trailing triple quotes from a Python docstring. */
function stripPythonDocstring(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('"""') || s.startsWith("'''")) s = s.slice(3);
  if (s.endsWith('"""') || s.endsWith("'''")) s = s.slice(0, -3);
  // Drop r/b/u prefixes if present before the triple quote (handled above).
  return s.trim();
}

/** Strip JSDoc markers and leading "* " decorations from a block. */
function stripJsDoc(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("/**")) s = s.slice(3);
  if (s.endsWith("*/")) s = s.slice(0, -2);
  // Drop leading " * " on each line.
  const lines = s
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, "").trimEnd())
    .filter((line) => !line.startsWith("@")); // drop JSDoc tags
  return lines.join(" ").trim();
}

/** Strip triple-slash or rustdoc block markers from a fragment. */
function stripRustDoc(raw: string): string {
  let s = raw;
  if (s.startsWith("///")) {
    s = s.slice(3);
    if (s.startsWith(" ")) s = s.slice(1);
    return s.trim();
  }
  if (s.startsWith("/**")) {
    s = s.slice(3);
    if (s.endsWith("*/")) s = s.slice(0, -2);
    const lines = s
      .split("\n")
      .map((line) => line.replace(/^\s*\*\s?/, "").trimEnd())
      .filter((line) => !line.startsWith("@"));
    return lines.join(" ").trim();
  }
  return s.trim();
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
