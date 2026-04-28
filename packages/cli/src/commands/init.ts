/**
 * `codehub init` — bootstrap a repository for OpenCodeHub in one command.
 *
 * Project-scope installer. Copies plugin assets (skills/agents/commands/hooks)
 * into `<repo>/.claude/`, writes `.mcp.json` so Claude Code launches the
 * `codehub` MCP server, appends `.codehub/` to `.gitignore`, and seeds a
 * starter `opencodehub.policy.yaml` (commented out; rules ship in spec 002).
 *
 * Why project scope:
 *   - Checking `.claude/` into git means every teammate's Claude Code
 *     auto-discovers the plugin on clone. No per-machine install.
 *   - Keeps the plugin pinned to the repo's graph schema; upgrades are
 *     explicit (`codehub init --upgrade`) rather than ambient.
 *
 * Hook rewrite note:
 *   The plugin's `hooks.json` uses `${CLAUDE_PLUGIN_ROOT}` which is only
 *   bound for user-scope plugins. Project-scope hooks must use
 *   `${CLAUDE_PROJECT_DIR}/.claude` for Claude Code to find the shell
 *   scripts. We rewrite the token at install time and write the result
 *   to `.claude/settings.json` (the project-scope equivalent of
 *   `hooks.json`).
 *
 * Idempotence: re-running with identical args produces byte-identical
 * output. Re-running against an existing `.claude/` refuses unless
 * `--force` is set, and the error lists every conflicting file.
 *
 * Filesystem access goes through the same `FsApi` seam used by
 * `commands/setup.ts` so tests run against an in-memory implementation.
 */

import { statSync } from "node:fs";
import {
  access,
  copyFile as fsCopyFile,
  mkdir as fsMkdir,
  readdir as fsReaddir,
  readFile as fsReadFile,
  rename as fsRename,
  rm as fsRm,
  stat as fsStat,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic as defaultWriteFileAtomic } from "../fs-atomic.js";
import { type FsApi, runSetup, type SetupOptions, type SetupResult } from "./setup.js";

