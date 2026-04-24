/**
 * Scan phase — walks the repository, emits one record per kept file.
 *
 * Responsibilities:
 *  - Honor hardcoded directory ignores (`node_modules`, `.git`, etc.) and
 *    the repository-root `.gitignore` file.
 *  - Skip binary files (first 8 KB contains NUL → heuristic binary).
 *  - Skip files exceeding `options.byteCapPerFile` (default 10 MB).
 *  - Cap total file count at `options.maxTotalFiles` (default 100k).
 *  - Compute `sha256` for each kept file (enables future incremental skip).
 *  - Optionally capture `git rev-parse HEAD` when not in `skipGit` mode.
 *
 * This phase reads but does not write the graph. Later phases build nodes
 * and edges from the scan output.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256Hex } from "@opencodehub/core-types";
import { getGrammarSha } from "../../parse/grammar-registry.js";
import { detectLanguage } from "../../parse/language-detector.js";
import type { LanguageId } from "../../parse/types.js";
import {
  HARDCODED_IGNORES,
  type IgnoreRule,
  loadGitignoreChain,
  shouldIgnore,
} from "../gitignore.js";
import type { PipelineContext, PipelinePhase } from "../types.js";

const DEFAULT_BYTE_CAP_PER_FILE = 10 * 1024 * 1024; // 10 MB
const DEFAULT_MAX_TOTAL_FILES = 100_000;
const BINARY_PROBE_BYTES = 8 * 1024; // 8 KB — same probe git itself uses.

/** One row of the scan phase output. */
export interface ScannedFile {
  readonly absPath: string;
  /** POSIX-separated path relative to repo root. */
  readonly relPath: string;
  readonly byteSize: number;
  /** Lowercase hex sha256 of file contents. */
  readonly sha256: string;
  /** Detected language, if any; consumers may skip unknown files. */
  readonly language?: LanguageId;
  /**
   * Content-addressed grammar fingerprint for the detected language — the
   * second half of theparse-cache composite key. `null` when the
   * language is unknown, its grammar package is not installed, or its
   * `package.json` could not be read. The field participates in no sort
   * (it is a pure function of `language`), so it does not affect scan
   * determinism beyond what the existing `relPath` sort already gives.
   */
  readonly grammarSha: string | null;
}

export interface ScanOutput {
  readonly files: readonly ScannedFile[];
  /** `undefined` when `skipGit` is set or the repo is not a git checkout. */
  readonly gitHead?: string;
  readonly totalBytes: number;
  /**
   * Paths (relative to `repoPath`, POSIX-separated, no trailing slash) of every
   * git submodule registered in this repo. Populated via `git ls-tree -r -z
   * HEAD` filtered for tree-entry mode `160000` (the Linguist canonical
   * pattern). Falls back to textual parsing of `.gitmodules` when `skipGit`
   * is set. Empty when the repo has no submodules or is not a git checkout.
   */
  readonly submodulePaths: readonly string[];
}

export const SCAN_PHASE_NAME = "scan";

export const scanPhase: PipelinePhase<ScanOutput> = {
  name: SCAN_PHASE_NAME,
  deps: [],
  async run(ctx) {
    return runScan(ctx);
  },
};

async function runScan(ctx: PipelineContext): Promise<ScanOutput> {
  const byteCapPerFile = ctx.options.byteCapPerFile ?? DEFAULT_BYTE_CAP_PER_FILE;
  const maxTotalFiles = ctx.options.maxTotalFiles ?? DEFAULT_MAX_TOTAL_FILES;

  // Layered gitignore chain — nested `.gitignore` files stack from repo
  // root downward; deeper layers override shallower ones (DET-E-004).
  const chain = await loadGitignoreChain(ctx.repoPath);

  const hardcoded = new Set<string>(HARDCODED_IGNORES);
  const collected: ScannedFile[] = [];
  let totalBytes = 0;
  let capHit = false;

  await walk(ctx.repoPath, "", {
    chain,
    hardcoded,
    byteCapPerFile,
    maxTotalFiles,
    collected,
    onTotalBytes: (b) => {
      totalBytes += b;
    },
    onCapHit: () => {
      capHit = true;
    },
    onWarn: (msg) => {
      ctx.onProgress?.({ phase: SCAN_PHASE_NAME, kind: "warn", message: msg });
    },
  });

  if (capHit && ctx.onProgress) {
    ctx.onProgress({
      phase: SCAN_PHASE_NAME,
      kind: "warn",
      message: `scan: reached maxTotalFiles=${maxTotalFiles}; remaining files were skipped`,
    });
  }

  // Deterministic output: sort by relPath ascending.
  collected.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  let gitHead: string | undefined;
  let submodulePaths: readonly string[] = [];
  if (ctx.options.skipGit !== true) {
    gitHead = await tryGitHead(ctx.repoPath);
    submodulePaths = await listGitSubmodules(ctx.repoPath);
  } else {
    submodulePaths = await parseGitmodulesSubmodules(ctx.repoPath);
  }

  return {
    files: collected,
    ...(gitHead !== undefined ? { gitHead } : {}),
    totalBytes,
    submodulePaths,
  };
}

