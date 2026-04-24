/**
 * Checkov docker-compose wrapper (SARIF-native).
 *
 * Invocation (per compose file):
 *   `checkov -f <compose-file> --framework secrets --framework yaml
 *            -o sarif --quiet --soft-fail`
 *
 * Unlike the general `checkov` wrapper (which runs on a directory across
 * multiple frameworks), this variant is gated on `docker-compose` in the
 * ProjectProfile. Checkov v3.2.500+ treats compose files as YAML (static
 * secret + misconfiguration checks); this wrapper drives the same binary
 * but scopes it to the compose targets the profile identified.
 *
 * Tool identity: after parsing, the `run.tool.driver.name` is rewritten
 * from `checkov` to `checkov-docker-compose` and a
 * `run.automationDetails.id = "docker-compose"` is added so merge / dedup
 * downstream can distinguish it from the broader Checkov run when both
 * are enabled for the same repo. Raw findings are preserved byte-for-byte.
 *
 * License: Apache-2.0.
 */

import type { SarifLog, SarifRun } from "@opencodehub/sarif";
import { CHECKOV_DOCKER_COMPOSE_SPEC } from "../catalog.js";
import type { ScannerRunContext, ScannerRunResult, ScannerWrapper } from "../spec.js";
import { emptySarifFor } from "../spec.js";
import { DEFAULT_DEPS, parseSarifOrEmpty, type WrapperDeps } from "./shared.js";

export interface CheckovDockerComposeWrapperOptions {
  /**
   * Compose file paths (relative to the project root or absolute). When
   * empty, the wrapper short-circuits to an empty SARIF + `skipped` note —
   * Checkov requires at least one `-f` target to run in compose mode.
   */
  readonly composeFiles?: readonly string[];
}

const DEFAULT_COMPOSE_FILES: readonly string[] = ["docker-compose.yml", "docker-compose.yaml"];

export function createCheckovDockerComposeWrapper(
  deps: WrapperDeps = DEFAULT_DEPS,
  opts: CheckovDockerComposeWrapperOptions = {},
): ScannerWrapper {
  return {
    spec: CHECKOV_DOCKER_COMPOSE_SPEC,
    run: async (ctx: ScannerRunContext): Promise<ScannerRunResult> => {
      const started = performance.now();
      const files = (opts.composeFiles ?? DEFAULT_COMPOSE_FILES).filter((p) => p.length > 0);
      if (files.length === 0) {
        const skipped = `${CHECKOV_DOCKER_COMPOSE_SPEC.id}: no docker-compose files to scan`;
        ctx.onWarn?.(skipped);
        return {
          spec: CHECKOV_DOCKER_COMPOSE_SPEC,
          sarif: emptySarifFor(CHECKOV_DOCKER_COMPOSE_SPEC),
          skipped,
          durationMs: performance.now() - started,
        };
      }
      const probe = await deps.which("checkov");
      if (!probe.found) {
        const msg = `${CHECKOV_DOCKER_COMPOSE_SPEC.id}: binary 'checkov' not found on PATH (install: ${CHECKOV_DOCKER_COMPOSE_SPEC.installCmd}).`;
        ctx.onWarn?.(msg);
        return {
          spec: CHECKOV_DOCKER_COMPOSE_SPEC,
          sarif: emptySarifFor(CHECKOV_DOCKER_COMPOSE_SPEC),
          skipped: msg,
          durationMs: performance.now() - started,
        };
      }
      const args: string[] = [];
      for (const file of files) {
        args.push("-f", file);
      }
      args.push(
        "--framework",
        "secrets",
        "--framework",
        "yaml",
        "-o",
        "sarif",
        "--quiet",
        "--soft-fail",
      );
      const result = await deps.runBinary("checkov", args, {
        timeoutMs: ctx.timeoutMs,
        cwd: ctx.projectPath,
      });
      const sarif = parseSarifOrEmpty(result.stdout, CHECKOV_DOCKER_COMPOSE_SPEC, ctx.onWarn);
      const rewritten = rewriteToolIdentity(sarif);
      return {
        spec: CHECKOV_DOCKER_COMPOSE_SPEC,
        sarif: rewritten,
        durationMs: performance.now() - started,
      };
    },
  };
}

/**
 * Rewrite the parsed SARIF's `run.tool.driver.name` to
 * `checkov-docker-compose` and add `run.automationDetails.id =
 * "docker-compose"` so the output is distinguishable from a general
 * Checkov run during merge/dedup. All other fields (results, properties,
 * version, rules) are preserved byte-for-byte via the passthrough shape.
 */
function rewriteToolIdentity(sarif: SarifLog): SarifLog {
  const runs: SarifRun[] = sarif.runs.map((run) => {
    const driver = { ...run.tool.driver, name: CHECKOV_DOCKER_COMPOSE_SPEC.id };
    const tool = { ...run.tool, driver };
    return {
      ...run,
      tool,
      automationDetails: { id: "docker-compose" },
    } as SarifRun;
  });
  return { ...sarif, runs };
}

// Re-exported as an internal helper so the unit test can exercise the
// rewrite without spawning a child process.
export const __testing = { rewriteToolIdentity };
