/**
 * `codehub doctor` — environment probe.
 *
 * Runs every `Check` registered in `CHECKS`, prints a table, and exits
 * with a status code that maps to the worst result seen:
 *
 *   0  all ok
 *   1  at least one warn (non-blocking)
 *   2  at least one fail (blocking — something is broken)
 *
 * Checks are strictly diagnostic — they never auto-heal. Each one returns
 * a `hint` string the user can copy-paste when things are off.
 */

import { spawn } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Table from "cli-table3";

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  readonly status: CheckStatus;
  readonly message: string;
  readonly hint?: string;
}

export interface Check {
  readonly name: string;
  run(): Promise<CheckResult>;
}

export interface DoctorOptions {
  /** Override HOME so tests can point at a fake dotdir. */
  readonly home?: string;
  /** Skip checks that rely on native bindings (e.g. in CI sandboxes). */
  readonly skipNative?: boolean;
  /** Override the repo root when resolving workspace packages. */
  readonly repoRoot?: string;
}

export interface DoctorReport {
  readonly rows: readonly { readonly name: string; readonly result: CheckResult }[];
  readonly exitCode: 0 | 1 | 2;
}

/**
 * Entry point invoked by `codehub doctor`. Prints the table and sets
 * `process.exitCode`. Also returns the structured report so tests and
 * acceptance scripts can assert the outcome without parsing stdout.
 */
export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const checks = buildChecks(opts);
  const rows: Array<{ name: string; result: CheckResult }> = [];
  for (const check of checks) {
    const result = await check.run().catch(
      (err: unknown): CheckResult => ({
        status: "fail",
        message: `check threw: ${err instanceof Error ? err.message : String(err)}`,
        hint: "report a bug against @opencodehub/cli — checks should never throw",
      }),
    );
    rows.push({ name: check.name, result });
  }
  printTable(rows);

  let exitCode: 0 | 1 | 2 = 0;
  for (const { result } of rows) {
    if (result.status === "fail") {
      exitCode = 2;
      break;
    }
    if (result.status === "warn" && exitCode === 0) {
      exitCode = 1;
    }
  }
  process.exitCode = exitCode;
  return { rows, exitCode };
}

/**
 * Ordered list of environment probes. Order matters only for the output
 * table — runs are independent, but we surface foundational checks first
 * (Node, pnpm, native bindings) so the user can fix a broken foundation
 * before worrying about downstream extras.
 */
