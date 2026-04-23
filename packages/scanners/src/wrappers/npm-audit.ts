/**
 * npm audit wrapper — JS/TS dependency vulnerability scan.
 *
 * Invocation: `npm audit --json --audit-level=low`
 *
 * - npm audit emits JSON on stdout (large docs — 64MiB maxBuffer in
 *   `runBinary` is enough for real-world repos).
 * - Exit code 1 indicates findings at or above the audit-level; still
 *   yields valid JSON, which we convert to SARIF downstream.
 * - `--audit-level=low` surfaces every advisory; the severity mapping
 *   in the converter classifies them (low→note, high→error).
 *
 * Output is JSON, NOT SARIF — we route stdout through
 * `npmAuditJsonToSarif` before returning.
 *
 * License: npm CLI is Artistic-2.0; the wrapper invokes it as an OS
 * subprocess (never linked). If `npm` is missing from PATH, the wrapper
 * emits an empty SARIF with a skipped note.
 */

import { NPM_AUDIT_SPEC } from "../catalog.js";
import { npmAuditJsonToSarif } from "../converters/npm-audit-to-sarif.js";
import { tryParseJson } from "../exec.js";
import type { ScannerRunContext, ScannerRunResult, ScannerWrapper } from "../spec.js";
import { emptySarifFor } from "../spec.js";
import { DEFAULT_DEPS, type WrapperDeps } from "./shared.js";

export function createNpmAuditWrapper(deps: WrapperDeps = DEFAULT_DEPS): ScannerWrapper {
  return {
    spec: NPM_AUDIT_SPEC,
    run: async (ctx: ScannerRunContext): Promise<ScannerRunResult> => {
      const started = performance.now();
      const probe = await deps.which("npm");
      if (!probe.found) {
        const msg = `${NPM_AUDIT_SPEC.id}: binary 'npm' not found on PATH (install: ${NPM_AUDIT_SPEC.installCmd}).`;
        ctx.onWarn?.(msg);
        return {
          spec: NPM_AUDIT_SPEC,
          sarif: emptySarifFor(NPM_AUDIT_SPEC),
          skipped: msg,
          durationMs: performance.now() - started,
        };
      }
      const args: readonly string[] = ["audit", "--json", "--audit-level=low"];
      const result = await deps.runBinary("npm", args, {
        timeoutMs: ctx.timeoutMs,
        cwd: ctx.projectPath,
      });
      const json = tryParseJson(result.stdout);
      if (json === undefined) {
        ctx.onWarn?.(
          `${NPM_AUDIT_SPEC.id}: stdout was not valid JSON (stderr: ${truncate(result.stderr, 200)}); emitting empty SARIF.`,
        );
        return {
          spec: NPM_AUDIT_SPEC,
          sarif: emptySarifFor(NPM_AUDIT_SPEC),
          durationMs: performance.now() - started,
        };
      }
      const sarif = npmAuditJsonToSarif(json);
      return {
        spec: NPM_AUDIT_SPEC,
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
