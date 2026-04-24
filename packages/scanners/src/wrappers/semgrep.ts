/**
 * Semgrep wrapper.
 *
 * Invocation: `semgrep --config=p/owasp-top-ten --config=p/security-audit
 *              --sarif --quiet --timeout=30 .`
 *
 * Semgrep emits SARIF v2.1.0 natively on stdout when `--sarif` is set.
 * We pass `--quiet` to suppress progress output on stderr, and
 * `--timeout=30` as the per-rule-per-file timeout (cumulative wall-clock
 * still honours the runner's `timeoutMs`).
 *
 * License note: semgrep CLI is LGPL-2.1; rules are MIT. This wrapper
 * invokes the CLI as a separate process — NO semgrep source is linked
 * into the JS runtime.
 */

import { SEMGREP_SPEC } from "../catalog.js";
import type { ScannerRunContext, ScannerRunResult, ScannerWrapper } from "../spec.js";
import { DEFAULT_DEPS, invokeScanner, type WrapperDeps } from "./shared.js";

const SEMGREP_ARGS: readonly string[] = [
  "--config=p/owasp-top-ten",
  "--config=p/security-audit",
  "--sarif",
  "--quiet",
  "--timeout=30",
  "--disable-version-check",
  "--metrics=off",
  ".",
];

export function createSemgrepWrapper(deps: WrapperDeps = DEFAULT_DEPS): ScannerWrapper {
  return {
    spec: SEMGREP_SPEC,
    run: (ctx: ScannerRunContext): Promise<ScannerRunResult> =>
      invokeScanner(SEMGREP_SPEC, ctx, "semgrep", SEMGREP_ARGS, deps),
  };
}
