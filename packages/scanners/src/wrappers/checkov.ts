/**
 * Checkov wrapper — multi-framework IaC security scanner.
 *
 * Invocation: `checkov -d <projectPath> --framework <csv> -o sarif --quiet
 *              --soft-fail`
 *
 * - Checkov writes SARIF to stdout when `-o sarif` is the only `-o` flag.
 * - `--framework` limits scanning to the profile-relevant frameworks to
 *   avoid spending time on manifests we know aren't present; the default
 *   `all` would re-scan everything. The runner passes the framework list
 *   derived from ProjectProfile.iacTypes; empty → `all`.
 * - `--soft-fail` prevents Checkov from exiting non-zero on findings so
 *   we can still parse the SARIF (scanners.runBinary also tolerates
 *   non-zero; `--soft-fail` is belt-and-suspenders).
 *
 * License: Apache-2.0.
 */

import { CHECKOV_SPEC } from "../catalog.js";
import type { ScannerRunContext, ScannerRunResult, ScannerWrapper } from "../spec.js";
import { DEFAULT_DEPS, invokeScanner, type WrapperDeps } from "./shared.js";

/**
 * Map ProjectProfile.iacTypes names to Checkov's `--framework` vocabulary.
 * Unknown IaC types are silently dropped — Checkov would reject them.
 */
const IAC_TO_CHECKOV_FRAMEWORK: Readonly<Record<string, string>> = {
  terraform: "terraform",
  cloudformation: "cloudformation",
  kubernetes: "kubernetes",
  docker: "dockerfile",
  "docker-compose": "dockerfile",
};

export interface CheckovWrapperOptions {
  /**
   * Frameworks to enable. Typically mirrors ProjectProfile.iacTypes. Empty
   * array / undefined → default to `all`.
   */
  readonly frameworks?: readonly string[];
}

export function createCheckovWrapper(
  deps: WrapperDeps = DEFAULT_DEPS,
  opts: CheckovWrapperOptions = {},
): ScannerWrapper {
  return {
    spec: CHECKOV_SPEC,
    run: (ctx: ScannerRunContext): Promise<ScannerRunResult> => {
      const frameworkList = (opts.frameworks ?? [])
        .map((t) => IAC_TO_CHECKOV_FRAMEWORK[t.toLowerCase()])
        .filter((v): v is string => typeof v === "string");
      const uniqueFrameworks = [...new Set(frameworkList)];
      const frameworkArg = uniqueFrameworks.length > 0 ? uniqueFrameworks.join(",") : "all";
      const args: readonly string[] = [
        "-d",
        ctx.projectPath,
        "--framework",
        frameworkArg,
        "-o",
        "sarif",
        "--quiet",
        "--soft-fail",
      ];
      return invokeScanner(CHECKOV_SPEC, ctx, "checkov", args, deps);
    },
  };
}
