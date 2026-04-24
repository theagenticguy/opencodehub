/**
 * Shared process-spawning helpers for scanner wrappers.
 *
 * We deliberately do NOT depend on `execa` or `zx`. All we need is:
 *   (a) `which(binary)` — detect whether a command is on PATH.
 *   (b) `runBinary(cmd, args, opts)` — spawn a child process, capture
 *       stdout/stderr, honour a wall-clock timeout.
 *
 * Every wrapper uses these so behaviour is uniform: missing binary →
 * sentinel result with the warning; non-zero exit with SARIF on stdout →
 * still returned (scanners often exit non-zero when findings exist); hard
 * crash → thrown.
 */

import { type ExecFileOptionsWithStringEncoding, execFile } from "node:child_process";

export interface WhichResult {
  readonly found: boolean;
  readonly path?: string;
}

/**
 * Quick PATH lookup. Uses `which` on POSIX and `where` on Windows. If the
 * probe itself fails (because neither command is available, which should
 * not happen on any supported platform) we conservatively treat the
 * binary as missing.
 */
export async function which(binary: string): Promise<WhichResult> {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await runBinary(probe, [binary], { timeoutMs: 2_000 });
    const first = stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
    if (first && first.trim().length > 0) {
      return { found: true, path: first.trim() };
    }
    return { found: false };
  } catch {
    return { found: false };
  }
}

export interface RunBinaryOptions {
  readonly timeoutMs: number;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Maximum stdout/stderr buffer in bytes. Default 64 MiB (SARIF can be large). */
  readonly maxBuffer?: number;
}

export interface RunBinaryResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Spawn a binary, capture stdout+stderr, and honour a timeout. Unlike the
 * Node built-in, this resolves on non-zero exit rather than rejecting —
 * many scanners exit non-zero when they found issues (e.g. semgrep exits
 * 1 on any finding, 2 on hard error). Callers inspect `exitCode` +
 * `stdout` to decide whether SARIF was emitted.
 *
 * Rejects when the binary could not be spawned (ENOENT), when the process
 * was killed by the timeout, or when stdout exceeds `maxBuffer`.
 */
export function runBinary(
  cmd: string,
  args: readonly string[],
  opts: RunBinaryOptions,
): Promise<RunBinaryResult> {
  const options: ExecFileOptionsWithStringEncoding = {
    timeout: opts.timeoutMs,
    maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    windowsHide: true,
    encoding: "utf8",
  };
  if (opts.cwd !== undefined) options.cwd = opts.cwd;
  if (opts.env !== undefined) options.env = opts.env;

  return new Promise<RunBinaryResult>((resolvePromise, rejectPromise) => {
    execFile(cmd, [...args], options, (err, stdoutStr, stderrStr) => {
      const stdout = typeof stdoutStr === "string" ? stdoutStr : "";
      const stderr = typeof stderrStr === "string" ? stderrStr : "";
      if (err === null) {
        resolvePromise({ stdout, stderr, exitCode: 0 });
        return;
      }
      // Node annotates the error with `code` (numeric), `killed`, `signal`.
      const e = err as NodeJS.ErrnoException & {
        code?: number | string;
        killed?: boolean;
        signal?: NodeJS.Signals | null;
      };
      if (e.killed === true) {
        rejectPromise(
          new Error(
            `runBinary: timed out after ${opts.timeoutMs}ms running ${cmd} (signal=${
              e.signal ?? "unknown"
            })`,
          ),
        );
        return;
      }
      if (typeof e.code === "string") {
        // ENOENT / EACCES / ...
        rejectPromise(new Error(`runBinary: failed to spawn ${cmd}: ${e.code}`));
        return;
      }
      // Numeric exit code — this is a "ran but non-zero" outcome. Return
      // it so wrappers can parse stdout/stderr themselves.
      resolvePromise({ stdout, stderr, exitCode: typeof e.code === "number" ? e.code : 1 });
    });
  });
}

/**
 * Parse a JSON document, returning `undefined` if parsing fails. We use
 * this for scanner stdout → SarifLog so a broken tool doesn't crash the
 * whole `codehub scan` run.
 */
export function tryParseJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}
