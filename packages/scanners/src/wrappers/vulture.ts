/**
 * Vulture wrapper — Python dead-code detection (stdout → SARIF shim).
 *
 * Invocation: `vulture <projectPath> --min-confidence 80`
 *
 * Vulture does not emit SARIF. The wrapper parses its line-oriented
 * stdout via `vultureStdoutToSarif`. Exit code 1 indicates findings and
 * 3 indicates a malformed input; both still yield parseable stdout, so
 * we tolerate non-zero exits and only warn on truly hard failures (2,
 * ≥64 signal-kill). See `converters/vulture-to-sarif.ts` for the parse
 * rules and properties shape.
 *
 * License: MIT.
 */

import { VULTURE_SPEC } from "../catalog.js";
import { vultureStdoutToSarif } from "../converters/vulture-to-sarif.js";
import type { ScannerRunContext, ScannerRunResult, ScannerWrapper } from "../spec.js";
import { emptySarifFor } from "../spec.js";
import { DEFAULT_DEPS, type WrapperDeps } from "./shared.js";

/** Minimum confidence percentage vulture emits findings at. */
const DEFAULT_MIN_CONFIDENCE = "80";

export function createVultureWrapper(deps: WrapperDeps = DEFAULT_DEPS): ScannerWrapper {
  return {
    spec: VULTURE_SPEC,
    run: async (ctx: ScannerRunContext): Promise<ScannerRunResult> => {
      const started = performance.now();
      const probe = await deps.which("vulture");
      if (!probe.found) {
        const msg = `${VULTURE_SPEC.id}: binary 'vulture' not found on PATH (install: ${VULTURE_SPEC.installCmd}).`;
        ctx.onWarn?.(msg);
        return {
          spec: VULTURE_SPEC,
          sarif: emptySarifFor(VULTURE_SPEC),
          skipped: msg,
          durationMs: performance.now() - started,
        };
      }
      const args: readonly string[] = [ctx.projectPath, "--min-confidence", DEFAULT_MIN_CONFIDENCE];
      const result = await deps.runBinary("vulture", args, {
        timeoutMs: ctx.timeoutMs,
        cwd: ctx.projectPath,
      });
      const sarif = vultureStdoutToSarif(result.stdout);
      if (result.exitCode !== 0 && result.exitCode !== 1 && result.exitCode !== 3) {
        ctx.onWarn?.(
          `${VULTURE_SPEC.id}: exit code ${result.exitCode}; stderr: ${truncate(result.stderr, 200)}`,
        );
      }
      return {
        spec: VULTURE_SPEC,
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
