/**
 * Radon wrapper — Python cyclomatic complexity (JSON → SARIF shim).
 *
 * Invocation: `radon cc -s -j <projectPath>`
 *
 * - `cc`  = cyclomatic-complexity analyser
 * - `-s`  = include the numeric score alongside the rank
 * - `-j`  = JSON output (map of { <file>: [ blocks... ] })
 *
 * We pass the absolute project path so radon works regardless of CWD.
 * The JSON shape is converted by `radonJsonToSarif`, which emits one
 * SARIF result per block with `complexity > 10`.
 *
 * License: MIT.
 */

import { RADON_SPEC } from "../catalog.js";
import { radonJsonToSarif } from "../converters/radon-to-sarif.js";
import { tryParseJson } from "../exec.js";
import type { ScannerRunContext, ScannerRunResult, ScannerWrapper } from "../spec.js";
import { emptySarifFor } from "../spec.js";
import { DEFAULT_DEPS, type WrapperDeps } from "./shared.js";

export function createRadonWrapper(deps: WrapperDeps = DEFAULT_DEPS): ScannerWrapper {
  return {
    spec: RADON_SPEC,
    run: async (ctx: ScannerRunContext): Promise<ScannerRunResult> => {
      const started = performance.now();
      const probe = await deps.which("radon");
      if (!probe.found) {
        const msg = `${RADON_SPEC.id}: binary 'radon' not found on PATH (install: ${RADON_SPEC.installCmd}).`;
        ctx.onWarn?.(msg);
        return {
          spec: RADON_SPEC,
          sarif: emptySarifFor(RADON_SPEC),
          skipped: msg,
          durationMs: performance.now() - started,
        };
      }
      const args: readonly string[] = ["cc", "-s", "-j", ctx.projectPath];
      const result = await deps.runBinary("radon", args, {
        timeoutMs: ctx.timeoutMs,
        cwd: ctx.projectPath,
      });
      const json = tryParseJson(result.stdout);
      if (json === undefined) {
        ctx.onWarn?.(
          `${RADON_SPEC.id}: stdout was not valid JSON (stderr: ${truncate(result.stderr, 200)}); emitting empty SARIF.`,
        );
        return {
          spec: RADON_SPEC,
          sarif: emptySarifFor(RADON_SPEC),
          durationMs: performance.now() - started,
        };
      }
      const sarif = radonJsonToSarif(json);
      return {
        spec: RADON_SPEC,
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