interface WalkParams {
  readonly chain: ReadonlyMap<string, readonly IgnoreRule[]>;
  readonly hardcoded: ReadonlySet<string>;
  readonly byteCapPerFile: number;
  readonly maxTotalFiles: number;
  readonly collected: ScannedFile[];
  readonly onTotalBytes: (bytes: number) => void;
  readonly onCapHit: () => void;
  readonly onWarn: (msg: string) => void;
}

async function walk(repoRoot: string, relDir: string, p: WalkParams): Promise<void> {
  if (p.collected.length >= p.maxTotalFiles) {
    p.onCapHit();
    return;
  }
  const absDir = path.join(repoRoot, relDir);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch (err) {
    p.onWarn(`scan: cannot read directory ${absDir}: ${(err as Error).message}`);
    return;
  }

  // Sort by name so walk order is deterministic.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    if (p.collected.length >= p.maxTotalFiles) {
      p.onCapHit();
      return;
    }
    const name = entry.name;
    if (p.hardcoded.has(name)) continue;

    const relPath = relDir === "" ? name : `${relDir}/${name}`;
    const isDir = entry.isDirectory();
    const ignored = shouldIgnore(relPath, p.chain, { isDirectory: isDir });
    if (ignored) continue;

    if (isDir) {
      await walk(repoRoot, relPath, p);
      continue;
    }

    // Skip symlinks and non-regular files — they are rare in source repos
    // and their semantics are ambiguous for a content-addressed hash.
    if (!entry.isFile()) continue;

    const absPath = path.join(absDir, name);
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.stat(absPath);
    } catch (err) {
      p.onWarn(`scan: cannot stat ${absPath}: ${(err as Error).message}`);
      continue;
    }

    if (stat.size > p.byteCapPerFile) {
      p.onWarn(`scan: skipping ${relPath} (${stat.size} bytes > cap ${p.byteCapPerFile})`);
      continue;
    }

    let buf: Buffer;
    try {
      buf = await fs.readFile(absPath);
    } catch (err) {
      p.onWarn(`scan: cannot read ${absPath}: ${(err as Error).message}`);
      continue;
    }

    if (looksBinary(buf)) continue;

    const sha256 = sha256Of(buf);
    const language = detectLanguage(relPath, firstLine(buf));

    // Resolve the content-addressed grammar fingerprint now so downstream
    // phases (parse, content-cache) do not need to re-touch the grammar
    // registry per file. `getGrammarSha` is memoized per-process, so the
    // per-file cost is a single Map lookup after the first resolution per
    // language. Null when the language is unknown or the grammar package
    // is not installed — cache lookups simply miss in that case.
    const grammarSha = language !== undefined ? await getGrammarSha(language) : null;

    p.collected.push({
      absPath,
      relPath,
      byteSize: buf.byteLength,
      sha256,
      ...(language !== undefined ? { language } : {}),
      grammarSha,
    });
    p.onTotalBytes(buf.byteLength);
  }
}

