/**
 * ClamAV wrapper — filesystem antivirus (stdout → SARIF shim).
 *
 * LICENSE NOTE (GPL-2.0-only): ClamAV is GPL-2.0-only licensed and this
 * wrapper MUST NOT import or vendor any ClamAV source. It spawns the
 * external `clamscan` binary only. If the binary is missing the wrapper
 * emits an empty SARIF + warning.
 *
 * Invocation: `clamscan --recursive --infected --no-summary <projectPath>`
 *
 * clamscan exit codes (clamscan(1)):
 *   0 → clean (no virus). Empty SARIF.
 *   1 → virus(es) found. Parse FOUND lines.
 *   2 → error. Empty SARIF + stderr warning.
 *
 * License: GPL-2.0-only — external binary only.
 */

import { CLAMAV_SPEC } from "../catalog.js";
import { clamavStdoutToSarif } from "../converters/clamav-to-sarif.js";
import type { ScannerRunContext, ScannerRunResult, ScannerWrapper } from "../spec.js";
import { emptySarifFor } from "../spec.js";
import { DEFAULT_DEPS, type WrapperDeps } from "./shared.js";

export function createClamAvWrapper(deps: WrapperDeps = DEFAULT_DEPS): ScannerWrapper {
  return {
    spec: CLAMAV_SPEC,
    run: async (ctx: ScannerRunContext): Promise<ScannerRunResult> => {
      const started = performance.now();
      const probe = await deps.which("clamscan");
      if (!probe.found) {
        const msg = `${CLAMAV_SPEC.id}: binary 'clamscan' not found on PATH (install: ${CLAMAV_SPEC.installCmd}).`;
        ctx.onWarn?.(msg);
        return {
          spec: CLAMAV_SPEC,
          sarif: emptySarifFor(CLAMAV_SPEC),
          skipped: msg,
          durationMs: performance.now() - started,
        };
      }
      const args: readonly string[] = [
        "--recursive",
        "--infected",
        "--no-summary",
        ctx.projectPath,
      ];
      const result = await deps.runBinary("clamscan", args, {
        timeoutMs: ctx.timeoutMs,
        cwd: ctx.projectPath,
      });
      if (result.exitCode === 0) {
        return {
          spec: CLAMAV_SPEC,
          sarif: emptySarifFor(CLAMAV_SPEC),
          durationMs: performance.now() - started,
        };
      }
      if (result.exitCode === 1) {
        const sarif = clamavStdoutToSarif(result.stdout);
        return {
          spec: CLAMAV_SPEC,
          sarif,
          durationMs: performance.now() - started,
        };
      }
      // Exit 2 (or anything unexpected) — scanner error. Emit empty SARIF.
      const msg = `${CLAMAV_SPEC.id}: exit code ${result.exitCode}; stderr: ${truncate(
        result.stderr,
        200,
      )}`;
      ctx.onWarn?.(msg);
      return {
        spec: CLAMAV_SPEC,
        sarif: emptySarifFor(CLAMAV_SPEC),
        durationMs: performance.now() - started,
      };
    },
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s.trim();
  return `${s.slice(0, max).trim()}…`;
}
