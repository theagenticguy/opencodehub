/**
 * Betterleaks wrapper — secret detection (gitleaks fork by the original
 * gitleaks author, maintained by Aikido Security).
 *
 * Invocation:
 *
 *     betterleaks dir --report-format=sarif --report-path=- --no-banner \
 *       [--config <ours>] .
 *
 * We use `dir` mode (not `git`) so the scan reflects the current working
 * tree, not historical commits. `betterleaks git --pre-commit=false`
 * walks the entire git log and re-flags every secret that ever existed
 * in any commit — useful for a one-shot history audit, wrong for the
 * "what's in this checkout right now" signal `codehub analyze` wants.
 *
 * `dir` mode does NOT honor `.gitignore`. The shipped default config
 * (`config/betterleaks.default.toml`) compensates by allowlisting common
 * vendored / generated / lockfile paths via RE2 regexes. Users can drop
 * their own `betterleaks.toml` at the project root to customize.
 *
 * Output:
 *   - `--report-path=-` writes SARIF to stdout. The earlier `=/dev/stdout`
 *     value broke under Node's `execFile` because the child's fd 1 is a
 *     pipe, not a char device — `open("/dev/stdout")` returned ENXIO and
 *     betterleaks printed nothing.
 *
 * Config resolution:
 *   - If the project root has its own `betterleaks.toml`, `.betterleaks.toml`,
 *     `gitleaks.toml`, or `.gitleaks.toml`, betterleaks picks it up by
 *     default (per its config precedence) and we DO NOT pass `--config`.
 *   - Otherwise we inject `--config <packageRoot>/config/betterleaks.default.toml`
 *     so every consumer gets a sensible vendored-deps / lockfile / build-output
 *     allowlist out of the box. Users override by dropping a config at the
 *     project root.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BETTERLEAKS_SPEC } from "../catalog.js";
import {
  emptySarifFor,
  type ScannerRunContext,
  type ScannerRunResult,
  type ScannerWrapper,
} from "../spec.js";
import { DEFAULT_DEPS, parseSarifOrEmpty, type WrapperDeps } from "./shared.js";

/** Filenames betterleaks itself recognises at the project root. */
const USER_CONFIG_NAMES = [
  "betterleaks.toml",
  ".betterleaks.toml",
  "gitleaks.toml",
  ".gitleaks.toml",
] as const;

/**
 * Resolve the path to the vendored default config (`betterleaks.default.toml`).
 *
 * This wrapper runs in two very different emitted layouts, and a fixed `..`
 * depth only works for one of them:
 *   - Standalone scanners build: the module sits at
 *     `<scanners>/dist/wrappers/betterleaks.js`; the config lives at
 *     `<scanners>/config/betterleaks.default.toml` (two levels up).
 *   - Bundled into `@opencodehub/cli`: the wrapper is inlined into a flat
 *     `<cli>/dist/chunk-<hash>.js`, and tsup copies the scanner config to
 *     `<cli>/dist/config/betterleaks.default.toml` (one level down). The old
 *     `resolve(here, "..", "..", "config", …)` pointed at `<cli>/config` —
 *     outside the package — so the default allowlist silently never applied.
 *
 * Walk UP from this module probing `config/betterleaks.default.toml` at each
 * level; the first hit wins. Layout-agnostic, so it resolves correctly in both
 * builds (and a raw source checkout). Returns the conventional bundled path as
 * a last resort so a downstream read error names the file we expected.
 */
function defaultConfigPath(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let level = 0; level <= 10; level += 1) {
    const candidate = join(dir, "config", "betterleaks.default.toml");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "config", "betterleaks.default.toml");
}

function userConfigInProject(projectPath: string): string | undefined {
  for (const name of USER_CONFIG_NAMES) {
    const p = join(projectPath, name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

function buildArgs(projectPath: string): readonly string[] {
  const args: string[] = ["dir", "--report-format=sarif", "--report-path=-", "--no-banner"];
  if (userConfigInProject(projectPath) === undefined) {
    args.push(`--config=${defaultConfigPath()}`);
  }
  args.push(".");
  return args;
}

export function createBetterleaksWrapper(deps: WrapperDeps = DEFAULT_DEPS): ScannerWrapper {
  return {
    spec: BETTERLEAKS_SPEC,
    run: async (ctx: ScannerRunContext): Promise<ScannerRunResult> => {
      const started = performance.now();
      const probe = await deps.which("betterleaks");
      if (!probe.found) {
        const msg = `${BETTERLEAKS_SPEC.id}: binary 'betterleaks' not found on PATH (install: ${BETTERLEAKS_SPEC.installCmd}).`;
        ctx.onWarn?.(msg);
        return {
          spec: BETTERLEAKS_SPEC,
          sarif: emptySarifFor(BETTERLEAKS_SPEC),
          skipped: msg,
          durationMs: performance.now() - started,
        };
      }
      const args = buildArgs(ctx.projectPath);
      const result = await deps.runBinary("betterleaks", args, {
        timeoutMs: ctx.timeoutMs,
        cwd: ctx.projectPath,
      });
      const sarif = parseSarifOrEmpty(result.stdout, BETTERLEAKS_SPEC, ctx.onWarn);
      // Betterleaks exits 1 when it finds leaks, 0 when clean. Anything
      // else is a genuine failure.
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        ctx.onWarn?.(
          `${BETTERLEAKS_SPEC.id}: exit code ${result.exitCode}; stderr: ${result.stderr.slice(0, 200).trim()}`,
        );
      }
      return {
        spec: BETTERLEAKS_SPEC,
        sarif,
        durationMs: performance.now() - started,
      };
    },
  };
}
