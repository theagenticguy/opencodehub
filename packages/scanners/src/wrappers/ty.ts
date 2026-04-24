/**
 * ty wrapper — Python type-checker (beta, stdout → SARIF shim).
 *
 * Invocation: `ty check <projectPath>`
 *
 * ty is a beta Python type-checker from Astral; its CLI is still
 * stabilizing. The text output is mypy-style:
 *
 *   src/app.py:42: error: Argument 1 ... [arg-type]
 *
 * `tyStdoutToSarif` handles the parse (including optional column and
 * rule-id suffix). Exit code 1 is the conventional "findings exist"
 * signal and is tolerated by this wrapper.
 *
 * License: MIT.
 */

import { TY_SPEC } from "../catalog.js";
import { tyStdoutToSarif } from "../converters/ty-to-sarif.js";
import type { ScannerRunContext, ScannerRunResult, ScannerWrapper } from "../spec.js";
import { emptySarifFor } from "../spec.js";
import { DEFAULT_DEPS, type WrapperDeps } from "./shared.js";

export function createTyWrapper(deps: WrapperDeps = DEFAULT_DEPS): ScannerWrapper {
  return {
    spec: TY_SPEC,
    run: async (ctx: ScannerRunContext): Promise<ScannerRunResult> => {
      const started = performance.now();
      const probe = await deps.which("ty");
      if (!probe.found) {
        const msg = `${TY_SPEC.id}: binary 'ty' not found on PATH (install: ${TY_SPEC.installCmd}).`;
        ctx.onWarn?.(msg);
        return {
          spec: TY_SPEC,
          sarif: emptySarifFor(TY_SPEC),
          skipped: msg,
          durationMs: performance.now() - started,
        };
      }
      const args: readonly string[] = ["check", ctx.projectPath];
      const result = await deps.runBinary("ty", args, {
        timeoutMs: ctx.timeoutMs,
        cwd: ctx.projectPath,
      });
      const sarif = tyStdoutToSarif(result.stdout);
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        ctx.onWarn?.(
          `${TY_SPEC.id}: exit code ${result.exitCode}; stderr: ${truncate(result.stderr, 200)}`,
        );
      }
      return {
        spec: TY_SPEC,
        sarif,
        durationMs: performance.now() - started,
      };
    },
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s.trim();
  return `${s.slice(0, max).trim()}…`;
}