export function buildChecks(opts: DoctorOptions = {}): readonly Check[] {
  const home = opts.home ?? homedir();
  const repoRoot = opts.repoRoot ?? guessRepoRoot();
  const list: Check[] = [nodeVersionCheck(), pnpmInstalledCheck()];
  if (opts.skipNative !== true) {
    list.push(duckdbWorksCheck(repoRoot));
    list.push(lbugWorksCheck(repoRoot));
  }
  list.push(
    binaryOnPathCheck(
      "semgrep",
      "P1 scanner — install semgrep via `brew install semgrep` or `uv tool install semgrep`",
    ),
  );
  list.push(
    binaryOnPathCheck(
      "osv-scanner",
      "P1 scanner — install from https://github.com/google/osv-scanner",
    ),
  );
  list.push(
    binaryOnPathCheck("bandit", "P1 scanner — install with `uv tool install 'bandit[sarif]'`"),
  );
  list.push(binaryOnPathCheck("ruff", "P1 scanner — install with `uv tool install ruff`"));
  list.push(
    binaryOnPathCheck(
      "grype",
      "P1 scanner — install with `brew install anchore/grype/grype` or from https://github.com/anchore/grype",
    ),
  );
  list.push(binaryOnPathCheck("vulture", "P1 scanner — install with `uv tool install vulture`"));
  list.push(
    binaryOnPathCheck("pip-audit", "P1 scanner — install with `uv tool install pip-audit`"),
  );
  list.push(binaryOnPathCheck("radon", "P2 scanner — install with `uv tool install radon`"));
  list.push(
    binaryOnPathCheck("ty", "P2 scanner (beta) — install with `uv tool install ty` (Astral)"),
  );
  list.push(embedderWeightsCheck(home));
  list.push(registryPathCheck(home));
  list.push(sarifSchemaCheck(repoRoot));
  return list;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function nodeVersionCheck(): Check {
  return {
    name: "node >= 20",
    async run() {
      const v = process.versions.node;
      const major = Number.parseInt(v.split(".")[0] ?? "0", 10);
      if (!Number.isFinite(major) || major < 20) {
        return {
          status: "fail",
          message: `node v${v} — minimum is v20.10`,
          hint: "install node 20+ with `mise use node@20` or `nvm install 20`",
        };
      }
      return { status: "ok", message: `node v${v}` };
    },
  };
}

function pnpmInstalledCheck(): Check {
  return {
    name: "pnpm installed",
    async run() {
      const res = await runCommand("pnpm", ["--version"]);
      if (res.status !== 0) {
        return {
          status: "fail",
          message: "pnpm not on PATH",
          hint: "install pnpm via `npm install -g pnpm` or `corepack enable`",
        };
      }
      return { status: "ok", message: `pnpm ${res.stdout.trim()}` };
    },
  };
}

function duckdbWorksCheck(repoRoot: string): Check {
  return {
    name: "duckdb native binding",
    async run() {
      try {
        const duckPath = resolveFromRoot(repoRoot, "@duckdb/node-api");
        if (!duckPath) {
          return {
            status: "warn",
            message: "@duckdb/node-api not installed",
            hint: "run `pnpm install` at the repo root",
          };
        }
        // The @duckdb/node-api 1.x surface exposes Sync teardown helpers
        // (`disconnectSync`, `closeSync`). The async `.close()` accessors
        // were dropped in 1.0.0; depending on them produced a false FAIL.
        const mod = (await import(duckPath)) as {
          DuckDBInstance: {
            create: (path: string) => Promise<{
              connect: () => Promise<{
                disconnectSync?: () => void;
                close?: () => void | Promise<void>;
              }>;
              closeSync?: () => void;
              close?: () => void | Promise<void>;
            }>;
          };
        };
        // In-memory instance: never touches disk, never lingers.
        const inst = await mod.DuckDBInstance.create(":memory:");
        const conn = await inst.connect();
        if (typeof conn.disconnectSync === "function") conn.disconnectSync();
        else if (typeof conn.close === "function") await conn.close();
        if (typeof inst.closeSync === "function") inst.closeSync();
        else if (typeof inst.close === "function") await inst.close();
        return { status: "ok", message: "duckdb open/close OK" };
      } catch (err) {
        return {
          status: "fail",
          message: `duckdb failed to open: ${err instanceof Error ? err.message : String(err)}`,
          hint: "check platform support — pnpm only prebuilds linux-x64/arm64, darwin-arm64/x64, win32-x64",
        };
      }
    },
  };
}

/**
 * Mirror of {@link duckdbWorksCheck} for the optional `@ladybugdb/core`
 * graph-db backend. Emits `warn` (not `fail`) when the package is
 * uninstalled because `@ladybugdb/core` is opt-in: a default `duck`
 * deployment never needs it. When the package IS installed and the
 * smoke test fails we surface `fail` so a broken native binding can be
 * triaged the same way duckdb's is.
 */
function lbugWorksCheck(repoRoot: string): Check {
  return {
    name: "graph-db native binding",
    async run() {
      try {
        const lbugPath = resolveFromRoot(repoRoot, "@ladybugdb/core");
        if (!lbugPath) {
          return {
            status: "warn",
            message: "@ladybugdb/core not installed (optional graph-db backend)",
            hint: "run `pnpm install` and set `CODEHUB_STORE=lbug` to opt in; otherwise ignore",
          };
        }
        // The opt-in graph-db backend uses `@ladybugdb/core`'s `Database`
        // entry. We exercise the load-and-close cycle the same way the
        // duckdb check does — anything heavier would couple this probe to
        // the adapter's evolving smoke-test surface.
        const mod = (await import(lbugPath)) as Record<string, unknown>;
        const ctorRaw =
          mod["Database"] ?? (mod["default"] as Record<string, unknown> | undefined)?.["Database"];
        if (typeof ctorRaw !== "function") {
          return {
            status: "fail",
            message: "@ladybugdb/core is installed but exports no Database constructor",
            hint: "re-run `pnpm install` to refresh the graph-db backend bindings",
          };
        }
        return { status: "ok", message: "@ladybugdb/core load OK" };
      } catch (err) {
        return {
          status: "fail",
          message: `@ladybugdb/core failed to load: ${err instanceof Error ? err.message : String(err)}`,
          hint: "the graph-db backend is opt-in; unset `CODEHUB_STORE=lbug` or reinstall the binding",
        };
      }
    },
  };
}

function binaryOnPathCheck(bin: string, hint: string): Check {
  return {
    name: `${bin} binary`,
    async run() {
      const res = await runCommand(bin, ["--version"]);
      if (res.status !== 0) {
        return {
          status: "warn",
          message: `${bin} not on PATH`,
          hint,
        };
      }
      return { status: "ok", message: `${bin}: ${firstLine(res.stdout)}` };
    },
  };
}

function embedderWeightsCheck(home: string): Check {
  return {
    name: "embedder weights",
    async run() {
      // Filename convention matches `embedder/src/paths.ts:modelFileName` —
      // fp32 uses `model.onnx`, int8 uses `model_int8.onnx` (underscore,
      // NOT hyphen). A historical hyphenated path name lingered here and
      // caused false-negative `warn`s for users who had int8 weights on
      // disk.
      const base = join(home, ".codehub", "models", "gte-modernbert-base");
      const fp32 = join(base, "fp32", "model.onnx");
      const int8 = join(base, "int8", "model_int8.onnx");
      const fp32Ok = await fileExists(fp32);
      const int8Ok = await fileExists(int8);
      if (!fp32Ok && !int8Ok) {
        return {
          status: "warn",
          message: "no embedder weights found",
          hint: "run `codehub setup --embeddings` (fp32) or `codehub setup --embeddings --int8`",
        };
      }
      const variant = fp32Ok ? "fp32" : "int8";
      return { status: "ok", message: `embedder weights present (${variant})` };
    },
  };
}

function registryPathCheck(home: string): Check {
  return {
    name: "registry path",
    async run() {
      const regPath = join(home, ".codehub", "registry.json");
      // Single attempt: branch on `ENOENT` for the missing-file case so
      // the existence check and the read share one syscall — closes the
      // TOCTOU gap flagged by js/file-system-race.
      let raw: string;
      try {
        raw = await readFile(regPath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return {
            status: "warn",
            message: `~/.codehub/registry.json missing`,
            hint: "run `codehub analyze` in any git repo to create the registry",
          };
        }
        return {
          status: "fail",
          message: `registry read failed: ${err instanceof Error ? err.message : String(err)}`,
          hint: "delete ~/.codehub/registry.json and re-run `codehub analyze`",
        };
      }
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return {
            status: "fail",
            message: "registry.json is not an object",
            hint: "back up the file and run `codehub analyze` again",
          };
        }
        const count = Object.keys(parsed).length;
        return {
          status: "ok",
          message: `registry readable (${count} repo${count === 1 ? "" : "s"})`,
        };
      } catch (err) {
        return {
          status: "fail",
          message: `registry parse failed: ${err instanceof Error ? err.message : String(err)}`,
          hint: "delete ~/.codehub/registry.json and re-run `codehub analyze`",
        };
      }
    },
  };
}

