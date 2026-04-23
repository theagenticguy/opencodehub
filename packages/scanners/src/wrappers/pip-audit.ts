/**
 * pip-audit wrapper — Python environment / requirements vulnerability
 * audit.
 *
 * Invocation (requirements.txt mode, the ergonomic default for project
 * scans):
 *
 *   pip-audit -r requirements.txt --format json --disable-pip
 *             --cache-dir <repo>/.codehub/pip-audit-cache --progress-spinner off
 *
 * When `requirements.txt` is missing, pip-audit falls back to the
 * current environment and (empirically) either complains about no
 * requirements file or tries to probe the system env; either way it
 * returns JSON on stdout. We tolerate non-zero exit (pip-audit exits
 * 1 on findings) per the shared `invokeScanner` contract.
 *
 * Output is JSON, NOT SARIF — we post-process stdout through
 * `pipAuditJsonToSarif` before returning.
 */

import { PIP_AUDIT_SPEC } from "../catalog.js";
import {
  type PipAuditConvertOptions,
  pipAuditJsonToSarif,
} from "../converters/pip-audit-to-sarif.js";
import { tryParseJson } from "../exec.js";
import type { ScannerRunContext, ScannerRunResult, ScannerWrapper } from "../spec.js";
import { emptySarifFor } from "../spec.js";
import { DEFAULT_DEPS, type WrapperDeps } from "./shared.js";

export interface PipAuditWrapperOptions {
  /**
   * Explicit `-r <file>` to pass to pip-audit. Defaults to
   * `requirements.txt` (pip-audit will gracefully no-op if the file is
   * missing).
   */
  readonly requirementsPath?: string;
}

export function createPipAuditWrapper(
  deps: WrapperDeps = DEFAULT_DEPS,
  opts: PipAuditWrapperOptions = {},
): ScannerWrapper {
  return {
    spec: PIP_AUDIT_SPEC,
    run: async (ctx: ScannerRunContext): Promise<ScannerRunResult> => {
      const started = performance.now();
      const probe = await deps.which("pip-audit");
      if (!probe.found) {
        const msg = `${PIP_AUDIT_SPEC.id}: binary 'pip-audit' not found on PATH (install: ${PIP_AUDIT_SPEC.installCmd}).`;
        ctx.onWarn?.(msg);
        return {
          spec: PIP_AUDIT_SPEC,
          sarif: emptySarifFor(PIP_AUDIT_SPEC),
          skipped: msg,
          durationMs: performance.now() - started,
        };
      }
      const requirementsPath = opts.requirementsPath ?? "requirements.txt";
      const args: readonly string[] = [
        "-r",
        requirementsPath,
        "--format",
        "json",
        "--disable-pip",
        "--progress-spinner",
        "off",
      ];
      const result = await deps.runBinary("pip-audit", args, {
        timeoutMs: ctx.timeoutMs,
        cwd: ctx.projectPath,
      });
      const json = tryParseJson(result.stdout);
      if (json === undefined) {
        ctx.onWarn?.(
          `${PIP_AUDIT_SPEC.id}: stdout was not valid JSON (stderr: ${truncate(result.stderr, 200)}); emitting empty SARIF.`,
        );
        return {
          spec: PIP_AUDIT_SPEC,
          sarif: emptySarifFor(PIP_AUDIT_SPEC),
          durationMs: performance.now() - started,
        };
      }
      const convertOpts: PipAuditConvertOptions = { requirementsPath };
      const sarif = pipAuditJsonToSarif(json, convertOpts);
      return {
        spec: PIP_AUDIT_SPEC,
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
