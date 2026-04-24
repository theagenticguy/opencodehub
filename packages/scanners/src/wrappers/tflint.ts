/**
 * tflint wrapper — Terraform lint.
 *
 * LICENSE NOTE (MPL-2.0 + BUSL-1.1): tflint carries file-level MPL-2.0
 * and BUSL-1.1 notices that are INCOMPATIBLE with vendoring or linking
 * into this Apache-2.0 package. The wrapper therefore MUST NOT `import`
 * or `require` any tflint source. It spawns the external OS `tflint`
 * binary, captures stdout SARIF, and returns an empty SARIF + warning
 * when the binary is missing.
 *
 * Invocation: `tflint --format sarif --chdir=<projectPath> --force`
 *
 * - `--format sarif` emits SARIF 2.1.0 on stdout.
 * - `--chdir=<path>` runs tflint against the target directory without
 *   requiring us to `cd` into it (child-process cwd is set anyway by
 *   `runBinary`, but `--chdir` is the tflint-documented way).
 * - `--force` prevents tflint from exiting non-zero on findings — we
 *   want stdout SARIF regardless of severity. runBinary already
 *   tolerates non-zero, but `--force` keeps stderr clean.
 */

import { TFLINT_SPEC } from "../catalog.js";
import type { ScannerRunContext, ScannerRunResult, ScannerWrapper } from "../spec.js";
import { DEFAULT_DEPS, invokeScanner, type WrapperDeps } from "./shared.js";

export function createTflintWrapper(deps: WrapperDeps = DEFAULT_DEPS): ScannerWrapper {
  return {
    spec: TFLINT_SPEC,
    run: (ctx: ScannerRunContext): Promise<ScannerRunResult> => {
      const args: readonly string[] = [
        "--format",
        "sarif",
        `--chdir=${ctx.projectPath}`,
        "--force",
      ];
      return invokeScanner(TFLINT_SPEC, ctx, "tflint", args, deps);
    },
  };
}
