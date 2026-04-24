/**
 * OSV-Scanner wrapper — dependency vulnerability scanner.
 *
 * Invocation: `osv-scanner scan --format=sarif --offline-vulnerabilities
 *              --recursive .`
 *
 * We enable offline mode by default — OpenCodeHub's v1.0 posture is that
 * the vulnerability database is pre-synced by `codehub db-sync`.
 * `--offline-vulnerabilities` keeps the tool from reaching osv.dev while
 * still allowing local lockfile resolution to touch manifests on disk.
 */

import { OSV_SCANNER_SPEC } from "../catalog.js";
import type { ScannerRunContext, ScannerRunResult, ScannerWrapper } from "../spec.js";
import { DEFAULT_DEPS, invokeScanner, type WrapperDeps } from "./shared.js";

const OSV_ARGS: readonly string[] = [
  "scan",
  "--format=sarif",
  "--offline-vulnerabilities",
  "--recursive",
  ".",
];

export function createOsvScannerWrapper(deps: WrapperDeps = DEFAULT_DEPS): ScannerWrapper {
  return {
    spec: OSV_SCANNER_SPEC,
    run: (ctx: ScannerRunContext): Promise<ScannerRunResult> =>
      invokeScanner(OSV_SCANNER_SPEC, ctx, "osv-scanner", OSV_ARGS, deps),
  };
}