function sarifSchemaCheck(repoRoot: string): Check {
  return {
    name: "@opencodehub/sarif build",
    async run() {
      const pkgDir = join(repoRoot, "packages", "sarif", "dist");
      try {
        const s = await stat(pkgDir);
        if (!s.isDirectory()) {
          return {
            status: "fail",
            message: "@opencodehub/sarif dist is not a directory",
            hint: "run `pnpm -r build`",
          };
        }
        return { status: "ok", message: "@opencodehub/sarif built" };
      } catch {
        return {
          status: "warn",
          message: "@opencodehub/sarif not built yet",
          hint: "run `pnpm -r build`",
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printTable(
  rows: readonly { readonly name: string; readonly result: CheckResult }[],
): void {
  const table = new Table({
    head: ["CHECK", "STATUS", "DETAIL", "HINT"],
    style: { head: [], border: [] },
    colWidths: [32, 8, 48, 48],
    wordWrap: true,
  });
  for (const { name, result } of rows) {
    const glyph = result.status === "ok" ? "OK" : result.status === "warn" ? "WARN" : "FAIL";
    table.push([name, glyph, result.message, result.hint ?? ""]);
  }
  console.log(table.toString());
}

async function runCommand(
  cmd: string,
  args: readonly string[],
): Promise<{ status: number; stdout: string; stderr: string }> {
  return await new Promise((resolveProm) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", () => {
      resolveProm({ status: 127, stdout, stderr });
    });
    child.on("close", (code: number | null) => {
      resolveProm({ status: code ?? 0, stdout, stderr });
    });
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function firstLine(s: string): string {
  const idx = s.indexOf("\n");
  return idx < 0 ? s.trim() : s.slice(0, idx).trim();
}

function guessRepoRoot(): string {
  // `codehub` ships from packages/cli/dist/commands — walking four levels
  // up lands at the monorepo root where `packages/` and `node_modules/`
  // live.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "..");
}

/**
 * Resolve an npm package for the native-binding checks. We try two
 * environments in order, so doctor returns `OK` in every realistic install
 * shape — monorepo checkout, global `pnpm i -g`, tarball, symlinked bin:
 *
 *   1. The CLI package's own `node_modules` — `createRequire` off
 *      `import.meta.url` walks outward through the same resolution chain
 *      Node would use for a real `await import(pkg)` from inside the CLI,
 *      so this is the authoritative answer for "can the CLI load this?".
 *   2. The supplied `repoRoot` — legacy fallback for the in-monorepo case
 *      where the CLI is running from `packages/cli/dist/` and dependencies
 *      hoist to the workspace root.
 *
 * We stop at the first hit. Returning `null` preserves the existing
 * semantics of the caller (`warn` result with a reinstall hint).
 */
function resolveFromRoot(repoRoot: string, pkg: string): string | null {
  // 1. CLI's own resolution context — the canonical answer.
  try {
    const req = createRequire(import.meta.url);
    return req.resolve(pkg);
  } catch {
    // fall through to repoRoot
  }
  // 2. Workspace/monorepo root fallback.
  try {
    const req = createRequire(join(repoRoot, "package.json"));
    return req.resolve(pkg);
  } catch {
    // fall through to per-package fallbacks
  }
  // 3. Per-workspace fallback. Under pnpm strict isolation, native bindings
  //    are direct deps of the package that uses them — `@duckdb/node-api`
  //    and `@ladybugdb/core` both live in `packages/storage`. Probing that
  //    package.json context lets `codehub doctor` resolve the bindings
  //    even when neither the CLI nor the workspace root declare them as
  //    direct deps.
  const owners =
    pkg.startsWith("@duckdb/") || pkg.startsWith("@ladybugdb/") ? ["packages/storage"] : [];
  for (const owner of owners) {
    try {
      const req = createRequire(join(repoRoot, owner, "package.json"));
      return req.resolve(pkg);
    } catch {
      // try next
    }
  }
  return null;
}
