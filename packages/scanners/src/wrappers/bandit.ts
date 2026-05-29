/**
 * Bandit wrapper — Python SAST.
 *
 * Invocation: `bandit -r <projectPath> -f sarif --quiet`
 *
 * Requires the `bandit[sarif]` install (which pulls in
 * `bandit-sarif-formatter` ≥1.1.1). IMPORTANT: when that extra is NOT
 * installed, `sarif` is absent from bandit's dynamic `-f/--format` choice
 * list, so argparse REJECTS `-f sarif` with exit code 2 and a `usage: …`
 * message on stderr — bandit does NOT fall back to text output. We detect
 * that specific failure and emit an actionable advisory pointing at the
 * `bandit[sarif]` install, instead of the misleading generic "stdout was
 * not valid JSON" note.
 *
 * Bandit exit codes: 0 = no issues, 1 = issues found, 2 = usage/argparse
 * or config error (NOT a finding). We treat 0 and 1 as "ran"; 2+ is a
 * genuine invocation failure.
 *
 * Note: bandit writes SARIF to stdout when `-f sarif` is given WITHOUT
 * `-o <file>`. We pass `-r <projectPath>` so the wrapper works from any CWD.
 */

import { BANDIT_SPEC } from "../catalog.js";
import type { ScannerRunContext, ScannerRunResult, ScannerWrapper } from "../spec.js";
import { emptySarifFor } from "../spec.js";
import { DEFAULT_DEPS, parseSarifOrEmpty, type WrapperDeps } from "./shared.js";

/**
 * Detect bandit's argparse rejection of `-f sarif` (exit 2 + a `usage:`
 * banner mentioning the format flag) and return an actionable advisory.
 * Returns `undefined` when the exit looks like a normal run (0/1) or an
 * unrelated failure (handled by the generic exit-code note).
 */
export function banditExitAdvisory(exitCode: number, stderr: string): string | undefined {
  if (exitCode === 0 || exitCode === 1) return undefined;
  const looksLikeUsage = /\busage:\s*bandit\b/i.test(stderr);
  if (exitCode === 2 && looksLikeUsage) {
    return (
      `${BANDIT_SPEC.id}: rejected '-f sarif' (exit 2). The SARIF formatter is not ` +
      `installed — install the extra: ${BANDIT_SPEC.installCmd}. ` +
      `(Bandit does not fall back to text output here; it exits with a usage error.)`
    );
  }
  return `${BANDIT_SPEC.id}: exit code ${exitCode}; stderr: ${truncate(stderr, 160)}`;
}

export function createBanditWrapper(deps: WrapperDeps = DEFAULT_DEPS): ScannerWrapper {
  return {
    spec: BANDIT_SPEC,
    run: async (ctx: ScannerRunContext): Promise<ScannerRunResult> => {
      const started = performance.now();
      const probe = await deps.which("bandit");
      if (!probe.found) {
        const msg = `${BANDIT_SPEC.id}: binary 'bandit' not found on PATH (install: ${BANDIT_SPEC.installCmd}).`;
        ctx.onWarn?.(msg);
        return {
          spec: BANDIT_SPEC,
          sarif: emptySarifFor(BANDIT_SPEC),
          skipped: msg,
          durationMs: performance.now() - started,
        };
      }
      const args: readonly string[] = ["-r", ctx.projectPath, "-f", "sarif", "--quiet"];
      const result = await deps.runBinary("bandit", args, {
        timeoutMs: ctx.timeoutMs,
        cwd: ctx.projectPath,
      });
      const advisory = banditExitAdvisory(result.exitCode, result.stderr);
      if (advisory !== undefined) {
        // Argparse / invocation failure: stdout is empty (the usage banner
        // went to stderr). Surface the specific advisory and skip the generic
        // "stdout was not valid JSON" note, which would be misleading here.
        ctx.onWarn?.(advisory);
        return {
          spec: BANDIT_SPEC,
          sarif: emptySarifFor(BANDIT_SPEC),
          durationMs: performance.now() - started,
        };
      }
      const sarif = parseSarifOrEmpty(result.stdout, BANDIT_SPEC, ctx.onWarn);
      return {
        spec: BANDIT_SPEC,
        sarif,
        durationMs: performance.now() - started,
      };
    },
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s.trim();
  return `${s.slice(0, max).trim()}…`;
}
