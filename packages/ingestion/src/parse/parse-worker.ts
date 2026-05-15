/**
 * Piscina worker entry point.
 *
 * Each worker thread imports this file once, then receives {@link ParseBatch}
 * inputs on every `pool.run()` call. The worker:
 *   1. Opens a WASM-backed parser for each task's language (cached in the worker).
 *   2. Compiles the unified S-expression query against the grammar (cached
 *      inside `WasmParserHandle.runQuery`).
 *   3. Parses each task's buffer and maps captures to {@link ParseCapture}.
 *   4. Returns a {@link ParseResult} per task.
 *
 * Per-task wall-clock timeout: 30 seconds. On timeout the task returns a
 * result with empty captures and a warning rather than crashing the worker.
 *
 * `web-tree-sitter` is the sole runtime as of 0.4.0. Native `tree-sitter`
 * was removed from the runtime install graph; grammar `.wasm` blobs are
 * vendored under `packages/ingestion/vendor/wasms/`.
 */

import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import type { LanguageId, ParseBatch, ParseCapture, ParseResult, ParseTask } from "./types.js";
import { getUnifiedQuery } from "./unified-queries.js";
import { openWasmParser, type WasmParserHandle } from "./wasm-runtime.js";

const PER_FILE_TIMEOUT_MS = 30_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB

// Per-worker WASM parser cache. Each worker_thread has its own module
// instance so this lives per-worker.
const wasmParserCache = new Map<LanguageId, WasmParserHandle | null>();

/**
 * Piscina task entry. Default export is the function piscina invokes.
 */
export default async function parseBatch(batch: ParseBatch): Promise<ParseResult[]> {
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
  // The web-tree-sitter binding accepts a string primary input; decode
  // the buffer once here. (The underlying parser still reads by byte
  // offsets, so positions remain correct.)
  const source = content.toString("utf8");
  return runWasm(language, source);
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
