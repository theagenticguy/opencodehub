/**
 * Ruff wrapper — Python lint & format (SARIF-native).
 *
 * Invocation: `ruff check --output-format sarif --no-cache --exit-zero .`
 *
 * Ruff 0.7+ supports `--output-format sarif` and writes SARIF 2.1.0 to
 * stdout when no `--output-file` is given. `--no-cache` keeps runs
 * hermetic (CI caches the repo-level .codehub directory separately) and
 * `--exit-zero` mirrors the rest of the scanner suite: findings should
 * not cause a non-zero exit that the shared `invokeScanner` would flag.
 *
 * License: MIT.
 */

import { RUFF_SPEC } from "../catalog.js";
import type { ScannerRunContext, ScannerRunResult, ScannerWrapper } from "../spec.js";
import { DEFAULT_DEPS, invokeScanner, type WrapperDeps } from "./shared.js";

const RUFF_ARGS: readonly string[] = [
  "check",
  "--output-format",
  "sarif",
  "--no-cache",
  "--exit-zero",
  ".",
];

export function createRuffWrapper(deps: WrapperDeps = DEFAULT_DEPS): ScannerWrapper {
  return {
    spec: RUFF_SPEC,
    run: (ctx: ScannerRunContext): Promise<ScannerRunResult> =>
      invokeScanner(RUFF_SPEC, ctx, "ruff", RUFF_ARGS, deps),
  };
}
