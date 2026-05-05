/**
 * Per-language SCIP indexer orchestration.
 *
 * Each runner shells out to the language's native SCIP indexer and
 * writes `.codehub/scip/<lang>.scip`. The factory `runIndexer` is
 * fan-out friendly — callers invoke it once per detected language in
 * parallel via `Promise.all`.
 *
 * See `.erpaval/sessions/session-f8a300bc/research-scip-indexers.yaml`
 * for indexer versions + known issues as of 2026-04-26.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export type IndexerKind =
  | "typescript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "clang"
  | "cobol-proleap";

/** File extensions that signal a C/C++ project. */
const CLANG_EXTENSIONS: readonly string[] = [".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp"];

export interface RunIndexerOptions {
  readonly projectRoot: string;
  readonly outputDir: string; // e.g. <repo>/.codehub/scip
  readonly projectName?: string;
  readonly envOverlay?: NodeJS.ProcessEnv;
  /**
   * When true (legacy boolean form), every build-script-driven indexer is
   * enabled. Preserves backward compatibility with existing callers;
   * prefer {@link allowedBuildScripts} for fine-grained opt-ins.
   */
  readonly allowBuildScripts?: boolean; // required for rust + java
  /**
   * Explicit opt-in whitelist for build-script-driven indexers. Current
   * surface: `"proleap"` gates the COBOL deep-parse via
   * `@opencodehub/cobol-proleap`. Missing entry → the `cobol-proleap`
   * kind is skipped and COBOL falls through to the regex hot path.
   */
  readonly allowedBuildScripts?: readonly "proleap"[];
  /**
   * Path to the uwol/cobol-parser JAR when `allowedBuildScripts` includes
   * `"proleap"`. Default: `~/.codehub/vendor/proleap/proleap-cobol-parser.jar`.
   */
  readonly cobolProleapJarPath?: string;
  /**
   * Path to the directory containing `cobol_to_scip.class`. Default:
   * `~/.codehub/vendor/proleap/`.
   */
  readonly cobolProleapWrapperDir?: string;
  readonly timeoutMs?: number;
}

export interface IndexerResult {
  readonly kind: IndexerKind;
  readonly scipPath: string;
  readonly tool: string;
  readonly version: string;
  readonly skipped: boolean;
  readonly skipReason?: string;
  readonly durationMs: number;
}

/**
 * Detect which languages have roots worth indexing by looking for
 * idiomatic manifests. Returns the set a caller should fan out on.
 *
 * Note on `cobol-proleap`: the detector never infers the proleap kind
 * from disk alone — it is strictly gated behind
 * `allowedBuildScripts.includes("proleap")`, which the CLI surface only
 * sets in response to an explicit user opt-in (spec W-M4-1). Callers
 * that opted in append `"cobol-proleap"` to the detected set themselves.
 */
export function detectLanguages(projectRoot: string): readonly IndexerKind[] {
  const exists = (rel: string) => existsSync(join(projectRoot, rel));
  const langs: IndexerKind[] = [];
  if (exists("tsconfig.json") || exists("package.json")) langs.push("typescript");
  if (exists("pyproject.toml") || exists("setup.py") || exists("requirements.txt")) {
    langs.push("python");
  }
  if (exists("go.mod")) langs.push("go");
  if (exists("Cargo.toml")) langs.push("rust");
  if (
    exists("pom.xml") ||
    exists("build.gradle") ||
    exists("build.gradle.kts") ||
    exists("build.sbt")
  ) {
    langs.push("java");
  }
  // C/C++ has no canonical manifest — the authoritative signal is that
  // `scip-clang` consumes a JSON compilation database. We surface "clang"
  // as a candidate when either the compilation DB is already present OR
  // the project root has at least one source file with a C/C++ extension.
  // The preflight inside buildCommand("clang") still enforces the
  // compilation DB requirement at index time.
  if (exists("compile_commands.json") || hasClangSource(projectRoot)) {
    langs.push("clang");
  }
  return langs;
}

