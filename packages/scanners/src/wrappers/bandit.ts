/**
 * Bandit wrapper — Python SAST.
 *
 * Invocation: `bandit -r <projectPath> -f sarif`
 *
 * Requires the `bandit[sarif]` install (which pulls in
 * `bandit-sarif-formatter` ≥1.1.1). If the formatter is missing, bandit
 * falls back to text output and our SARIF parser emits an empty log +
 * warning — graceful degradation.
 *
 * Note: bandit writes SARIF to stdout when `-f sarif` is given WITHOUT
 * `-o <file>`. Passing `.` as the target would confuse bandit (it treats
 * `.` as "current directory" but recurses via `-r` explicitly); we pass
 * `projectPath` so the wrapper works from any CWD.
 */

import { BANDIT_SPEC } from "../catalog.js";
import type { ScannerRunContext, ScannerRunResult, ScannerWrapper } from "../spec.js";
import { DEFAULT_DEPS, invokeScanner, type WrapperDeps } from "./shared.js";

export function createBanditWrapper(deps: WrapperDeps = DEFAULT_DEPS): ScannerWrapper {
  return {
    spec: BANDIT_SPEC,
    run: async (ctx: ScannerRunContext): Promise<ScannerRunResult> => {
      const args: readonly string[] = ["-r", ctx.projectPath, "-f", "sarif", "--quiet"];
      return invokeScanner(BANDIT_SPEC, ctx, "bandit", args, deps);
    },
  };
}
