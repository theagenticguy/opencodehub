/**
 * Piscina-backed worker pool wrapper with byte-budget chunking.
 *
 * Callers pass a list of tasks; the pool chunks them into batches respecting
 * a byte budget (default 20 MB) and file cap (default 200 files), dispatches
 * each batch to one worker, and collects the results. Output is sorted by
 * `filePath` so two runs with identical inputs produce byte-identical output
 * regardless of worker completion order.
 *
 * Sizing: by default `maxThreads = clamp(os.availableParallelism(), 2, 8)`.
 * Beyond 8 the bottleneck shifts to main-thread GC pressure and file I/O, so
 * we cap there. Callers can override.
 */

import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { Piscina } from "piscina";
import type { ParseBatch, ParseResult, ParseTask } from "./types.js";

// When we compile with tsc, __filename resolution is via import.meta.url.
// The worker file sits next to this one as `parse-worker.js` in dist/.
const WORKER_FILENAME = fileURLToPath(new URL("./parse-worker.js", import.meta.url));

/** Options for a single dispatch() call. */
export interface DispatchOptions {
  /** Max cumulative bytes per worker batch. Default 20 MB. */
  readonly byteBudget?: number;
  /** Max files per worker batch (guards against many-tiny-files). Default 200. */
  readonly fileCap?: number;
}

/** Options passed at pool construction. */
export interface ParsePoolOptions {
  readonly minThreads?: number;
  readonly maxThreads?: number;
}

const DEFAULT_BYTE_BUDGET = 20 * 1024 * 1024;
const DEFAULT_FILE_CAP = 200;

function defaultMaxThreads(): number {
  const cpus = availableParallelism();
  return Math.max(2, Math.min(cpus, 8));
}

/**
 * Main-thread wrapper around the piscina pool.
 */
export class ParsePool {
  readonly #pool: Piscina<ParseBatch, ParseResult[]>;

  constructor(opts: ParsePoolOptions = {}) {
    const minThreads = opts.minThreads ?? 2;
    const maxThreads = opts.maxThreads ?? defaultMaxThreads();
    this.#pool = new Piscina<ParseBatch, ParseResult[]>({
      filename: WORKER_FILENAME,
      minThreads,
      maxThreads,
    });
  }

  /**
   * Dispatch a set of parse tasks across the pool.
   *
   * Results are always sorted by `filePath` so output is deterministic
   * regardless of worker completion order.
   */
  async dispatch(
    tasks: readonly ParseTask[],
    opts: DispatchOptions = {},
  ): Promise<readonly ParseResult[]> {
    if (tasks.length === 0) {
      return [];
    }
    const byteBudget = opts.byteBudget ?? DEFAULT_BYTE_BUDGET;
    const fileCap = opts.fileCap ?? DEFAULT_FILE_CAP;
    const batches = chunkTasks(tasks, byteBudget, fileCap);

    const batchResults = await Promise.all(
      batches.map((batch) => this.#pool.run({ tasks: batch })),
    );

    const flat: ParseResult[] = [];
    for (const br of batchResults) {
      for (const r of br) {
        flat.push(r);
      }
    }
    flat.sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0));
    return flat;
  }

  /** Shut down the pool; pending tasks are aborted. */
  async destroy(): Promise<void> {
    await this.#pool.destroy();
  }
}

/**
 * Walk tasks in input order, accumulating into batches until either the
 * byte budget or file cap is reached. Exported for testing.
 */
export function chunkTasks(
  tasks: readonly ParseTask[],
  byteBudget: number,
  fileCap: number,
): ParseTask[][] {
  const batches: ParseTask[][] = [];
  let current: ParseTask[] = [];
  let currentBytes = 0;
  for (const t of tasks) {
    const size = t.content.byteLength;
    // Flush the current batch BEFORE appending if either:
    //   (a) adding this task would meet or exceed the byte budget, or
    //   (b) the batch is already full by file count.
    // The `>=` on bytes ensures that when a task's size hits the budget exactly
    // it starts a new batch — matching the documented behavior on borderline
    // inputs such as three 5MB files with a 10MB budget → three batches.
    if (current.length > 0 && (currentBytes + size >= byteBudget || current.length >= fileCap)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(t);
    currentBytes += size;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}