/**
 * Shallow scan for C/C++ source files at the project root. We look one
 * level deep on purpose: the common layouts (`src/`, `include/`, flat
 * root) are all covered, and we avoid walking `node_modules`,
 * `vendor/`, and the like. The `detectLanguages()` result is a
 * candidate list — a follow-on `runIndexer("clang", ...)` still
 * preflights `compile_commands.json` and skips cleanly if absent.
 */
function hasClangSource(projectRoot: string): boolean {
  try {
    const stack: string[] = [projectRoot];
    let depth = 0;
    while (stack.length > 0 && depth <= 1) {
      const levelSize = stack.length;
      for (let i = 0; i < levelSize; i++) {
        const dir = stack.shift() ?? "";
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith(".")) continue;
          if (entry.name === "node_modules") continue;
          if (entry.isFile()) {
            const lower = entry.name.toLowerCase();
            for (const ext of CLANG_EXTENSIONS) {
              if (lower.endsWith(ext)) return true;
            }
          } else if (entry.isDirectory() && depth < 1) {
            stack.push(join(dir, entry.name));
          }
        }
      }
      depth++;
    }
  } catch {
    // unreadable project root → no signal
  }
  return false;
}

/**
 * Resolve the default vendor paths for the ProLeap JAR + compiled
 * wrapper. Factored out so tests can inject in-memory paths.
 */
export function defaultCobolProleapPaths(home: string | undefined = process.env["HOME"]): {
  jarPath: string;
  wrapperDir: string;
} {
  const base = join(home ?? "", ".codehub", "vendor", "proleap");
  return {
    jarPath: join(base, "proleap-cobol-parser.jar"),
    wrapperDir: base,
  };
}

export async function runIndexer(
  kind: IndexerKind,
  opts: RunIndexerOptions,
): Promise<IndexerResult> {
  const outputDir = resolve(opts.outputDir);
  await mkdir(outputDir, { recursive: true });
  const scipPath = join(outputDir, `${kind}.scip`);
  const start = Date.now();

  // `cobol-proleap` is not a CLI spawn — it's a marker that the in-process
  // @opencodehub/cobol-proleap bridge should run during the parse phase.
  // We handle gating here so every caller can treat it uniformly with the
  // SCIP runners: the returned result is either activated (skipped=false,
  // no external cmd) or skipped with a reason the ingestion layer logs.
  if (kind === "cobol-proleap") {
    return resolveCobolProleap(opts, scipPath, start);
  }

  const plan = buildCommand(kind, opts, scipPath);
  if (plan.skipReason) {
    return {
      kind,
      scipPath,
      tool: plan.tool,
      version: "",
      skipped: true,
      skipReason: plan.skipReason,
      durationMs: Date.now() - start,
    };
  }

  const versionTask = probeVersion(plan.versionCmd, plan.versionArgs, opts.projectRoot);
  const indexTask = runCommand(plan.cmd, plan.args, plan.cwd, opts.envOverlay, opts.timeoutMs);
  const [version, indexOutcome] = await Promise.all([versionTask, indexTask]);
  if (indexOutcome.kind === "missing") {
    return {
      kind,
      scipPath,
      tool: plan.tool,
      version: "",
      skipped: true,
      skipReason: `indexer binary not found: ${plan.cmd}`,
      durationMs: Date.now() - start,
    };
  }
  if (indexOutcome.kind === "failed") {
    throw new Error(
      `scip-ingest: ${kind} indexer ${plan.cmd} exited ${indexOutcome.exitCode}. Stderr: ${indexOutcome.stderr.slice(0, 400)}`,
    );
  }

  return {
    kind,
    scipPath,
    tool: plan.tool,
    version,
    skipped: false,
    durationMs: Date.now() - start,
  };
}

export interface CommandPlan {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly versionCmd: string;
  readonly versionArgs: readonly string[];
  readonly tool: string;
  readonly skipReason?: string;
}

/**
 * Build the shell plan for a given indexer. Exported for unit tests — the
 * tests assert on flag shape + preflight skip semantics without spawning a
 * real subprocess. Runtime callers should invoke `runIndexer()` instead.
 */
