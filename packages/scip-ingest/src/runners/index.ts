/**
 * Per-language SCIP indexer orchestration.
 *
 * Each runner shells out to the language's native SCIP indexer and
 * writes `.codehub/scip/<lang>.scip`. The factory `runIndexer` is
 * fan-out friendly — callers invoke it once per detected language in
 * parallel via `Promise.all`.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type IndexerKind =
  | "typescript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "clang"
  | "cobol-proleap"
  | "ruby"
  | "dotnet"
  | "kotlin";

/** File extensions that signal a C/C++ project. */
const CLANG_EXTENSIONS: readonly string[] = [".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp"];

/**
 * Optional async probe for `dotnet --version`. Returns the version string
 * (e.g. `"8.0.404"`) on success, or `undefined` when the SDK is missing /
 * the probe fails. Tests inject a stub so the test runner does not need a
 * real `dotnet` on PATH.
 */
export type DotnetProbe = () => Promise<string | undefined>;

/**
 * Minimum .NET SDK major version required by scip-dotnet v0.2.12. If the
 * runtime probe detects a lower major (or `dotnet` is absent), the runner
 * short-circuits with a `skipReason` pointing at `codehub setup --scip=dotnet`.
 */
export const SCIP_DOTNET_MIN_SDK_MAJOR = 8;

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
  /**
   * Override the `dotnet --version` preflight probe (tests). When unset,
   * the runner spawns `dotnet --version` directly. Only consulted when
   * `kind === "dotnet"`.
   */
  readonly dotnetProbe?: DotnetProbe;
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
 * sets in response to an explicit user opt-in. Callers that opted in
 * append `"cobol-proleap"` to the detected set themselves.
 *
 * Kotlin note: before scip-kotlin existed as a standalone SCIP adapter,
 * Kotlin projects rode on the `java` adapter + the tree-sitter-kotlin
 * grammar. With scip-kotlin v0.6.0 promoted in, we detect `.kt`/`.kts` source
 * files directly and emit `"kotlin"` as its own candidate. Pure-Kotlin
 * projects (Kotlin sources, no Java sources, no `pom.xml` / `build.sbt` /
 * plain `build.gradle`) drop `"java"` so the project doesn't double-emit SCIP
 * via both adapters. Mixed Kotlin+Java projects keep both.
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

  const hasJvmManifest =
    exists("pom.xml") ||
    exists("build.gradle") ||
    exists("build.gradle.kts") ||
    exists("build.sbt");

  // Shallow scan for `.kt` / `.kts` / `.java` source files. We don't walk the
  // whole tree — the JVM manifest already told us it's a JVM project; the
  // file scan is only disambiguating Kotlin-vs-Java within it.
  const { hasKotlinSource, hasJavaSource } = scanJvmSources(projectRoot);

  const kotlinDetected = hasKotlinSource || (hasJvmManifest && exists("build.gradle.kts"));
  const javaDetected = hasJvmManifest || hasJavaSource;

  if (kotlinDetected) langs.push("kotlin");
  if (javaDetected) {
    // Pure-Kotlin: drop `java` so we don't double-emit SCIP. A
    // `build.gradle.kts` alone is Kotlin DSL, not Java source evidence.
    const pureKotlin =
      kotlinDetected &&
      !hasJavaSource &&
      !exists("pom.xml") &&
      !exists("build.sbt") &&
      !exists("build.gradle");
    if (!pureKotlin) langs.push("java");
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
  // Ruby: look for the canonical Bundler / Rake manifests at the repo root.
  // `*.gemspec` is included because gem libraries commonly ship without a
  // Gemfile. scip-ruby itself reads `sorbet/config` at index time if present,
  // but detection here is manifest-based so we stay consistent with the rest
  // of the function.
  if (
    exists("Gemfile") ||
    exists("Gemfile.lock") ||
    exists("Rakefile") ||
    exists("sorbet/config") ||
    hasGemspec(projectRoot)
  ) {
    langs.push("ruby");
  }
  // .NET has no single canonical manifest — `.sln` covers multi-project
  // workspaces, `.csproj` covers C# single-project layouts, and `.vbproj`
  // covers the rarer VB.NET case. Loose `.cs` / `.vb` files at the root
  // (no project file) still warrant a candidate emit — the preflight
  // inside buildCommand("dotnet") enforces the .NET SDK requirement at
  // index time.
  if (hasDotnetProject(projectRoot)) {
    langs.push("dotnet");
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
 * Shallow scan for .NET project markers at the project root. Looks for the
 * canonical project files (`.sln`, `.csproj`, `.vbproj`, `.fsproj`) and
 * falls back to detecting loose `.cs` / `.vb` source files at the root —
 * enough to trigger the `dotnet` candidate without walking the whole tree.
 */
function hasDotnetProject(projectRoot: string): boolean {
  try {
    for (const entry of readdirSync(projectRoot, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (
        lower.endsWith(".sln") ||
        lower.endsWith(".csproj") ||
        lower.endsWith(".vbproj") ||
        lower.endsWith(".fsproj") ||
        lower.endsWith(".cs") ||
        lower.endsWith(".vb")
      ) {
        return true;
      }
    }
  } catch {
    // unreadable project root → no signal
  }
  return false;
}

/** Shallow root-only scan for any `*.gemspec` sibling. */
function hasGemspec(projectRoot: string): boolean {
  try {
    for (const entry of readdirSync(projectRoot, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".gemspec")) return true;
    }
  } catch {
    // Unreadable project root → no signal.
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

/**
 * Bounded shallow scan for `.kt` / `.kts` / `.java` files. Descends up to 4
 * directories deep under `projectRoot`, skipping conventional noise dirs
 * (`node_modules`, `target`, `build`, `dist`, `out`, dotfiles). Stops early
 * once both questions are answered.
 */
function scanJvmSources(projectRoot: string): {
  hasKotlinSource: boolean;
  hasJavaSource: boolean;
} {
  let hasKotlinSource = false;
  let hasJavaSource = false;

  const scanDir = (dir: string, depth: number): void => {
    if (hasKotlinSource && hasJavaSource) return;
    if (depth > 4) return;
    let names: string[];
    try {
      names = readdirSync(dir) as string[];
    } catch {
      return;
    }
    for (const name of names) {
      if (hasKotlinSource && hasJavaSource) return;
      if (
        name === "node_modules" ||
        name === "target" ||
        name === "build" ||
        name === "out" ||
        name === "dist" ||
        name.startsWith(".")
      ) {
        continue;
      }
      const full = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        scanDir(full, depth + 1);
        continue;
      }
      if (name.endsWith(".kt") || name.endsWith(".kts")) {
        hasKotlinSource = true;
      } else if (name.endsWith(".java")) {
        hasJavaSource = true;
      }
    }
  };

  scanDir(projectRoot, 0);
  return { hasKotlinSource, hasJavaSource };
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

  // scip-dotnet is installed via `dotnet tool install --global scip-dotnet`
  // and therefore requires the .NET SDK on PATH at analyze time. We probe
  // `dotnet --version` here — NOT inside buildCommand — because the probe
  // is async while buildCommand must stay sync.
  if (kind === "dotnet") {
    const preflight = await preflightDotnet(opts.dotnetProbe);
    if (preflight !== undefined) {
      return {
        kind,
        scipPath,
        tool: "scip-dotnet",
        version: "",
        skipped: true,
        skipReason: preflight,
        durationMs: Date.now() - start,
      };
    }
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

  // Kotlin version preflight — scip-kotlin v0.6.0 requires Kotlin 2.2+.
  // We probe `kotlinc -version` up-front and short-circuit with a clear
  // skip-reason when the toolchain is too old. The probe failure ("kotlinc
  // not on PATH") is surfaced in the normal indexOutcome.missing branch
  // below, so we don't duplicate handling here — we only add the "too old"
  // branch.
  if (kind === "kotlin") {
    const detected = await probeVersion(plan.versionCmd, plan.versionArgs, opts.projectRoot);
    const check = checkKotlinMinVersion(detected);
    if (!check.ok) {
      return {
        kind,
        scipPath,
        tool: plan.tool,
        version: detected,
        skipped: true,
        skipReason: check.reason,
        durationMs: Date.now() - start,
      };
    }
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
    // Tool-manager shim that resolved on PATH but cannot pick a version
    // (e.g. mise/asdf shims when no version is pinned for the current
    // project). The binary "exists" so `which`/spawn succeed, but the shim
    // exits non-zero with a "No version is set" message before the real
    // indexer ever runs. This is an environment/config gap, NOT an indexer
    // crash — surface it as a graceful, actionable skip instead of throwing
    // (a throw becomes the alarming "indexer failed" warning upstream).
    const shimReason = detectVersionManagerShimFailure(plan.cmd, indexOutcome.stderr);
    if (shimReason !== undefined) {
      return {
        kind,
        scipPath,
        tool: plan.tool,
        version: "",
        skipped: true,
        skipReason: shimReason,
        durationMs: Date.now() - start,
      };
    }
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
    case "ruby": {
      // scip-ruby (v0.4.7) CLI per
      // https://github.com/sourcegraph/scip-ruby/blob/scip-ruby-v0.4.7/docs/scip-ruby/CLI.md
      //
      //   --index-file <arg>    Output path; defaults to `index.scip`.
      //   --gem-metadata <arg>  `name@version`. Optional — inferred from
      //                         Gemfile.lock / *.gemspec / cwd when absent.
      //
      // Invocation contract:
      //   - With `sorbet/config`, `scip-ruby` reads the file list from there
      //     (the Sorbet convention). No positional arg needed.
      //   - Without `sorbet/config`, the `.` positional argument indexes all
      //     files reachable from the project root.
      //   - `--gem-metadata` is forwarded when `opts.projectName` is supplied
      //     so graph edges carry a stable gem identifier even in repos with
      //     no Gemfile.lock (e.g. script directories).
      const args: string[] = ["--index-file", scipPath];
      if (opts.projectName) {
        args.push("--gem-metadata", `${opts.projectName}@0.0.0`);
      }
      if (!existsSync(join(cwd, "sorbet", "config"))) {
        args.push(".");
      }
      return {
        cmd: "scip-ruby",
        args,
        cwd,
        versionCmd: "scip-ruby",
        versionArgs: ["--version"],
        tool: "scip-ruby",
      };
    }
    case "dotnet":
      // scip-dotnet v0.2.12 reads the .sln/.csproj tree at <path> and
      // writes a SCIP index to the -o location. It shells out to the
      // .NET SDK for build graph introspection, so the preflight in
      // runIndexer() ensures `dotnet` (SDK ≥ 8) is available before we
      // reach this command.
      return {
        cmd: "scip-dotnet",
        args: ["index", cwd, "-o", scipPath],
        cwd,
        versionCmd: "scip-dotnet",
        versionArgs: ["--version"],
        tool: "scip-dotnet",
      };
    case "kotlin": {
      // scip-kotlin v0.6.0 is a kotlinc compiler plugin (JAR), NOT a
      // standalone CLI. The emission flow is two-stage:
      //   1. `kotlinc -Xplugin=<jar> -P plugin:semanticdb-kotlinc:sourceroot=<cwd>
      //         -P plugin:semanticdb-kotlinc:targetroot=<semanticdbDir> <cwd>`
      //      → emits `*.semanticdb` files under `<semanticdbDir>/META-INF/semanticdb/`.
      //   2. `scip-java index-semanticdb --output <scipPath> <semanticdbDir>`
      //      converts the SemanticDB tree into a single `.scip` index.
      //
      // The plugin JAR is installed by `codehub setup --scip=kotlin` under
      // `~/.codehub/bin/semanticdb-kotlinc-0.6.0.jar` (see
      // `packages/cli/src/scip-pins.ts`). Preconditions surfaced at runtime:
      //   - Kotlin 2.2+ is REQUIRED by scip-kotlin v0.6.0 (upstream changelog).
      //     `versionCmd=kotlinc -version` feeds `probeVersion` the Kotlin
      //     version string, and downstream consumers MAY assert >= 2.2.
      //   - `scip-java` must also be on PATH for the SemanticDB → SCIP step.
      //
      // Gated behind `allowBuildScripts` for the same reason as `java`: the
      // plugin runs the Kotlin compiler end-to-end, which may trigger build
      // scripts and download dependencies.
      if (!opts.allowBuildScripts) {
        return {
          cmd: "kotlinc",
          args: [],
          cwd,
          versionCmd: "kotlinc",
          versionArgs: ["-version"],
          tool: "scip-kotlin",
          skipReason:
            "kotlin indexer compiles the project via kotlinc; pass allowBuildScripts=true to opt in",
        };
      }
      const jarPath = resolveScipKotlinJar(opts.envOverlay);
      const semanticdbDir = join(resolve(opts.outputDir), "kotlin-semanticdb");
      // Chain through `sh -c` to keep `runIndexer`'s one-child-process shape.
      // Composite exit code propagates cleanly via `&&`.
      const kotlincInvocation = [
        "kotlinc",
        `-Xplugin=${shellQuote(jarPath)}`,
        `-P plugin:semanticdb-kotlinc:sourceroot=${shellQuote(cwd)}`,
        `-P plugin:semanticdb-kotlinc:targetroot=${shellQuote(semanticdbDir)}`,
        shellQuote(cwd),
      ].join(" ");
      const convertInvocation = [
        "scip-java",
        "index-semanticdb",
        "--output",
        shellQuote(scipPath),
        shellQuote(semanticdbDir),
      ].join(" ");
      const mkSemanticdb = `mkdir -p ${shellQuote(semanticdbDir)}`;
      return {
        cmd: "sh",
        args: ["-c", `${mkSemanticdb} && ${kotlincInvocation} && ${convertInvocation}`],
        cwd,
        versionCmd: "kotlinc",
        versionArgs: ["-version"],
        tool: "scip-kotlin",
      };
    }
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

/**
 * Run `dotnet --version` (or the injected probe) and verify the SDK major
 * meets {@link SCIP_DOTNET_MIN_SDK_MAJOR}. Returns `undefined` on success
 * (caller proceeds), or a user-facing skip reason when the SDK is missing
 * or too old. The skip reason always points at `codehub setup --scip=dotnet`
 * so users have a single install entry point.
 */
async function preflightDotnet(probe: DotnetProbe | undefined): Promise<string | undefined> {
  const runProbe = probe ?? defaultDotnetProbe;
  const version = await runProbe();
  const major = parseDotnetMajor(version);
  if (major === undefined) {
    return (
      `scip-dotnet requires .NET SDK ${SCIP_DOTNET_MIN_SDK_MAJOR}.0+ on PATH ` +
      `(dotnet is not on PATH). ` +
      `Install from https://dotnet.microsoft.com/download, then run ` +
      "`codehub setup --scip=dotnet` to surface the install hint."
    );
  }
  if (major < SCIP_DOTNET_MIN_SDK_MAJOR) {
    return (
      `scip-dotnet requires .NET SDK ${SCIP_DOTNET_MIN_SDK_MAJOR}.0+ on PATH ` +
      `(detected dotnet --version: ${version ?? "unknown"}). ` +
      `Upgrade from https://dotnet.microsoft.com/download, then run ` +
      "`codehub setup --scip=dotnet`."
    );
  }
  return undefined;
}

/** Default `dotnet --version` probe — spawns `dotnet --version` with a 5s timeout. */
const defaultDotnetProbe: DotnetProbe = async () => {
  const outcome = await runCommand("dotnet", ["--version"], process.cwd(), undefined, 5000);
  if (outcome.kind !== "ok") return undefined;
  return outcome.stdout.trim() || undefined;
};

/** Parse `dotnet --version` output and extract the major version number. */
function parseDotnetMajor(version: string | undefined): number | undefined {
  if (version === undefined) return undefined;
  const match = version.match(/^(\d+)\./);
  if (match === null) return undefined;
  const parsed = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Resolve the installed `semanticdb-kotlinc-<version>.jar`. Honors a
 * `SCIP_KOTLIN_JAR` env overlay (for tests and power-user overrides); falls
 * back to the conventional install location
 * `~/.codehub/bin/semanticdb-kotlinc-0.6.0.jar` (matches the `binName` in
 * `scip-pins.ts`).
 */
function resolveScipKotlinJar(envOverlay: NodeJS.ProcessEnv | undefined): string {
  const override = envOverlay?.["SCIP_KOTLIN_JAR"] ?? process.env["SCIP_KOTLIN_JAR"];
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), ".codehub", "bin", "semanticdb-kotlinc-0.6.0.jar");
}

/** Minimal POSIX single-quote shell quoting. Safe for paths + args. */
function shellQuote(arg: string): string {
  if (arg === "") return "''";
  if (/^[A-Za-z0-9_./:@=+,-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * scip-kotlin v0.6.0 requires Kotlin 2.2 or newer on PATH (upstream changelog:
 * "This release sets the minimal supported version of Kotlin to 2.2"). Older
 * kotlinc versions will fail the kotlinc invocation with plugin-compatibility
 * errors, so we preflight at `runIndexer` entry and surface a clean
 * `skipReason` instead.
 */
export const KOTLIN_MIN_MAJOR = 2;
export const KOTLIN_MIN_MINOR = 2;

/**
 * Validate a probed `kotlinc -version` string against `KOTLIN_MIN_*`. Returns
 * `{ ok: true }` when the version is new enough, or `{ ok: false, reason }`
 * when kotlinc is on PATH but too old. An unknown version string is treated
 * as "too old" — we refuse to run the indexer against an unverifiable
 * toolchain so users get a visible skip instead of a silent fail-later.
 */
export function checkKotlinMinVersion(
  versionString: string,
): { ok: true } | { ok: false; reason: string } {
  if (versionString === "" || versionString === "unknown") {
    return {
      ok: false,
      reason:
        `kotlinc version could not be parsed (probed: ${versionString || "<empty>"}); ` +
        `scip-kotlin v0.6.0 requires Kotlin ${KOTLIN_MIN_MAJOR}.${KOTLIN_MIN_MINOR}+ on PATH`,
    };
  }
  // `kotlinc -version` prints `info: kotlinc-jvm 2.2.0 (JRE 17.0.11)` to stderr.
  // `probeVersion` pre-filters this to the first `\d+.\d+...` token, so we
  // work with e.g. `2.2.0` or `1.9.24`. We still tolerate fuller strings.
  const m = versionString.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (m === null) {
    return {
      ok: false,
      reason:
        `kotlinc version could not be parsed (probed: ${versionString}); ` +
        `scip-kotlin v0.6.0 requires Kotlin ${KOTLIN_MIN_MAJOR}.${KOTLIN_MIN_MINOR}+ on PATH`,
    };
  }
  const major = Number.parseInt(m[1] ?? "", 10);
  const minor = Number.parseInt(m[2] ?? "", 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) {
    return {
      ok: false,
      reason: `kotlinc reported non-numeric version ${versionString}; expected ${KOTLIN_MIN_MAJOR}.${KOTLIN_MIN_MINOR}+`,
    };
  }
  const tooOld =
    major < KOTLIN_MIN_MAJOR || (major === KOTLIN_MIN_MAJOR && minor < KOTLIN_MIN_MINOR);
  if (tooOld) {
    return {
      ok: false,
      reason:
        `kotlinc ${major}.${minor} is too old for scip-kotlin v0.6.0; ` +
        `install Kotlin ${KOTLIN_MIN_MAJOR}.${KOTLIN_MIN_MINOR}+ and retry`,
    };
  }
  return { ok: true };
}

/**
 * Detect a version-manager shim that resolved on PATH but failed to select
 * a version for the current project (mise/asdf/rtx "No version is set for
 * shim: <cmd>"). When the indexer is invoked through such a shim and the
 * project hasn't pinned a version, the shim exits non-zero with this message
 * BEFORE the real indexer runs — the binary appears present but is not
 * actually runnable here.
 *
 * Returns an actionable skip reason when the failure matches, otherwise
 * `undefined` (so the caller throws the generic indexer-crash error). The
 * reason points the operator at both fixes: pin a version for the project,
 * or install the indexer outside the shim so it resolves unconditionally.
 *
 * Exported for unit tests.
 */
export function detectVersionManagerShimFailure(cmd: string, stderr: string): string | undefined {
  // mise: "mise ERROR No version is set for shim: scip-python"
  // asdf: "No version is set for command <cmd>" / "asdf: No version set"
  // rtx (legacy mise name): "rtx ERROR No version is set for shim: <cmd>"
  const noVersionSet =
    /no version (?:is )?set(?: for (?:shim|command))?/i.test(stderr) ||
    /please specify a version|run `mise use|run `asdf (?:local|global)/i.test(stderr);
  const looksLikeShim = /\b(mise|asdf|rtx)\b/i.test(stderr) || noVersionSet;
  if (!noVersionSet || !looksLikeShim) return undefined;
  return (
    `${cmd} is exposed via a version-manager shim (mise/asdf) but no version ` +
    `is pinned for this project, so the shim exited before the indexer ran. ` +
    `Fix: pin it for the project (e.g. \`mise use ${cmd}@latest\`) or install ` +
    `${cmd} outside the shim so it resolves unconditionally. Skipping ${cmd} for this run.`
  );
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
    // `shell: false` is explicit — the cmd + args are passed to the OS
    // exec call as separate argv entries and never reach a shell parser.
    // Every `cmd` value is a fixed indexer name (see buildCommand) and
    // `args` is constructed as an array of literal flags + resolved
    // paths, so user-controlled path segments cannot inject shell
    // metacharacters. The explicit `shell: false` is what tells CodeQL
    // (js/shell-command-*) that this is not a shell invocation.
    const child = spawn(cmd, args as string[], {
      cwd,
      env: { ...process.env, ...envOverlay },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
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
