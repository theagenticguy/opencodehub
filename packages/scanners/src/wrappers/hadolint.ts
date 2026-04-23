/**
 * hadolint wrapper — Dockerfile lint.
 *
 * LICENSE NOTE (GPL-3.0): hadolint is GPL-3.0 licensed, which is
 * INCOMPATIBLE with OpenCodeHub's Apache-2.0 distribution terms. This
 * wrapper therefore MUST NOT `import` or `require` any hadolint source,
 * and MUST NOT vendor hadolint binaries into this repo. It spawns the
 * external OS `hadolint` binary and parses its stdout. If the binary is
 * missing, the wrapper emits an empty SARIF + warning via the shared
 * `invokeScanner` path — never crashes.
 *
 * Invocation: `hadolint --format sarif --no-fail -- <file1> <file2> ...`
 *
 * Because hadolint takes a list of explicit Dockerfile paths (it does
 * NOT recurse a directory), the wrapper accepts a list of Dockerfile
 * paths via `HadolintWrapperOptions.dockerfiles`. When the list is empty
 * (no Dockerfiles detected) the wrapper short-circuits to empty SARIF.
 * Callers that don't know the list can pass the project-relative default
 * `Dockerfile`; hadolint prints a clean warning and exits 0.
 */

import { HADOLINT_SPEC } from "../catalog.js";
import type { ScannerRunContext, ScannerRunResult, ScannerWrapper } from "../spec.js";
import { emptySarifFor } from "../spec.js";
import { DEFAULT_DEPS, invokeScanner, type WrapperDeps } from "./shared.js";

export interface HadolintWrapperOptions {
  /**
   * Explicit Dockerfile paths (relative to the repo root or absolute).
   * If empty / undefined, the wrapper defaults to `["Dockerfile"]`.
   */
  readonly dockerfiles?: readonly string[];
}

export function createHadolintWrapper(
  deps: WrapperDeps = DEFAULT_DEPS,
  opts: HadolintWrapperOptions = {},
): ScannerWrapper {
  return {
    spec: HADOLINT_SPEC,
    run: async (ctx: ScannerRunContext): Promise<ScannerRunResult> => {
      const dockerfiles = (opts.dockerfiles ?? []).filter((p) => p.length > 0);
      const targets = dockerfiles.length > 0 ? dockerfiles : ["Dockerfile"];
      if (targets.length === 0) {
        return {
          spec: HADOLINT_SPEC,
          sarif: emptySarifFor(HADOLINT_SPEC),
          skipped: "hadolint: no Dockerfile targets to scan",
          durationMs: 0,
        };
      }
      const args: readonly string[] = ["--format", "sarif", "--no-fail", "--", ...targets];
      return invokeScanner(HADOLINT_SPEC, ctx, "hadolint", args, deps);
    },
  };
}
