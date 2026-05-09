/**
 * detect-secrets wrapper — Yelp's polyglot secret scanner. The 20th
 * scanner per ROADMAP constraint 10.
 *
 * Invocation:
 *
 *   detect-secrets scan . --all-files
 *
 * `--all-files` matches betterleaks's posture (scan non-git-tracked
 * files too) and is the ergonomic default for monorepo scans. The
 * `scan` subcommand always emits JSON on stdout — there is no `--json`
 * flag at this entry point. (The `--json` flag exists only on the
 * separate `detect-secrets-hook` pre-commit entry point.)
 *
 * Output is JSON, NOT SARIF — we post-process stdout through
 * `detectSecretsJsonToSarif` before returning. detect-secrets exits 0
 * on findings, so `invokeScanner`'s default exit-code tolerance is fine.
 */

import { DETECT_SECRETS_SPEC } from "../catalog.js";
import { detectSecretsJsonToSarif } from "../converters/detect-secrets-to-sarif.js";
import { tryParseJson } from "../exec.js";
import type { ScannerRunContext, ScannerRunResult, ScannerWrapper } from "../spec.js";
import { emptySarifFor } from "../spec.js";
import { DEFAULT_DEPS, type WrapperDeps } from "./shared.js";

const DETECT_SECRETS_ARGS: readonly string[] = ["scan", ".", "--all-files"];

export function createDetectSecretsWrapper(deps: WrapperDeps = DEFAULT_DEPS): ScannerWrapper {
  return {
    spec: DETECT_SECRETS_SPEC,
    run: async (ctx: ScannerRunContext): Promise<ScannerRunResult> => {
      const started = performance.now();
      const probe = await deps.which("detect-secrets");
      if (!probe.found) {
        const msg = `${DETECT_SECRETS_SPEC.id}: binary 'detect-secrets' not found on PATH (install: ${DETECT_SECRETS_SPEC.installCmd}).`;
        ctx.onWarn?.(msg);
        return {
          spec: DETECT_SECRETS_SPEC,
          sarif: emptySarifFor(DETECT_SECRETS_SPEC),
          skipped: msg,
          durationMs: performance.now() - started,
        };
      }
      const result = await deps.runBinary("detect-secrets", DETECT_SECRETS_ARGS, {
        timeoutMs: ctx.timeoutMs,
        cwd: ctx.projectPath,
      });
      const json = tryParseJson(result.stdout);
      if (json === undefined) {
        ctx.onWarn?.(
          `${DETECT_SECRETS_SPEC.id}: stdout was not valid JSON (stderr: ${truncate(
            result.stderr,
            200,
          )}); emitting empty SARIF.`,
        );
        return {
          spec: DETECT_SECRETS_SPEC,
          sarif: emptySarifFor(DETECT_SECRETS_SPEC),
          durationMs: performance.now() - started,
        };
      }
      const sarif = detectSecretsJsonToSarif(json);
      return {
        spec: DETECT_SECRETS_SPEC,
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
