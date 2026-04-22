/**
 * Wrapper-local helpers shared by every P1 scanner wrapper.
 *
 * These live as a per-wrapper module (not the package barrel) so wrapper
 * tests can mock `runBinary` without pulling in every other wrapper.
 */

import { type SarifLog, SarifLogSchema } from "@opencodehub/sarif";
import { type RunBinaryResult, runBinary, tryParseJson, which } from "../exec.js";
import {
  emptySarifFor,
  type ScannerRunContext,
  type ScannerRunResult,
  type ScannerSpec,
} from "../spec.js";

/**
 * Dependency injection seam for tests. Every wrapper accepts an optional
 * `Deps` override so tests can substitute a fake `runBinary` / `which`
 * without monkey-patching globals.
 */
export interface WrapperDeps {
  readonly which: (binary: string) => Promise<{ readonly found: boolean }>;
  readonly runBinary: (
    cmd: string,
    args: readonly string[],
    opts: { readonly timeoutMs: number; readonly cwd?: string; readonly env?: NodeJS.ProcessEnv },
  ) => Promise<RunBinaryResult>;
}

export const DEFAULT_DEPS: WrapperDeps = {
  which,
  runBinary: (cmd, args, opts) => runBinary(cmd, args, opts),
};

/**
 * Attempt to parse the binary's stdout as a SARIF v2.1.0 log. On success,
 * returns the validated log. On failure, logs a warning and returns an
 * empty SARIF attributed to `spec`. This guarantees callers never have
 * to deal with `undefined` / malformed SARIF downstream.
 */
export function parseSarifOrEmpty(
  stdout: string,
  spec: ScannerSpec,
  onWarn?: (msg: string) => void,
): SarifLog {
  const parsed = tryParseJson(stdout);
  if (parsed === undefined) {
    onWarn?.(`${spec.id}: stdout was not valid JSON; emitting empty SARIF.`);
    return emptySarifFor(spec);
  }
  const validation = SarifLogSchema.safeParse(parsed);
  if (!validation.success) {
    onWarn?.(`${spec.id}: output failed SARIF schema validation; emitting empty SARIF.`);
    return emptySarifFor(spec);
  }
  return validation.data;
}

/**
 * Full outer shape for a wrapper: check binary → run it → parse SARIF.
 * Catches missing-binary + execution errors and converts them into an
 * empty SARIF with a `skipped` note. Unexpected failures bubble up to
 * the runner, which logs them into `errored`.
 */
export async function invokeScanner(
  spec: ScannerSpec,
  ctx: ScannerRunContext,
  binary: string,
  args: readonly string[],
  deps: WrapperDeps = DEFAULT_DEPS,
): Promise<ScannerRunResult> {
  const started = performance.now();
  const probe = await deps.which(binary);
  if (!probe.found) {
    const msg = `${spec.id}: binary '${binary}' not found on PATH (install: ${spec.installCmd}).`;
    ctx.onWarn?.(msg);
    return {
      spec,
      sarif: emptySarifFor(spec),
      skipped: msg,
      durationMs: performance.now() - started,
    };
  }
  const result = await deps.runBinary(binary, args, {
    timeoutMs: ctx.timeoutMs,
    cwd: ctx.projectPath,
  });
  const sarif = parseSarifOrEmpty(result.stdout, spec, ctx.onWarn);
  const run: ScannerRunResult = {
    spec,
    sarif,
    durationMs: performance.now() - started,
  };
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    // Most scanners exit 1 on findings; 2+ usually signals a hard error.
    const note = `${spec.id}: exit code ${result.exitCode}; stderr: ${truncate(result.stderr, 200)}`;
    ctx.onWarn?.(note);
  }
  return run;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s.trim();
  return `${s.slice(0, max).trim()}…`;
}
