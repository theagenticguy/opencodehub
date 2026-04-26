/**
 * `codehub setup` — detects installed editors and writes an MCP server entry
 * for `codehub` into each one's config file.
 *
 * We deliberately do *not* probe each editor to confirm it is "installed" —
 * writing to a config path is idempotent and safe, and a user can run setup
 * before installing an editor. Instead we:
 *   1. Determine the invocation (`codehub mcp`) with optional Windows wrap.
 *   2. For each selected editor, read the existing config, back it up, and
 *      atomically write the merged version that adds or replaces the
 *      `codehub` entry.
 *
 * Filesystem access goes through the `FsApi` seam so tests can run against an
 * in-memory implementation.
 */

import { statSync } from "node:fs";
import {
  copyFile as fsCopyFile,
  mkdir as fsMkdir,
  readdir as fsReaddir,
  readFile as fsReadFile,
  rename as fsRename,
  rm as fsRm,
  stat as fsStat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALL_EDITOR_IDS,
  createClaudeCodeWriter,
  createCodexWriter,
  createCursorWriter,
  createOpenCodeWriter,
  createWindsurfWriter,
  type EditorId,
  type EditorWriter,
  type McpInvocation,
  maybeWrapForWindows,
} from "../editors/index.js";
import {
  type DownloadEmbedderOptions,
  type DownloadEmbedderResult,
  downloadEmbedderWeights,
} from "../embedder-downloader.js";
import { writeFileAtomic as defaultWriteFileAtomic } from "../fs-atomic.js";

/**
 * Filesystem seam. Tests supply an in-memory implementation.
 * Every operation is async to keep the seam uniform.
 */
