/**
 * Grype wrapper — container / filesystem vulnerability scan (SARIF-native).
 *
 * Invocation: `grype dir:<projectPath> -o sarif -q`
 *
 * Grype supports multiple sources (image:, dir:, sbom:) via the first
 * positional. We target `dir:<projectPath>` for project-local scans.
 * `-o sarif` emits SARIF 2.1.0 on stdout; `-q` suppresses progress output
 * on stderr so our JSON parser never has to strip interleaved logs.
 *
 * The Grype vulnerability DB is downloaded on first run — this wrapper
 * does NOT manage DB priming. The runner expects `codehub db-sync` to
 * have populated `~/Library/Caches/grype/db/` (macOS) or the platform
 * equivalent beforehand; if the DB is missing, grype still emits a
 * schema-valid empty SARIF + stderr warning, which the shared invoker
 * passes through untouched.
 *
 * License: Apache-2.0.
 */

import { GRYPE_SPEC } from "../catalog.js";
import type { ScannerRunContext, ScannerRunResult, ScannerWrapper } from "../spec.js";
import { DEFAULT_DEPS, invokeScanner, type WrapperDeps } from "./shared.js";

export function createGrypeWrapper(deps: WrapperDeps = DEFAULT_DEPS): ScannerWrapper {
  return {
    spec: GRYPE_SPEC,
    run: (ctx: ScannerRunContext): Promise<ScannerRunResult> => {
      const args: readonly string[] = [`dir:${ctx.projectPath}`, "-o", "sarif", "-q"];
      return invokeScanner(GRYPE_SPEC, ctx, "grype", args, deps);
    },
  };
}
