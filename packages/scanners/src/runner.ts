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

/**
 * Per-scanner lifecycle status.
 *
 *   - `start`   — the wrapper began executing.
 *   - `warn`    — the wrapper surfaced an advisory via `onWarn` (e.g. a
 *                 non-clean exit code, or a SARIF-parse fallback). The scan
 *                 still ran and produced (possibly empty) output. Distinct
 *                 from `skipped` so callers don't mislabel "ran with a
 *                 non-zero exit" as "did not run".
 *   - `done`    — the wrapper finished and produced output.
 *   - `skipped` — the scan did not run (binary missing, etc.); `note`
 *                 carries the reason.
 *   - `error`   — the wrapper threw; `note` carries the error message.
 */
export type ScannerStatus = "start" | "warn" | "done" | "error" | "skipped";

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
        // Wrappers call `onWarn` for advisories (non-clean exit code, SARIF
        // parse fallback) and ALSO return a `skipped` string when the scan
        // did not run. Route `onWarn` to the `warn` status (scan ran, here's
        // a note) — NOT `skipped` — and track that it fired. Without this:
        //   (1) a missing-binary wrapper that calls onWarn AND returns
        //       `skipped` re-printed the same line twice (the duplicate
        //       `pip-audit skipped: ...` lines), and
        //   (2) an advisory-only wrapper (osv-scanner exit 127) was mislabeled
        //       "skipped: ..." and then immediately followed by a "done" line.
        // We coalesce the terminal event: when the wrapper already surfaced
        // its `skipped` reason via `onWarn`, emit the terminal lifecycle
        // status with no duplicate note.
        let warned = false;
        const result = await wrapper.run({
          projectPath,
          timeoutMs,
          onWarn: (m: string) => {
            warned = true;
            opts.onProgress?.(spec, "warn", m);
          },
        });
        runs[myIdx] = result;
        const terminal: ScannerStatus = result.skipped ? "skipped" : "done";
        // If the wrapper already explained itself via onWarn, don't repeat
        // the note on the terminal line.
        opts.onProgress?.(spec, terminal, warned ? undefined : result.skipped);
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
