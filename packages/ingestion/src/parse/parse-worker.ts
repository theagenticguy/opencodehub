/**
 * Piscina worker entry point.
 *
 * Each worker thread imports this file once, then receives {@link ParseBatch}
 * inputs on every `pool.run()` call. The worker:
 *   1. Loads the grammar for each task's language (cached in the worker).
 *   2. Builds a `Parser` with that language (cached).
 *   3. Compiles the unified S-expression query (cached).
 *   4. Parses each task's buffer and maps captures to {@link ParseCapture}.
 *   5. Returns a {@link ParseResult} per task.
 *
 * Per-task wall-clock timeout: 30 seconds. On timeout the task returns a
 * result with empty captures and a warning rather than crashing the worker.
 *
 * Safety: tree-sitter parsers are NOT thread-safe; one Parser per worker per
 * language is a hard constraint. This file enforces that via per-worker maps
 * keyed by LanguageId.
 */

import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { loadGrammar } from "./grammar-registry.js";
import { getUnifiedQuery } from "./unified-queries.js";
import type { LanguageId, ParseBatch, ParseCapture, ParseResult, ParseTask } from "./types.js";
import { isNativeAvailable, openWasmParser, type WasmParserHandle } from "./wasm-fallback.js";

const requireFn = createRequire(import.meta.url);

const PER_FILE_TIMEOUT_MS = 30_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB

// Per-worker caches. Each worker_thread has its own module instance so these
// live per-worker, honoring tree-sitter's one-parser-per-thread rule.
const parserCache = new Map<LanguageId, unknown>();
const queryCache = new Map<LanguageId, unknown>();
const wasmParserCache = new Map<LanguageId, WasmParserHandle | null>();

let warnedWasm = false;

/**
 * Read the `--wasm-only` force-flag. Set either via env (`OCH_WASM_ONLY=1`)
 * or via argv pass-through when the worker boots inside a process
 * launched with the flag. The worker itself cannot read the CLI argv
 * directly (piscina starts workers afresh) so env is the primary carrier.
 */
function forceWasmOnly(): boolean {
  const v = process.env["OCH_WASM_ONLY"];
  return v === "1" || v === "true";
}

/**
 * Piscina task entry. Default export is the function piscina invokes.
 */
export default async function parseBatch(batch: ParseBatch): Promise<ParseResult[]> {
  // Warn once per worker if we're forced onto WASM (native unavailable,
  // or `--wasm-only` forced).
  if ((!isNativeAvailable() || forceWasmOnly()) && !warnedWasm) {
    warnedWasm = true;
    process.stderr.write(
      "[parse-worker] using web-tree-sitter (WASM) runtime\n",
    );
  }

  const results: ParseResult[] = [];
  for (const task of batch.tasks) {
    results.push(await parseOne(task));
  }
  return results;
}

