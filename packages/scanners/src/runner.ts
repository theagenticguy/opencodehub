/**
 * Scanner runner — spawn N scanners in parallel, merge their SARIF logs.
 *
 * Design notes:
 *   - Concurrency is bounded by min(os.availableParallelism(), opts.concurrency ?? 4).
 *     Scanners are memory-heavy (semgrep can reach 4GB on large repos); running
 *     more than 4 at once on a laptop invites OOM.
 *   - Each wrapper is responsible for converting its output to a SarifLog.
 *     Missing binaries and timeouts yield an empty SARIF run (so the
 *     merged output still records which scanners were attempted).
 *   - A single wrapper failure never aborts the overall run. We log the
 *     message via `onProgress` and continue.
 *   - We intentionally avoid `p-limit` — a 15-line inline limiter keeps
 *     the dependency surface smaller.
 */

import os from "node:os";
import { mergeSarif, type SarifLog } from "@opencodehub/sarif";
import {
  emptySarifFor,
  type ScannerRunResult,
  type ScannerSpec,
  type ScannerWrapper,
} from "./spec.js";

export type ScannerStatus = "start" | "done" | "error" | "skipped";

export interface RunScannersOptions {
  /** Cap on parallel scanners. Default min(availableParallelism(), 4). */
  readonly concurrency?: number;
  /** Wall-clock timeout per scanner in ms. Default 300_000 (5 min). */
  readonly timeoutMs?: number;
  /** Per-scanner lifecycle callback — useful for CLI progress logs. */
  readonly onProgress?: (spec: ScannerSpec, status: ScannerStatus, note?: string) => void;
}

export interface RunScannersResult {
  /** Merged SARIF log across every scanner that produced output. */
  readonly sarif: SarifLog;
  /** Per-scanner outcome. */
  readonly runs: readonly ScannerRunResult[];
  /** Scanners whose wrapper threw. */
  readonly errored: readonly { readonly spec: ScannerSpec; readonly error: string }[];
}

/**
 * Run the given set of scanner wrappers against `projectPath`. Returns a
 * merged SARIF plus per-scanner outcomes. The merged log contains one
 * SARIF run per scanner that was attempted, even if the scanner emitted
 * zero results (so downstream consumers can tell which tools ran).
 */
export async function runScanners(
  projectPath: string,
  wrappers: readonly ScannerWrapper[],
  opts: RunScannersOptions = {},
): Promise<RunScannersResult> {
  const concurrency = Math.max(
    1,
    Math.min(opts.concurrency ?? 4, os.availableParallelism?.() ?? 4),
  );
  const timeoutMs = opts.timeoutMs ?? 300_000;

  const runs: ScannerRunResult[] = new Array(wrappers.length);
  const errored: { spec: ScannerSpec; error: string }[] = [];

  let nextIdx = 0;
  async function worker(): Promise<void> {
    while (true) {
      const myIdx = nextIdx;
      nextIdx += 1;
      if (myIdx >= wrappers.length) return;
      const wrapper = wrappers[myIdx];
      if (!wrapper) return;
      const spec = wrapper.spec;
      const started = performance.now();
      opts.onProgress?.(spec, "start");
      try {
        const result = await wrapper.run({
          projectPath,
          timeoutMs,
          onWarn: (m: string) => opts.onProgress?.(spec, "skipped", m),
        });
        runs[myIdx] = result;
        opts.onProgress?.(spec, result.skipped ? "skipped" : "done", result.skipped);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errored.push({ spec, error: message });
        runs[myIdx] = {
          spec,
          sarif: emptySarifFor(spec),
          skipped: `errored: ${message}`,
          durationMs: performance.now() - started,
        };
        opts.onProgress?.(spec, "error", message);
      }
    }
  }

  // Launch worker pool; wait for all to drain.
  const pool: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i += 1) {
    pool.push(worker());
  }
  await Promise.all(pool);

  const sarif = mergeSarif(
    runs.filter((r): r is ScannerRunResult => r !== undefined).map((r) => r.sarif),
  );
  return { sarif, runs, errored };
}