const DEFAULT_FS: FsApi = {
  async readFile(path) {
    return await fsReadFile(path, "utf8");
  },
  async writeFileAtomic(path, contents) {
    await defaultWriteFileAtomic(path, contents, { raw: true });
  },
  async copyFile(src, dest) {
    await fsCopyFile(src, dest);
  },
  async mkdir(path) {
    await fsMkdir(path, { recursive: true });
  },
  async exists(path) {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
  async readdir(path) {
    return (await fsReaddir(path, { withFileTypes: false })) as readonly string[];
  },
  async rename(src, dest) {
    await fsRename(src, dest);
  },
  async rm(path, opts) {
    await fsRm(path, opts);
  },
  async statIsDirectory(path) {
    try {
      const st = await fsStat(path);
      return st.isDirectory();
    } catch {
      return false;
    }
  },
};

export interface InitOptions {
  /** Target repo. Defaults to `process.cwd()`. */
  readonly repo?: string;
  /** Plugin source dir. Defaults to the bundled `dist/plugin-assets/`. */
  readonly sourceDir?: string;
  /**
   * Overwrite `.claude/` on re-run. Without `--force`, conflicting files cause
   * a refusal listing each one.
   */
  readonly force?: boolean;
  /**
   * Skip the `.mcp.json` edit. Useful for teams that manage MCP config
   * elsewhere (e.g., via Claude Code user-scope config).
   */
  readonly skipMcp?: boolean;
  /**
   * Skip seeding `opencodehub.policy.yaml`. The starter file is commented out
   * and purely informational; some repos may prefer to author their own.
   */
  readonly skipPolicy?: boolean;
  /** FS seam. Defaults to real filesystem. */
  readonly fs?: FsApi;
  /** Structured logger. Defaults to `console.warn`. */
  readonly log?: (message: string) => void;
  readonly warn?: (message: string) => void;
  /** Override home dir (forwarded to `runSetup` for claude-code MCP write). */
  readonly home?: string;
}

export interface InitResult {
  readonly repoRoot: string;
  readonly sourceDir: string;
  readonly claudeDir: string;
  readonly filesCopied: number;
  readonly hooksWrittenTo: string | null;
  readonly mcpResult: SetupResult | null;
  readonly gitignoreUpdated: boolean;
  readonly policySeeded: boolean;
}

/**
 * Entry point for `codehub init`. Returns a structured result; throws on
 * unrecoverable error (e.g., plugin source missing, conflicts without
 * `--force`).
 */
export async function runInit(opts: InitOptions = {}): Promise<InitResult> {
  const fs = opts.fs ?? DEFAULT_FS;
  const log = opts.log ?? ((msg: string) => console.warn(msg));
  const warn = opts.warn ?? ((msg: string) => console.warn(msg));
  const repoRoot = resolve(opts.repo ?? process.cwd());
  const sourceDir = opts.sourceDir ?? defaultPluginSourceDir();
  const claudeDir = resolve(repoRoot, ".claude");
  const force = opts.force === true;

  if (!(await fs.exists(sourceDir))) {
    throw new Error(
      `codehub init: plugin source not found at ${sourceDir}. Re-install the codehub CLI or run from a workspace checkout.`,
    );
  }

  const plan = await buildInstallPlan(fs, sourceDir, claudeDir);

  if (!force) {
    const conflicts = await detectConflicts(fs, plan);
    if (conflicts.length > 0) {
      const lines = conflicts.map((p) => `  - ${relative(repoRoot, p)}`).join("\n");
      throw new Error(
        `codehub init: refusing to overwrite ${conflicts.length} existing file(s):\n${lines}\nRe-run with --force to overwrite.`,
      );
    }
  }

  for (const step of plan) {
    await fs.mkdir(dirname(step.targetPath));
    if (step.source === "copy") {
      await fs.copyFile(step.sourcePath, step.targetPath);
    } else {
      await fs.writeFileAtomic(step.targetPath, step.contents);
    }
  }

  const filesCopied = plan.length;
  log(`codehub init: installed ${filesCopied} file(s) under ${relative(repoRoot, claudeDir)}/`);

  // Write project-scope hooks — rewrite of the plugin's hooks.json.
  const hooksTarget = resolve(claudeDir, "settings.json");
  const hooksWritten = await writeProjectScopeHooks(fs, sourceDir, hooksTarget, log, warn);

  // MCP entry via the existing setup pipeline (single editor: claude-code).
  let mcpResult: SetupResult | null = null;
  if (opts.skipMcp !== true) {
    const setupOpts: SetupOptions = {
      editors: ["claude-code"],
      projectRoot: repoRoot,
      fs,
      log,
      warn,
      ...(opts.home !== undefined ? { home: opts.home } : {}),
    };
    const results = await runSetup(setupOpts);
    mcpResult = results[0] ?? null;
  }

  // Append `.codehub/` to .gitignore (idempotent).
  const gitignoreUpdated = await ensureGitignoreEntry(fs, repoRoot, ".codehub/", log);

  // Seed opencodehub.policy.yaml (commented-out starter).
  let policySeeded = false;
  if (opts.skipPolicy !== true) {
    policySeeded = await seedPolicyFile(fs, repoRoot, log);
  }

  return {
    repoRoot,
    sourceDir,
    claudeDir,
    filesCopied,
    hooksWrittenTo: hooksWritten ? hooksTarget : null,
    mcpResult,
    gitignoreUpdated,
    policySeeded,
  };
}

/** One step in the install plan. */
type PlanStep =
  | {
      readonly source: "copy";
      readonly sourcePath: string;
      readonly targetPath: string;
    }
  | {
      readonly source: "generate";
      readonly contents: string;
      readonly targetPath: string;
    };

async function buildInstallPlan(
  fs: FsApi,
  sourceDir: string,
  claudeDir: string,
): Promise<readonly PlanStep[]> {
  const plan: PlanStep[] = [];
  // The plugin root maps onto `.claude/` directly: skills → .claude/skills,
  // agents → .claude/agents, commands → .claude/commands, hooks → .claude/hooks.
  for (const entry of ["skills", "agents", "commands", "hooks"] as const) {
    const src = join(sourceDir, entry);
    const dest = join(claudeDir, entry);
    if (!(await fs.exists(src))) continue;
    await collectCopySteps(fs, src, dest, plan);
  }
  return plan;
}

async function collectCopySteps(
  fs: FsApi,
  src: string,
  dest: string,
  out: PlanStep[],
): Promise<void> {
  if (!fs.readdir) {
    throw new Error("FsApi.readdir is required for init plan building");
  }
  const entries = await fs.readdir(src);
  for (const name of entries) {
    const from = join(src, name);
    const to = join(dest, name);
    const isDir = fs.statIsDirectory ? await fs.statIsDirectory(from) : false;
    if (isDir) {
      await collectCopySteps(fs, from, to, out);
    } else {
      out.push({ source: "copy", sourcePath: from, targetPath: to });
    }
  }
}

async function detectConflicts(fs: FsApi, plan: readonly PlanStep[]): Promise<readonly string[]> {
  const conflicts: string[] = [];
  for (const step of plan) {
    if (await fs.exists(step.targetPath)) conflicts.push(step.targetPath);
  }
  return conflicts;
}

/**
 * Convert the plugin's user-scope `hooks.json` into a project-scope
 * `.claude/settings.json`. Claude Code resolves `${CLAUDE_PROJECT_DIR}` at
 * runtime to the repo root, so we rewrite `${CLAUDE_PLUGIN_ROOT}` → that.
 */
async function writeProjectScopeHooks(
  fs: FsApi,
  sourceDir: string,
  targetPath: string,
  log: (m: string) => void,
  warn: (m: string) => void,
): Promise<boolean> {
  const pluginHooksPath = join(sourceDir, "hooks.json");
  if (!(await fs.exists(pluginHooksPath))) {
    warn(
      `codehub init: plugin hooks.json missing at ${pluginHooksPath}; skipping project-scope hook wire-up.`,
    );
    return false;
  }
  const raw = await fs.readFile(pluginHooksPath);
  const rewritten = raw
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal token to substitute
    .replaceAll("${CLAUDE_PLUGIN_ROOT}", "${CLAUDE_PROJECT_DIR}/.claude");
  const parsed = JSON.parse(rewritten) as Record<string, unknown>;

  // Merge into existing .claude/settings.json if present. Only the `hooks`
  // key is upserted; every sibling key is preserved.
  const existing = (await fs.exists(targetPath)) ? await fs.readFile(targetPath) : undefined;
  const doc: Record<string, unknown> =
    existing && existing.trim().length > 0 ? (JSON.parse(existing) as Record<string, unknown>) : {};
  doc["hooks"] = parsed["hooks"];
  const merged = `${JSON.stringify(doc, null, 2)}\n`;

  if (existing === merged) {
    log(`codehub init: ${relative(dirname(dirname(targetPath)), targetPath)} already up to date`);
    return true;
  }
  await fs.writeFileAtomic(targetPath, merged);
  log(`codehub init: wrote hooks to ${targetPath}`);
  return true;
}

async function ensureGitignoreEntry(
  fs: FsApi,
  repoRoot: string,
  line: string,
  log: (m: string) => void,
): Promise<boolean> {
  const target = join(repoRoot, ".gitignore");
  const existing = (await fs.exists(target)) ? await fs.readFile(target) : "";
  const lines = existing.split(/\r?\n/);
  const alreadyPresent = lines.some((l) => l.trim() === line.trim());
  if (alreadyPresent) return false;
  const suffix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  const appended = `${existing}${suffix}# OpenCodeHub local state\n${line}\n`;
  await fs.writeFileAtomic(target, appended);
  log(`codehub init: appended "${line}" to .gitignore`);
  return true;
}

const POLICY_STARTER = `# OpenCodeHub policy (v1 — starter, all rules commented out)
#
# Consumed by 'codehub verdict' (ships in spec 002 P1). Uncomment the
# rule types you want to enforce. Schema:
#   packages/policy/schemas/policy-v1.json (once spec 002 lands)
#
# See ADR 0007 for scope rationale. Self-hosted OSS only — no calls
# to any OpenCodeHub-operated service from this file or from the CI
# actions that consume it.
#
# version: 1
#
# auto_approve:
#   require:
#     - blast_radius.tier: ">= 3"       # only tier-3-or-safer PRs auto-approve
#     - findings.severity_error: 0
#     - license_audit.violations: 0
#
# rules:
#   - id: no-disallowed-licenses
#     type: license_allowlist
#     deny: ["GPL-3.0", "AGPL-3.0"]
#
#   - id: require-storage-owner
#     type: ownership_required
#     paths: ["packages/storage/**"]
#     require_approval_from: ["@storage-team"]
#
#   - id: blast-radius-cap
#     type: blast_radius_max
#     max_tier: 2
`;

async function seedPolicyFile(
  fs: FsApi,
  repoRoot: string,
  log: (m: string) => void,
): Promise<boolean> {
  const target = join(repoRoot, "opencodehub.policy.yaml");
  if (await fs.exists(target)) return false;
  await fs.writeFileAtomic(target, POLICY_STARTER);
  log(`codehub init: seeded opencodehub.policy.yaml (all rules commented out)`);
  return true;
}

/**
 * Resolve the bundled plugin source dir.
 *
 * When running from source inside the monorepo (e.g. `pnpm -F cli dev`),
 * walk up to the repo root and read `plugins/opencodehub/`. When running
 * from the published `dist/`, use the `dist/plugin-assets/` tree produced
 * by `scripts/copy-plugin-assets.mjs`.
 */
function defaultPluginSourceDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  let dir = dirname(thisFile);

  // First check: bundled dist assets (standard install case).
  const bundled = join(dir, "..", "plugin-assets");
  try {
    const st = statSyncSafe(bundled);
    if (st?.isDirectory()) return resolve(bundled);
  } catch {
    // keep looking
  }

  // Fallback: walk up looking for `plugins/opencodehub/` (monorepo-source case).
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, "plugins", "opencodehub");
    try {
      const st = statSyncSafe(candidate);
      if (st?.isDirectory()) return candidate;
    } catch {
      // keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(dirname(thisFile), "..", "..", "..", "..", "plugins", "opencodehub");
}

function statSyncSafe(path: string): { isDirectory(): boolean } | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}
