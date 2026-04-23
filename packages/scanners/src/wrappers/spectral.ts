/**
 * Spectral wrapper — OpenAPI / AsyncAPI / Arazzo lint.
 *
 * Invocation: `spectral lint --format sarif --fail-severity off --quiet
 *              <file1> <file2> ...`
 *
 * - Spectral 6.15+ ships a native `sarif` reporter; stdout is SARIF 2.1.0.
 * - `--fail-severity off` prevents spectral from exiting non-zero on
 *   findings (we want SARIF regardless).
 * - Spectral expects an explicit file list. The wrapper accepts a list
 *   of API contract files via `SpectralWrapperOptions.contractFiles`.
 *   When empty the wrapper short-circuits to empty SARIF + skipped.
 *
 * License: Apache-2.0.
 */

import { SPECTRAL_SPEC } from "../catalog.js";
import type { ScannerRunContext, ScannerRunResult, ScannerWrapper } from "../spec.js";
import { emptySarifFor } from "../spec.js";
import { DEFAULT_DEPS, invokeScanner, type WrapperDeps } from "./shared.js";

export interface SpectralWrapperOptions {
  /**
   * List of API contract files to lint (repo-relative or absolute). Must
   * be populated — Spectral does not recurse a directory. An empty list
   * short-circuits to empty SARIF.
   */
  readonly contractFiles?: readonly string[];
}

export function createSpectralWrapper(
  deps: WrapperDeps = DEFAULT_DEPS,
  opts: SpectralWrapperOptions = {},
): ScannerWrapper {
  return {
    spec: SPECTRAL_SPEC,
    run: async (ctx: ScannerRunContext): Promise<ScannerRunResult> => {
      const files = (opts.contractFiles ?? []).filter((f) => f.length > 0);
      if (files.length === 0) {
        return {
          spec: SPECTRAL_SPEC,
          sarif: emptySarifFor(SPECTRAL_SPEC),
          skipped: "spectral: no API contract files to lint",
          durationMs: 0,
        };
      }
      const args: readonly string[] = [
        "lint",
        "--format",
        "sarif",
        "--fail-severity",
        "off",
        "--quiet",
        ...files,
      ];
      return invokeScanner(SPECTRAL_SPEC, ctx, "spectral", args, deps);
    },
  };
}