export function buildCommand(
  kind: IndexerKind,
  opts: RunIndexerOptions,
  scipPath: string,
): CommandPlan {
  const cwd = opts.projectRoot;
  const name = opts.projectName ?? pathBasename(opts.projectRoot);

  switch (kind) {
    case "typescript": {
      // scip-typescript needs a tsconfig.json at a reachable project
      // dir. Monorepo fixtures often keep the tsconfig one level in
      // (e.g. `app/`). We run the indexer from the projectRoot and
      // pass the sub-dir as a positional `[projects...]` argument so
      // the emitted document paths stay rooted at projectRoot — the
      // factory's relativize() assumes that.
      const tsRoot = resolveTypeScriptRoot(cwd);
      const args: string[] = ["index", "--output", scipPath];
      if (tsRoot !== cwd) {
        const rel = tsRoot.slice(cwd.length).replace(/^[\\/]+/, "");
        args.push(rel);
      }
      return {
        cmd: "scip-typescript",
        args,
        cwd,
        versionCmd: "scip-typescript",
        versionArgs: ["--version"],
        tool: "scip-typescript",
      };
    }
    case "python":
      return {
        cmd: "scip-python",
        args: ["index", ".", `--project-name=${name}`, "--output", scipPath],
        cwd,
        versionCmd: "scip-python",
        versionArgs: ["--version"],
        tool: "scip-python",
      };
    case "go":
      return {
        cmd: "scip-go",
        args: ["--output", scipPath],
        cwd,
        versionCmd: "scip-go",
        versionArgs: ["--version"],
        tool: "scip-go",
      };
    case "rust":
      if (!opts.allowBuildScripts) {
        return {
          cmd: "rust-analyzer",
          args: [],
          cwd,
          versionCmd: "rust-analyzer",
          versionArgs: ["--version"],
          tool: "rust-analyzer",
          skipReason: "rust indexer runs build.rs scripts; pass allowBuildScripts=true to opt in",
        };
      }
      return {
        cmd: "rust-analyzer",
        args: ["scip", cwd, "--output", scipPath, "--exclude-vendored-libraries"],
        cwd,
        versionCmd: "rust-analyzer",
        versionArgs: ["--version"],
        tool: "rust-analyzer",
      };
    case "java":
      if (!opts.allowBuildScripts) {
        return {
          cmd: "scip-java",
          args: [],
          cwd,
          versionCmd: "scip-java",
          versionArgs: ["--version"],
          tool: "scip-java",
          skipReason:
            "java indexer invokes the project build; pass allowBuildScripts=true to opt in",
        };
      }
      return {
        cmd: "scip-java",
        args: ["index", "--output", scipPath],
        cwd,
        versionCmd: "scip-java",
        versionArgs: ["--version"],
        tool: "scip-java",
      };
    case "clang": {
      // scip-clang requires a JSON compilation database at the project
      // root. We do NOT attempt to generate one — projects point scip-
      // clang at the file emitted by their build system (CMake's
      // CMAKE_EXPORT_COMPILE_COMMANDS, Bazel's extractor, Bear for
      // Make, etc.). Missing file → skip with a specific, actionable
      // error — not a silent miss.
      //
      // Flag shape validated against scip-clang v0.4.0 source
      // (`indexer/main.cc`): `--compdb-path=<path>` and
      // `--index-output-path=<path>`. Per the upstream README, scip-
      // clang MUST be invoked from the project root.
      const compdbPath = join(cwd, "compile_commands.json");
      if (!existsSync(compdbPath)) {
        return {
          cmd: "scip-clang",
          args: [],
          cwd,
          versionCmd: "scip-clang",
          versionArgs: ["--version"],
          tool: "scip-clang",
          skipReason: "scip-clang requires compile_commands.json at project root",
        };
      }
      return {
        cmd: "scip-clang",
        args: [`--compdb-path=${compdbPath}`, `--index-output-path=${scipPath}`],
        cwd,
        versionCmd: "scip-clang",
        versionArgs: ["--version"],
        tool: "scip-clang",
      };
    }
    case "cobol-proleap":
      // Handled upstream in runIndexer(); this branch keeps the switch
      // exhaustive under `noFallthroughCasesInSwitch`.
      return {
        cmd: "cobol-proleap",
        args: [],
        cwd,
        versionCmd: "",
        versionArgs: [],
        tool: "cobol-proleap",
        skipReason: "cobol-proleap is resolved upstream, not via buildCommand",
      };
  }
}

