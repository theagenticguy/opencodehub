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
    list.push(treeSitterNativeCheck(repoRoot));
    list.push(duckdbWorksCheck(repoRoot));
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

function treeSitterNativeCheck(repoRoot: string): Check {
  return {
    name: "tree-sitter native binding",
    async run() {
      try {
        // tree-sitter ships a native .node binding. Loading the grammar
        // for TS is the cheapest health signal.
        const tsPath = resolveFromRoot(repoRoot, "tree-sitter");
        const tssPath = resolveFromRoot(repoRoot, "tree-sitter-typescript");
        if (!tsPath || !tssPath) {
          return {
            status: "warn",
            message: "tree-sitter or tree-sitter-typescript not installed",
            hint: "run `pnpm install` at the repo root",
          };
        }
        const Parser = (await import(tsPath)) as unknown as { default: new () => unknown };
        const tsMod = (await import(tssPath)) as unknown as {
          default?: { typescript: unknown };
          typescript?: unknown;
        };
        const ParserCtor = Parser.default ?? (Parser as unknown as new () => unknown);
        const parser = new (ParserCtor as new () => { setLanguage: (l: unknown) => void })();
        const language = tsMod.typescript ?? tsMod.default?.typescript;
        if (!language) {
          return {
            status: "fail",
            message: "tree-sitter-typescript has no `typescript` export",
            hint: "re-run `pnpm install` to rebuild native grammars",
          };
        }
        parser.setLanguage(language);
        return { status: "ok", message: "tree-sitter + typescript grammar load OK" };
      } catch (err) {
        return {
          status: "fail",
          message: `failed to load tree-sitter: ${err instanceof Error ? err.message : String(err)}`,
          hint: "re-run `pnpm install` to rebuild native bindings (requires clang/g++)",
        };
      }
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
        const mod = (await import(duckPath)) as {
          DuckDBInstance: {
            create: (path: string) => Promise<{
              connect: () => Promise<{ close: () => void | Promise<void> }>;
              close?: () => void | Promise<void>;
            }>;
          };
        };
        // In-memory instance: never touches disk, never lingers.
        const inst = await mod.DuckDBInstance.create(":memory:");
        const conn = await inst.connect();
        await conn.close();
        if (typeof inst.close === "function") await inst.close();
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
      try {
        await access(regPath);
      } catch {
        return {
          status: "warn",
          message: `~/.codehub/registry.json missing`,
          hint: "run `codehub analyze` in any git repo to create the registry",
        };
      }
      try {
        const raw = await readFile(regPath, "utf8");
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
          message: `registry read failed: ${err instanceof Error ? err.message : String(err)}`,
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
    return null;
  }
}
