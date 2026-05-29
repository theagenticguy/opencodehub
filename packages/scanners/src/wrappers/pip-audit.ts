/**
 * pip-audit wrapper — Python dependency vulnerability audit.
 *
 * Resolution order for what to audit (first hit wins):
 *
 *   1. An explicit / default `requirements.txt` that EXISTS on disk →
 *      audit it directly:
 *        pip-audit -r requirements.txt --format json --disable-pip …
 *      `--disable-pip` keeps the audit fully offline; pip-audit reads the
 *      pinned file and never resolves an environment.
 *
 *   2. No requirements file, but a `pyproject.toml` exists → bridge via uv.
 *      pip-audit cannot audit a bare `pyproject.toml` (it would try to build
 *      a throwaway venv and resolve deps, which fails on locked/offline
 *      projects with `invalid requirements input`). Instead we export the
 *      resolved, HASHED dependency set with uv:
 *        uv export --quiet --format requirements-txt --no-emit-project \
 *                  -o <metaDir>/.pip-audit-requirements.txt
 *      then feed that to the same `-r … --disable-pip` path. uv emits hashes
 *      by default, which `--disable-pip` requires. SARIF findings are still
 *      labelled against `pyproject.toml` (the file the user recognises), not
 *      the transient export, via the converter's `requirementsPath` option.
 *
 *   3. Neither file present → emit empty SARIF with an advisory; there is
 *      nothing to audit.
 *
 * We tolerate non-zero exit (pip-audit exits 1 on findings) per the shared
 * `invokeScanner` contract. Output is JSON, NOT SARIF — we post-process
 * stdout through `pipAuditJsonToSarif` before returning.
 */

import { join } from "node:path";
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
   * Explicit `-r <file>` to pass to pip-audit, relative to the project root.
   * Defaults to `requirements.txt`. When the file is absent the wrapper falls
   * back to a `pyproject.toml` → uv-export bridge (see module docs).
   */
  readonly requirementsPath?: string;
  /**
   * Directory to write the transient uv-exported requirements file into.
   * Defaults to the project root. Callers should point this at the repo's
   * `.codehub/` meta dir so the export lands in a gitignored location.
   */
  readonly exportDir?: string;
}

/** Filename for the uv-exported requirements bridge file (pyproject case). */
const EXPORT_FILENAME = ".pip-audit-requirements.txt";

export function createPipAuditWrapper(
  deps: WrapperDeps = DEFAULT_DEPS,
  opts: PipAuditWrapperOptions = {},
): ScannerWrapper {
  const fileExists = deps.fileExists ?? DEFAULT_DEPS.fileExists;
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
      const reqAbs = join(ctx.projectPath, requirementsPath);

      // 1. A real requirements file → audit it directly (the original path).
      if (fileExists !== undefined && (await fileExists(reqAbs))) {
        return await auditRequirementsFile(deps, ctx, started, requirementsPath, requirementsPath);
      }

      // 2. No requirements file, but pyproject.toml → bridge through uv export.
      const pyprojectAbs = join(ctx.projectPath, "pyproject.toml");
      if (fileExists !== undefined && (await fileExists(pyprojectAbs))) {
        const bridged = await auditViaPyprojectBridge(deps, ctx, started, opts);
        if (bridged !== undefined) return bridged;
        // bridge failed — fall through to the no-input advisory below.
      }

      // 3. Nothing auditable.
      ctx.onWarn?.(
        `${PIP_AUDIT_SPEC.id}: no requirements.txt or pyproject.toml found in ${ctx.projectPath}; emitting empty SARIF.`,
      );
      return {
        spec: PIP_AUDIT_SPEC,
        sarif: emptySarifFor(PIP_AUDIT_SPEC),
        durationMs: performance.now() - started,
      };
    },
  };
}

/**
 * Run pip-audit against a requirements-format file and convert to SARIF.
 * `auditPath` is what pip-audit reads (`-r`); `sarifUri` is the file shown in
 * SARIF locations (so the pyproject bridge can label findings against
 * `pyproject.toml` while auditing a transient export).
 */
async function auditRequirementsFile(
  deps: WrapperDeps,
  ctx: ScannerRunContext,
  started: number,
  auditPath: string,
  sarifUri: string,
): Promise<ScannerRunResult> {
  const args: readonly string[] = [
    "-r",
    auditPath,
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
  const convertOpts: PipAuditConvertOptions = { requirementsPath: sarifUri };
  const sarif = pipAuditJsonToSarif(json, convertOpts);
  return {
    spec: PIP_AUDIT_SPEC,
    sarif,
    durationMs: performance.now() - started,
  };
}

/**
 * Export `pyproject.toml`'s resolved deps to a hashed requirements file via
 * `uv export`, then audit it. Returns `undefined` (so the caller can emit its
 * own advisory) when uv is missing or the export fails.
 */
async function auditViaPyprojectBridge(
  deps: WrapperDeps,
  ctx: ScannerRunContext,
  started: number,
  opts: PipAuditWrapperOptions,
): Promise<ScannerRunResult | undefined> {
  const uvProbe = await deps.which("uv");
  if (!uvProbe.found) {
    ctx.onWarn?.(
      `${PIP_AUDIT_SPEC.id}: found pyproject.toml but 'uv' is not on PATH to export a lockfile; ` +
        `install uv (https://docs.astral.sh/uv/) or add a requirements.txt. Emitting empty SARIF.`,
    );
    return undefined;
  }
  const exportDir = opts.exportDir ?? ctx.projectPath;
  const exportPath = join(exportDir, EXPORT_FILENAME);
  const exportArgs: readonly string[] = [
    "export",
    "--quiet",
    "--format",
    "requirements-txt",
    "--no-emit-project",
    "-o",
    exportPath,
  ];
  const exportResult = await deps.runBinary("uv", exportArgs, {
    timeoutMs: ctx.timeoutMs,
    cwd: ctx.projectPath,
  });
  if (exportResult.exitCode !== 0) {
    ctx.onWarn?.(
      `${PIP_AUDIT_SPEC.id}: 'uv export' failed (exit ${exportResult.exitCode}: ${truncate(exportResult.stderr, 200)}); emitting empty SARIF.`,
    );
    return undefined;
  }
  // Audit the export, but label findings against pyproject.toml — the file
  // the user actually maintains.
  return await auditRequirementsFile(deps, ctx, started, exportPath, "pyproject.toml");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s.trim();
  return `${s.slice(0, max).trim()}…`;
}
