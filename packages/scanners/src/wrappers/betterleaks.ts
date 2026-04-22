/**
 * Betterleaks wrapper — secret detection (gitleaks fork by the original
 * gitleaks author).
 *
 * Invocation: `betterleaks dir --report-format=sarif --report-path=/dev/stdout .`
 *
 * Betterleaks emits SARIF natively. We route the report to stdout
 * (`/dev/stdout` on POSIX; on Windows we skip the flag and let
 * betterleaks write to the default `gitleaks.report.json` file — but
 * v1.0 targets POSIX CI runners).
 */

import { BETTERLEAKS_SPEC } from "../catalog.js";
import type { ScannerRunContext, ScannerRunResult, ScannerWrapper } from "../spec.js";
import { DEFAULT_DEPS, invokeScanner, type WrapperDeps } from "./shared.js";

const BETTERLEAKS_ARGS: readonly string[] = [
  "dir",
  "--report-format=sarif",
  "--report-path=/dev/stdout",
  "--no-banner",
  ".",
];

export function createBetterleaksWrapper(deps: WrapperDeps = DEFAULT_DEPS): ScannerWrapper {
  return {
    spec: BETTERLEAKS_SPEC,
    run: (ctx: ScannerRunContext): Promise<ScannerRunResult> =>
      invokeScanner(BETTERLEAKS_SPEC, ctx, "betterleaks", BETTERLEAKS_ARGS, deps),
  };
}