/**
 * Resolve activation for the `cobol-proleap` kind. Returns an
 * {@link IndexerResult} reporting whether the deep-parse bridge is active
 * for this run. The actual JVM spawn lives in `@opencodehub/cobol-proleap`;
 * this runner only gates based on the opt-in whitelist and JAR presence.
 */
function resolveCobolProleap(
  opts: RunIndexerOptions,
  scipPath: string,
  start: number,
): IndexerResult {
  const tool = "cobol-proleap";
  const whitelisted =
    opts.allowedBuildScripts?.includes("proleap") === true || opts.allowBuildScripts === true;
  if (!whitelisted) {
    return {
      kind: "cobol-proleap",
      scipPath,
      tool,
      version: "",
      skipped: true,
      skipReason:
        "cobol-proleap is gated behind --allow-build-scripts=proleap; falling back to regex hot path",
      durationMs: Date.now() - start,
    };
  }
  const defaults = defaultCobolProleapPaths();
  const jarPath = opts.cobolProleapJarPath ?? defaults.jarPath;
  if (!existsSync(jarPath)) {
    return {
      kind: "cobol-proleap",
      scipPath,
      tool,
      version: "",
      skipped: true,
      skipReason:
        `cobol-proleap JAR not found at ${jarPath}. Run \`codehub setup --cobol-proleap\` to install it. ` +
        "Falling back to the regex hot path for this run.",
      durationMs: Date.now() - start,
    };
  }
  return {
    kind: "cobol-proleap",
    scipPath,
    tool,
    version: "v4",
    skipped: false,
    durationMs: Date.now() - start,
  };
}

type CommandOutcome =
  | { kind: "ok"; stdout: string; stderr: string }
  | { kind: "failed"; exitCode: number; stdout: string; stderr: string }
  | { kind: "missing" };

function runCommand(
  cmd: string,
  args: readonly string[],
  cwd: string,
  envOverlay: NodeJS.ProcessEnv | undefined,
  timeoutMs: number | undefined,
): Promise<CommandOutcome> {
  return new Promise((res) => {
    const child = spawn(cmd, args as string[], {
      cwd,
      env: { ...process.env, ...envOverlay },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill("SIGTERM");
      }, timeoutMs);
    }
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      if (e.code === "ENOENT") res({ kind: "missing" });
      else res({ kind: "failed", exitCode: -1, stdout, stderr: `${e.message}\n${stderr}` });
    });
    child.on("exit", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) res({ kind: "ok", stdout, stderr });
      else res({ kind: "failed", exitCode: code ?? -1, stdout, stderr });
    });
  });
}

async function probeVersion(cmd: string, args: readonly string[], cwd: string): Promise<string> {
  const outcome = await runCommand(cmd, args, cwd, undefined, 5000);
  if (outcome.kind !== "ok") return "unknown";
  const text = `${outcome.stdout}\n${outcome.stderr}`;
  const match = text.match(/\b\d+(?:\.\d+){1,3}(?:-[\w.]+)?\b/);
  return match?.[0] ?? (outcome.stdout.trim() || "unknown");
}

function pathBasename(p: string): string {
  const parts = resolve(p).split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

function resolveTypeScriptRoot(projectRoot: string): string {
  if (existsSync(join(projectRoot, "tsconfig.json"))) return projectRoot;
  // Prefer the conventional subdirectories first; fall back to a shallow
  // scan for any child dir that owns a tsconfig.json.
  const preferred = ["app", "packages", "src", "web", "client"];
  for (const p of preferred) {
    if (existsSync(join(projectRoot, p, "tsconfig.json"))) {
      return join(projectRoot, p);
    }
  }
  try {
    for (const entry of readdirSync(projectRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const candidate = join(projectRoot, entry.name, "tsconfig.json");
      if (existsSync(candidate)) return join(projectRoot, entry.name);
    }
  } catch {
    // Fall through; return projectRoot and let scip-typescript report.
  }
  return projectRoot;
}
