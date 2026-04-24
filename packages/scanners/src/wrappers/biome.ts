/**
 * Biome wrapper — JS/TS lint & format with native SARIF.
 *
 * Invocation: `biome lint --reporter=sarif <projectPath>`
 *
 * Biome 2.4+ ships the `sarif` reporter natively — the SARIF 2.1.0 log
 * goes to stdout. Older Biome versions (<2.4) emit only GitHub / JSON /
 * pretty reporters, so we'd need a converter; v1.0 pins 2.4.0 so the
 * native path always applies.
 *
 * We detect Biome two ways: first via `biome` on PATH (global install),
 * then fall back to `pnpm exec biome` for project-local installs. If
 * both fail, we emit an empty SARIF with a warning.
 */

import { BIOME_SPEC } from "../catalog.js";
import type { ScannerRunContext, ScannerRunResult, ScannerWrapper } from "../spec.js";
import { emptySarifFor } from "../spec.js";
import { DEFAULT_DEPS, invokeScanner, parseSarifOrEmpty, type WrapperDeps } from "./shared.js";

export function createBiomeWrapper(deps: WrapperDeps = DEFAULT_DEPS): ScannerWrapper {
  return {
    spec: BIOME_SPEC,
    run: async (ctx: ScannerRunContext): Promise<ScannerRunResult> => {
      const started = performance.now();
      const args: readonly string[] = ["lint", "--reporter=sarif", ctx.projectPath];

      // First try a global `biome` on PATH.
      const probe = await deps.which("biome");
      if (probe.found) {
        return invokeScanner(BIOME_SPEC, ctx, "biome", args, deps);
      }

      // Fall back to `pnpm exec biome` — works when Biome is a project-
      // local devDependency. We probe pnpm first so "neither installed"
      // yields a clean warning rather than a spawn error.
      const pnpm = await deps.which("pnpm");
      if (!pnpm.found) {
        const msg = `${BIOME_SPEC.id}: neither 'biome' nor 'pnpm' on PATH (install: ${BIOME_SPEC.installCmd}).`;
        ctx.onWarn?.(msg);
        return {
          spec: BIOME_SPEC,
          sarif: emptySarifFor(BIOME_SPEC),
          skipped: msg,
          durationMs: performance.now() - started,
        };
      }
      const result = await deps.runBinary("pnpm", ["exec", "biome", ...args], {
        timeoutMs: ctx.timeoutMs,
        cwd: ctx.projectPath,
      });
      const sarif = parseSarifOrEmpty(result.stdout, BIOME_SPEC, ctx.onWarn);
      return {
        spec: BIOME_SPEC,
        sarif,
        durationMs: performance.now() - started,
      };
    },
  };
}
