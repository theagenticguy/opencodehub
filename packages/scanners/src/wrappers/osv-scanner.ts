/**
 * OSV-Scanner wrapper — dependency vulnerability scanner.
 *
 * Invocation: `osv-scanner scan source --format=sarif --recursive .`
 *
 * Exit-code semantics (osv-scanner v2, per
 * https://google.github.io/osv-scanner/output/ "Return Codes"):
 *
 *   0   — packages found, no vulnerabilities/findings.
 *   1   — packages found, vulnerabilities/findings present (the COMMON
 *         non-zero case; NOT an error).
 *   2-126 — reserved for vulnerability/finding-related results.
 *   127 — GENERAL ERROR (e.g. the offline vulnerability DB could not be
 *         loaded). Note: the scan may still have walked the filesystem and
 *         parsed lockfiles before failing, so partial stderr ("Scanned …
 *         uv.lock … found N packages") does NOT mean the scan succeeded.
 *   128 — no packages discovered (scanning format picked up no files).
 *   129-255 — non-result-related errors.
 *
 * The shared `invokeScanner` treats only 0 and 1 as "ran cleanly". For
 * osv-scanner that is too coarse: it would flag exit 1 (vulns found — the
 * whole point of the scan) as a warning, and it would surface exit 127 as
 * a generic "exit code 127" without explaining that the most likely cause
 * is a missing offline database. We interpret osv's codes explicitly here.
 *
 * Offline posture: earlier revisions passed `--offline-vulnerabilities` by
 * default on the assumption the DB was pre-synced by `codehub db-sync`.
 * On a fresh checkout with no synced DB, osv-scanner walks the tree, then
 * fails to load the offline DB and exits 127 — a confusing "it ran but
 * errored" signal. We DROP the default offline flag so the common case
 * (online lookup) works out of the box; operators who need air-gapped
 * scans pass it back via osv-scanner's own env/flags after `db-sync`.
 */

import { OSV_SCANNER_SPEC } from "../catalog.js";
import type { ScannerRunContext, ScannerRunResult, ScannerWrapper } from "../spec.js";
import { emptySarifFor } from "../spec.js";
import { DEFAULT_DEPS, parseSarifOrEmpty, type WrapperDeps } from "./shared.js";

const OSV_ARGS: readonly string[] = ["scan", "source", "--format=sarif", "--recursive", "."];

/**
 * Map an osv-scanner v2 exit code to an advisory note, or `undefined` when
 * the exit represents a clean / findings-present run that needs no warning.
 */
export function osvExitAdvisory(exitCode: number, stderr: string): string | undefined {
  // 0 = no findings; 1-126 = findings present (the normal non-zero outcome).
  if (exitCode >= 0 && exitCode <= 126) return undefined;
  if (exitCode === 127) {
    return (
      `${OSV_SCANNER_SPEC.id}: general error (exit 127). Common cause: the offline ` +
      `vulnerability DB is missing — run \`codehub db-sync\` then retry, or omit ` +
      `offline mode. stderr: ${truncate(stderr, 160)}`
    );
  }
  if (exitCode === 128) {
    // No packages discovered. Benign for repos with no lockfiles/manifests.
    return `${OSV_SCANNER_SPEC.id}: no packages discovered (exit 128); nothing to scan.`;
  }
  return `${OSV_SCANNER_SPEC.id}: exit code ${exitCode}; stderr: ${truncate(stderr, 160)}`;
}

export function createOsvScannerWrapper(deps: WrapperDeps = DEFAULT_DEPS): ScannerWrapper {
  return {
    spec: OSV_SCANNER_SPEC,
    run: async (ctx: ScannerRunContext): Promise<ScannerRunResult> => {
      const started = performance.now();
      const probe = await deps.which("osv-scanner");
      if (!probe.found) {
        const msg = `${OSV_SCANNER_SPEC.id}: binary 'osv-scanner' not found on PATH (install: ${OSV_SCANNER_SPEC.installCmd}).`;
        ctx.onWarn?.(msg);
        return {
          spec: OSV_SCANNER_SPEC,
          sarif: emptySarifFor(OSV_SCANNER_SPEC),
          skipped: msg,
          durationMs: performance.now() - started,
        };
      }
      const result = await deps.runBinary("osv-scanner", OSV_ARGS, {
        timeoutMs: ctx.timeoutMs,
        cwd: ctx.projectPath,
      });
      const sarif = parseSarifOrEmpty(result.stdout, OSV_SCANNER_SPEC, ctx.onWarn);
      const advisory = osvExitAdvisory(result.exitCode, result.stderr);
      if (advisory !== undefined) ctx.onWarn?.(advisory);
      return {
        spec: OSV_SCANNER_SPEC,
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