export interface FsApi {
  readFile(path: string): Promise<string>;
  writeFileAtomic(path: string, contents: string): Promise<void>;
  copyFile(src: string, dest: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  readdir?(path: string): Promise<readonly string[]>;
  rename?(src: string, dest: string): Promise<void>;
  rm?(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
  statIsDirectory?(path: string): Promise<boolean>;
}

/** Default implementation that calls through to real `fs`. */
export const DEFAULT_FS: FsApi = {
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
      await fsStat(path);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  },
  async readdir(path) {
    return await fsReaddir(path);
  },
  async rename(src, dest) {
    await fsRename(src, dest);
  },
  async rm(path, opts) {
    await fsRm(path, { recursive: opts?.recursive ?? false, force: opts?.force ?? false });
  },
  async statIsDirectory(path) {
    const st = await fsStat(path);
    return st.isDirectory();
  },
};

export interface SetupOptions {
  /** Which editors to write. Defaults to all 5. */
  readonly editors?: readonly EditorId[];
  /** Overwrite an existing `codehub` entry without prompting. Always true for MVP. */
  readonly force?: boolean;
  /** Restore the `.bak` file onto the config, if present. */
  readonly undo?: boolean;
  /** Absolute path to the project. Used by per-project writers. */
  readonly projectRoot?: string;
  /** Override the user's home dir. Used by global writers. */
  readonly home?: string;
  /** Explicit MCP invocation override. Default: `codehub mcp`. */
  readonly invocation?: McpInvocation;
  /** FS seam. Defaults to real filesystem. */
  readonly fs?: FsApi;
  /** Override `process.platform`. Tests use this to force Windows paths. */
  readonly platform?: NodeJS.Platform;
  /** Structured logger. Defaults to `console.log`/`console.error`. */
  readonly log?: (message: string) => void;
  readonly warn?: (message: string) => void;
}

export interface SetupResult {
  readonly editor: EditorId;
  readonly configPath: string;
  readonly action: "wrote" | "restored" | "skipped" | "unchanged";
  readonly backupPath?: string;
}

/** Public entry point. Returns per-editor results for programmatic callers. */
export async function runSetup(opts: SetupOptions = {}): Promise<readonly SetupResult[]> {
  const editors = opts.editors ?? ALL_EDITOR_IDS;
  const fs = opts.fs ?? DEFAULT_FS;
  const log = opts.log ?? ((msg: string) => console.warn(msg));
  const warn = opts.warn ?? ((msg: string) => console.warn(msg));

  const invocation = maybeWrapForWindows(
    opts.invocation ?? defaultInvocation(),
    opts.platform !== undefined ? { platform: opts.platform } : {},
  );

  const writers = editors.map((id) => buildWriter(id, opts));
  const results: SetupResult[] = [];

  for (const writer of writers) {
    try {
      const result = opts.undo
        ? await undoSingle(writer, fs, log)
        : await writeSingle(writer, invocation, fs, log);
      results.push(result);
    } catch (err) {
      const message = (err as Error).message;
      warn(`codehub setup (${writer.id}): ${message}`);
      results.push({
        editor: writer.id,
        configPath: writer.configPath,
        action: "skipped",
      });
    }
  }
  return results;
}

function defaultInvocation(): McpInvocation {
  return { command: "codehub", args: ["mcp"], env: {} };
}

function buildWriter(id: EditorId, opts: SetupOptions): EditorWriter {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const homeOpt = opts.home !== undefined ? { home: opts.home } : {};
  switch (id) {
    case "claude-code":
      return createClaudeCodeWriter({ projectRoot });
    case "cursor":
      return createCursorWriter(homeOpt);
    case "codex":
      return createCodexWriter(homeOpt);
    case "windsurf":
      return createWindsurfWriter(homeOpt);
    case "opencode":
      return createOpenCodeWriter({ projectRoot });
  }
}

async function writeSingle(
  writer: EditorWriter,
  invocation: McpInvocation,
  fs: FsApi,
  log: (message: string) => void,
): Promise<SetupResult> {
  const target = writer.configPath;
  const parent = dirname(target);
  await fs.mkdir(parent);

  const existing = (await fs.exists(target)) ? await fs.readFile(target) : undefined;
  const merged = writer.merge(existing, invocation);

  // Record a backup on every overwrite. Fresh writes don't need a .bak.
  let backupPath: string | undefined;
  if (existing !== undefined) {
    backupPath = `${target}.bak`;
    await fs.copyFile(target, backupPath);
  }

  if (existing !== undefined && existing === merged) {
    log(`codehub setup (${writer.id}): already up to date at ${target}`);
    return {
      editor: writer.id,
      configPath: target,
      action: "unchanged",
      ...(backupPath !== undefined ? { backupPath } : {}),
    };
  }

  await fs.writeFileAtomic(target, merged);
  log(`codehub setup (${writer.id}): wrote MCP entry to ${target}`);
  return {
    editor: writer.id,
    configPath: target,
    action: "wrote",
    ...(backupPath !== undefined ? { backupPath } : {}),
  };
}

/**
 * Options for `codehub setup --embeddings`. Mirrors the downloader API but
 * allows the CLI `log`/`warn` sinks to be overridden for tests.
 */
export interface SetupEmbeddingsOptions {
  /** Variant to install. Defaults to `fp32` (~596 MB). */
  readonly variant?: "fp32" | "int8";
  /** Custom model directory. Defaults to `~/.codehub/models/gte-modernbert-base/<variant>/`. */
  readonly modelDir?: string;
  /** Re-download even if files already match their SHA256 pin. */
  readonly force?: boolean;
  /** Dependency-inject fetch for tests. */
  readonly fetchImpl?: DownloadEmbedderOptions["fetchImpl"];
  /** Progress sink. Defaults to no-op. */
  readonly onProgress?: DownloadEmbedderOptions["onProgress"];
  /** Structured logger. Defaults to `console.warn`. */
  readonly log?: (message: string) => void;
  readonly warn?: (message: string) => void;
}

/**
 * Public entry point for `codehub setup --embeddings`.
 *
 * Downloads the five pinned gte-modernbert-base files into the target dir with
 * streaming SHA256 verification and atomic rename. Returns the downloader
 * summary so programmatic callers can assert on byte counts and locations.
 */
export async function runSetupEmbeddings(
  opts: SetupEmbeddingsOptions = {},
): Promise<DownloadEmbedderResult> {
  const log = opts.log ?? ((msg: string) => console.warn(msg));
  const warn = opts.warn ?? ((msg: string) => console.warn(msg));
  const variant = opts.variant ?? "fp32";

  log(
    `codehub setup --embeddings: starting ${variant} download ` +
      `(${variant === "fp32" ? "~90 MB" : "~23 MB"})`,
  );

  const downloaderOpts: DownloadEmbedderOptions = {
    variant,
    ...(opts.modelDir !== undefined ? { modelDir: opts.modelDir } : {}),
    ...(opts.force !== undefined ? { force: opts.force } : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
  };

  try {
    const result = await downloadEmbedderWeights(downloaderOpts);
    const mb = (result.totalBytes / 1024 / 1024).toFixed(1);
    log(
      `codehub setup --embeddings: downloaded ${result.downloaded} file(s), ` +
        `skipped ${result.skipped} (${mb} MB new) → ${result.modelDir}`,
    );
    log("codehub setup --embeddings: Done. " + "Run `codehub analyze --embeddings` to use them.");
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn(`codehub setup --embeddings: ${message}`);
    throw err;
  }
}

/**
 * Options for `codehub setup --plugin`. Copies the static `plugins/opencodehub/`
 * tree shipped with this repo into `<home>/.claude/plugins/opencodehub/` so
 * Claude Code picks up the five slash commands, the `code-analyst` subagent,
 * and the PostToolUse auto-reindex hook.
 *
 * Atomic: files are copied into a sibling `<target>.tmp-<pid>` dir first, then
 * the final `<target>` is removed and the temp dir renamed into place. A
 * partial crash leaves the previous install intact.
 */
export interface SetupPluginOptions {
  /** Override the user's home dir. Defaults to `os.homedir()`. */
  readonly home?: string;
  /** Override the plugin source directory. Defaults to the in-repo `plugins/opencodehub/`. */
  readonly sourceDir?: string;
  /** FS seam. Defaults to real filesystem. */
  readonly fs?: FsApi;
  /** Structured logger. Defaults to `console.warn`. */
  readonly log?: (message: string) => void;
  readonly warn?: (message: string) => void;
}

export interface SetupPluginResult {
  readonly sourceDir: string;
  readonly targetDir: string;
  readonly filesCopied: number;
}

/**
 * Public entry point for `codehub setup --plugin`.
 *
 * Walks `sourceDir` and mirrors it into `<home>/.claude/plugins/opencodehub/`.
 * Both the temp dir and the final rename go through `FsApi` so tests can run
 * against an in-memory implementation.
 */
export async function runSetupPlugin(opts: SetupPluginOptions = {}): Promise<SetupPluginResult> {
  const fs = opts.fs ?? DEFAULT_FS;
  const log = opts.log ?? ((msg: string) => console.warn(msg));
  const warn = opts.warn ?? ((msg: string) => console.warn(msg));
  const home = opts.home ?? homedir();
  const sourceDir = opts.sourceDir ?? defaultPluginSourceDir();
  const targetRoot = resolve(home, ".claude", "plugins");
  const targetDir = resolve(targetRoot, "opencodehub");
  const tempDir = `${targetDir}.tmp-${process.pid}`;

  if (!(await fs.exists(sourceDir))) {
    const message = `codehub setup --plugin: source not found at ${sourceDir}`;
    warn(message);
    throw new Error(message);
  }

  await fs.mkdir(targetRoot);

  // Wipe any stale tmp dir from a prior crash before we start. Best-effort.
  if (fs.rm && (await fs.exists(tempDir))) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  const filesCopied = await copyTree(fs, sourceDir, tempDir);

  // Swap: remove old install, rename temp into place. This is "atomic
  // enough" — the window between rm and rename is narrow and leaves no
  // half-written plugin because the temp dir was fully built first.
  if (fs.rm && (await fs.exists(targetDir))) {
    await fs.rm(targetDir, { recursive: true, force: true });
  }
  if (fs.rename) {
    await fs.rename(tempDir, targetDir);
  } else {
    // Fallback for FsApi implementations without rename: walk the temp
    // tree and copy entries into the final target. Only used by in-memory
    // test doubles that don't implement rename.
    await copyTree(fs, tempDir, targetDir);
    if (fs.rm) await fs.rm(tempDir, { recursive: true, force: true });
  }

  log(`codehub setup --plugin: installed ${filesCopied} file(s) to ${targetDir}`);
  return { sourceDir, targetDir, filesCopied };
}

/**
 * Resolve the default plugin source dir.
 *
 * When running from source (`packages/cli/src/commands/setup.ts`) or from
 * `dist/commands/setup.js` inside a pnpm workspace, the repo root is three
 * directories above this file. We walk up from `import.meta.url` until we
 * find a `plugins/opencodehub` dir.
 */
function defaultPluginSourceDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  let dir = dirname(thisFile);
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, "plugins", "opencodehub");
    try {
      // Sync check is fine here — this runs once per setup invocation.
      const st = statSyncSafe(candidate);
      if (st?.isDirectory()) return candidate;
    } catch {
      // keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back to the conventional location relative to the compiled
  // `dist/commands/setup.js`. If this doesn't exist, the caller will get a
  // clean "source not found" error.
  return resolve(dirname(thisFile), "..", "..", "..", "..", "plugins", "opencodehub");
}

function statSyncSafe(path: string): { isDirectory(): boolean } | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

/** Recursively copy every regular file under `src` into `dest`. Returns count. */
async function copyTree(fs: FsApi, src: string, dest: string): Promise<number> {
  await fs.mkdir(dest);
  if (!fs.readdir) {
    throw new Error("FsApi.readdir is required for plugin installation");
  }
  const entries = await fs.readdir(src);
  let count = 0;
  for (const name of entries) {
    const from = join(src, name);
    const to = join(dest, name);
    const isDir = fs.statIsDirectory ? await fs.statIsDirectory(from) : false;
    if (isDir) {
      count += await copyTree(fs, from, to);
    } else {
      await fs.copyFile(from, to);
      count += 1;
    }
  }
  return count;
}

async function undoSingle(
  writer: EditorWriter,
  fs: FsApi,
  log: (message: string) => void,
): Promise<SetupResult> {
  const target = writer.configPath;
  const backupPath = `${target}.bak`;
  if (!(await fs.exists(backupPath))) {
    log(`codehub setup --undo (${writer.id}): no backup found at ${backupPath}`);
    return { editor: writer.id, configPath: target, action: "skipped" };
  }
  const backup = await fs.readFile(backupPath);
  await fs.writeFileAtomic(target, backup);
  log(`codehub setup --undo (${writer.id}): restored ${target} from ${backupPath}`);
  return { editor: writer.id, configPath: target, action: "restored", backupPath };
}