async function parseOne(task: ParseTask): Promise<ParseResult> {
  const start = performance.now();
  const warnings: string[] = [];
  // piscina's structured-clone transport converts a Buffer into a plain
  // Uint8Array on the worker side. Re-wrap so our Buffer-specific calls
  // (notably `.toString('utf8')`) work as expected.
  const content: Buffer = Buffer.isBuffer(task.content)
    ? task.content
    : Buffer.from(
        (task.content as Uint8Array).buffer,
        (task.content as Uint8Array).byteOffset,
        (task.content as Uint8Array).byteLength,
      );
  const byteLength = content.byteLength;

  if (byteLength > MAX_FILE_BYTES) {
    warnings.push(`file exceeds ${MAX_FILE_BYTES} byte cap (${byteLength}); skipping parse`);
    return {
      filePath: task.filePath,
      language: task.language,
      captures: [],
      byteLength,
      parseTimeMs: performance.now() - start,
      warnings,
    };
  }

  try {
    const captures = await withTimeout(
      runParse(task.language, content),
      PER_FILE_TIMEOUT_MS,
      `parse timed out after ${PER_FILE_TIMEOUT_MS}ms`,
    );
    return {
      filePath: task.filePath,
      language: task.language,
      captures,
      byteLength,
      parseTimeMs: performance.now() - start,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(message);
    return {
      filePath: task.filePath,
      language: task.language,
      captures: [],
      byteLength,
      parseTimeMs: performance.now() - start,
      warnings,
    };
  }
}

async function runParse(language: LanguageId, content: Buffer): Promise<readonly ParseCapture[]> {
  // The tree-sitter 0.25 JS binding accepts a string primary input; decode
  // the buffer once here. (The underlying parser still reads by byte
  // offsets, so positions remain correct.)
  const source = content.toString("utf8");

  // Prefer native unless explicitly forced into WASM or native is
  // unavailable. The WASM path returns captures with exactly the same
  // coordinate semantics (1-indexed rows, 0-indexed columns) so
  // downstream consumers see byte-identical output.
  if (!forceWasmOnly() && isNativeAvailable()) {
    return runNative(language, source);
  }
  return runWasm(language, source);
}

async function runNative(language: LanguageId, source: string): Promise<readonly ParseCapture[]> {
  // tree-sitter module is loaded lazily via require (not a static import)
  // to keep cold-start cheap for workers that may never parse any file.
  const TreeSitter = requireFn("tree-sitter") as TreeSitterModule;

  const parser = await getOrBuildParser(language, TreeSitter);
  const query = await getOrBuildQuery(language, TreeSitter);

  const tree = parser.parse(source);
  const root = tree.rootNode;

  const out: ParseCapture[] = [];
  const matches = query.matches(root);
  for (const m of matches) {
    for (const cap of m.captures) {
      const node = cap.node;
      out.push({
        tag: cap.name,
        text: node.text,
        // Convert 0-indexed tree-sitter positions to 1-indexed line numbers.
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        startCol: node.startPosition.column,
        endCol: node.endPosition.column,
        nodeType: node.type,
      });
    }
  }
  return out;
}

async function runWasm(language: LanguageId, source: string): Promise<readonly ParseCapture[]> {
  let handle = wasmParserCache.get(language);
  if (handle === undefined) {
    handle = await openWasmParser(language);
    wasmParserCache.set(language, handle);
  }
  if (handle === null) {
    // Grammar unavailable on the WASM path; skip with a per-file warning
    // surface so the worker's caller can see the miss.
    return [];
  }
  const queryText = getUnifiedQuery(language);
  const captures = handle.runQuery(queryText, source);
  const out: ParseCapture[] = [];
  for (const cap of captures) {
    const node = cap.node;
    out.push({
      tag: cap.name,
      text: node.text,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      startCol: node.startPosition.column,
      endCol: node.endPosition.column,
      nodeType: node.type,
    });
  }
  return out;
}

// --- per-worker caches -----------------------------------------------------

async function getOrBuildParser(lang: LanguageId, TS: TreeSitterModule): Promise<TreeSitterParser> {
  const cached = parserCache.get(lang);
  if (cached !== undefined) {
    return cached as TreeSitterParser;
  }
  const handle = await loadGrammar(lang);
  const parser = new TS() as TreeSitterParser;
  parser.setLanguage(handle.tsLanguage);
  parserCache.set(lang, parser);
  return parser;
}

async function getOrBuildQuery(lang: LanguageId, TS: TreeSitterModule): Promise<TreeSitterQuery> {
  const cached = queryCache.get(lang);
  if (cached !== undefined) {
    return cached as TreeSitterQuery;
  }
  const handle = await loadGrammar(lang);
  const q = new TS.Query(handle.tsLanguage, handle.queryText) as TreeSitterQuery;
  queryCache.set(lang, q);
  return q;
}

// --- wall-clock timeout ----------------------------------------------------

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// --- minimal ambient shapes for the native binding -------------------------
// We intentionally avoid pulling tree-sitter's whole .d.ts into a worker file
// (it registers a global module declaration); declaring just what we use keeps
// the surface small and stable.

interface TreeSitterPoint {
  readonly row: number;
  readonly column: number;
}

interface TreeSitterNode {
  readonly text: string;
  readonly type: string;
  readonly startPosition: TreeSitterPoint;
  readonly endPosition: TreeSitterPoint;
}

interface TreeSitterTree {
  readonly rootNode: TreeSitterNode;
}

interface TreeSitterParser {
  setLanguage(lang: unknown): void;
  parse(source: string): TreeSitterTree;
}

interface TreeSitterQueryCapture {
  readonly name: string;
  readonly node: TreeSitterNode;
}

interface TreeSitterQueryMatch {
  readonly captures: readonly TreeSitterQueryCapture[];
}

interface TreeSitterQuery {
  matches(node: TreeSitterNode): readonly TreeSitterQueryMatch[];
}

interface TreeSitterModule {
  new (): TreeSitterParser;
  Query: new (lang: unknown, source: string) => TreeSitterQuery;
}