function looksBinary(buf: Buffer): boolean {
  const probeLen = Math.min(buf.byteLength, BINARY_PROBE_BYTES);
  for (let i = 0; i < probeLen; i += 1) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function sha256Of(buf: Buffer): string {
  // Normalize to a Uint8Array — the `@types/node` Buffer shape shipped
  // with older @types/node declarations is not assignable to the crypto
  // `BinaryLike` constraint on newer Node runtimes.
  return sha256Hex(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
}

function firstLine(buf: Buffer): string | undefined {
  const probeLen = Math.min(buf.byteLength, 256);
  const slice = buf.subarray(0, probeLen).toString("utf8");
  const nl = slice.indexOf("\n");
  if (nl === -1) {
    if (probeLen < buf.byteLength) return undefined;
    return slice;
  }
  return slice.slice(0, nl);
}

/**
 * Enumerate submodule paths by asking git for the tree at HEAD and filtering
 * for gitlink entries (mode `160000`). This is the canonical pattern GitHub
 * Linguist uses — it works on bare repos, detached worktrees, and
 * partially-initialised submodules alike (does not depend on `.git/config`
 * being populated via `git submodule init`).
 *
 * Output paths are POSIX-separated relative paths, no trailing slash.
 * Returns an empty array when `git` is unavailable, the repo is not a git
 * checkout, or there are no submodules.
 */
async function listGitSubmodules(repoPath: string): Promise<readonly string[]> {
  return new Promise((resolveProm) => {
    let stdout = "";
    let settled = false;
    const child = spawn("git", ["ls-tree", "-r", "-z", "HEAD"], {
      cwd: repoPath,
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => {
      if (!settled) {
        settled = true;
        resolveProm([]);
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        resolveProm([]);
        return;
      }
      resolveProm(parseLsTreeSubmodules(stdout));
    });
  });
}

/**
 * Parse the NUL-delimited output of `git ls-tree -r -z HEAD`. Each record is
 * `<mode> SP <type> SP <sha> TAB <path>`. We keep records whose mode is
 * exactly `160000` (gitlink) — that is the submodule marker in git's tree
 * format. All other entries (blobs, trees, symlinks) are dropped.
 */
function parseLsTreeSubmodules(raw: string): readonly string[] {
  const out: string[] = [];
  for (const record of raw.split("\0")) {
    if (record.length === 0) continue;
    const tabIdx = record.indexOf("\t");
    if (tabIdx < 0) continue;
    const header = record.slice(0, tabIdx);
    const path = record.slice(tabIdx + 1);
    // header: "<mode> <type> <sha>"
    const firstSpace = header.indexOf(" ");
    if (firstSpace < 0) continue;
    const mode = header.slice(0, firstSpace);
    if (mode !== "160000") continue;
    out.push(normalizeSubmodulePath(path));
  }
  return out;
}

/**
 * Textual `.gitmodules` fallback, used when `skipGit` is true and we cannot
 * spawn `git`. The format is an INI-like file with stanzas like:
 *
 *     [submodule "fixtures/python/sample"]
 *         path = fixtures/python/sample
 *         url = https://github.com/...
 *
 * We tolerate leading whitespace and trailing CR bytes; unrecognised lines
 * are ignored. Missing file → empty list.
 */
async function parseGitmodulesSubmodules(repoPath: string): Promise<readonly string[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(repoPath, ".gitmodules"), "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("path")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (key !== "path") continue;
    const value = trimmed.slice(eqIdx + 1).trim();
    if (value.length === 0) continue;
    out.push(normalizeSubmodulePath(value));
  }
  return out;
}

function normalizeSubmodulePath(p: string): string {
  // Normalise to POSIX separators and strip any trailing slash; never emit a
  // leading "./" prefix. `git ls-tree` already emits POSIX-separated paths,
  // but `.gitmodules` can contain arbitrary text — be defensive.
  let out = p.replace(/\\/g, "/");
  while (out.endsWith("/")) out = out.slice(0, -1);
  if (out.startsWith("./")) out = out.slice(2);
  return out;
}

async function tryGitHead(repoPath: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const child = spawn("git", ["rev-parse", "HEAD"], {
      cwd: repoPath,
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => {
      if (!settled) {
        settled = true;
        resolve(undefined);
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        const trimmed = stdout.trim();
        resolve(trimmed.length > 0 ? trimmed : undefined);
      } else {
        resolve(undefined);
      }
    });
  });
}
