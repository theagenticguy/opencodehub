/**
 * Trivy wrapper — polyglot vulnerability / IaC / secret scanner.
 *
 * Invocation: `trivy fs --format sarif --severity HIGH,CRITICAL
 *              --ignore-unfixed --skip-db-update --skip-java-db-update
 *              --offline-scan --quiet <projectPath>`
 *
 * - `fs` mode covers lockfiles, IaC, Dockerfiles, and secrets in one pass.
 * - `--format sarif` emits SARIF 2.1.0 on stdout (no `-o <file>` needed
 *   when stdout is SARIF-parseable).
 * - `--severity HIGH,CRITICAL` matches the default scan gate.
 * - `--ignore-unfixed` drops findings with no available fix.
 * - `--skip-db-update` / `--skip-java-db-update` / `--offline-scan` keep
 *   v1.0 CI fully offline; the DB is expected to be pre-primed by
 *   `codehub db-sync` (see W4-G.3).
 *
 * License: Apache-2.0 — still invoked as an external binary for runtime
 * isolation.
 */

import { TRIVY_SPEC } from "../catalog.js";
import type { ScannerRunContext, ScannerRunResult, ScannerWrapper } from "../spec.js";
import { DEFAULT_DEPS, invokeScanner, type WrapperDeps } from "./shared.js";

export function createTrivyWrapper(deps: WrapperDeps = DEFAULT_DEPS): ScannerWrapper {
  return {
    spec: TRIVY_SPEC,
    run: (ctx: ScannerRunContext): Promise<ScannerRunResult> => {
      const args: readonly string[] = [
        "fs",
        "--format",
        "sarif",
        "--severity",
        "HIGH,CRITICAL",
        "--ignore-unfixed",
        "--skip-db-update",
        "--skip-java-db-update",
        "--offline-scan",
        "--quiet",
        ctx.projectPath,
      ];
      return invokeScanner(TRIVY_SPEC, ctx, "trivy", args, deps);
    },
  };
}
