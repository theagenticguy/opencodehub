/**
 * Per-language SCIP indexer orchestration.
 *
 * Each runner shells out to the language's native SCIP indexer and
 * writes `.opencodehub/scip/<lang>.scip`. The factory `runIndexer` is
 * fan-out friendly — callers invoke it once per detected language in
 * parallel via `Promise.all`.
 *
 * See `.erpaval/sessions/session-f8a300bc/research-scip-indexers.yaml`
 * for indexer versions + known issues as of 2026-04-26.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export type IndexerKind = "typescript" | "python" | "go" | "rust" | "java";

export interface RunIndexerOptions {
  readonly projectRoot: string;
  readonly outputDir: string; // e.g. <repo>/.opencodehub/scip
  readonly projectName?: string;
  readonly envOverlay?: NodeJS.ProcessEnv;
  readonly allowBuildScripts?: boolean; // required for rust + java
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
  return langs;
}

export async function runIndexer(
  kind: IndexerKind,
  opts: RunIndexerOptions,
): Promise<IndexerResult> {
  const outputDir = resolve(opts.outputDir);
  await mkdir(outputDir, { recursive: true });
  const scipPath = join(outputDir, `${kind}.scip`);
  const start = Date.now();

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

interface CommandPlan {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly versionCmd: string;
  readonly versionArgs: readonly string[];
  readonly tool: string;
  readonly skipReason?: string;
}

function buildCommand(kind: IndexerKind, opts: RunIndexerOptions, scipPath: string): CommandPlan {
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
  }
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
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
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
