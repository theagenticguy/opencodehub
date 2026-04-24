/**
 * `runGroupSync` — walk a list of repos, run every extractor, and
 * produce a ContractRegistry. The registry is also serialized to JSON
 * under `<home>/.codehub/groups/<name>/contracts.json` by the CLI / MCP
 * wrappers.
 *
 * The walker ignores `node_modules`, `.git`, `dist`, `build`, `.venv`,
 * and OCH's own `.codehub/` cache to keep the hot path small on large
 * monorepos. File extensions alone decide which extractor to run.
 *
 * Determinism:
 *   - Repos are processed in the order supplied by the caller. Tests and
 *     the CLI sort them alphabetically before handing over.
 *   - Per-repo file lists are sorted before scanning so duplicate
 *     signatures resolve to the same canonical line number.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { buildRegistry } from "./contracts.js";
import { extractGrpcClientContracts, extractGrpcProtoContracts } from "./grpc-patterns.js";
import { extractHttpContracts } from "./http-patterns.js";
import {
  buildManifestLinks,
  type RepoManifestSummary,
  readRepoManifest,
} from "./manifest-links.js";
import { extractTopicContracts } from "./topic-patterns.js";
import type { Contract, ContractRegistry } from "./types.js";

const IGNORE_DIRS = new Set<string>([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".venv",
  "venv",
  "__pycache__",
  ".codehub",
  ".next",
  "target",
  "out",
]);

const JS_EXTS = new Set([".js", ".jsx", ".mjs", ".cjs"]);
const TS_EXTS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const PY_EXTS = new Set([".py"]);
const PROTO_EXTS = new Set([".proto"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MiB per file

export interface SyncRepoInput {
  readonly name: string;
  readonly path: string;
}

export interface RunGroupSyncOptions {
  readonly repos: readonly SyncRepoInput[];
  /** Override for deterministic timestamps in tests. */
  readonly now?: () => string;
}

async function walkFiles(repoRoot: string): Promise<readonly string[]> {
  const out: string[] = [];
  async function visit(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    entries.sort();
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry)) continue;
      const abs = join(dir, entry);
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(abs);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        await visit(abs);
      } else if (info.isFile()) {
        if (info.size > MAX_FILE_BYTES) continue;
        out.push(abs);
      }
    }
  }
  await visit(repoRoot);
  return out;
}

function languageFor(filename: string): "js" | "ts" | "py" | "proto" | null {
  const ext = extname(filename).toLowerCase();
  if (TS_EXTS.has(ext)) return "ts";
  if (JS_EXTS.has(ext)) return "js";
  if (PY_EXTS.has(ext)) return "py";
  if (PROTO_EXTS.has(ext)) return "proto";
  return null;
}

async function extractContractsForFile(
  repo: string,
  repoRoot: string,
  absFile: string,
): Promise<readonly Contract[]> {
  const lang = languageFor(absFile);
  if (lang === null) return [];
  let source: string;
  try {
    source = await readFile(absFile, "utf8");
  } catch {
    return [];
  }
  const file = relative(repoRoot, absFile);
  const out: Contract[] = [];
  if (lang === "proto") {
    out.push(...extractGrpcProtoContracts({ repo, file, source }));
    return out;
  }
  out.push(...extractHttpContracts({ repo, file, source, language: lang }));
  out.push(...extractGrpcClientContracts({ repo, file, source, language: lang }));
  out.push(...extractTopicContracts({ repo, file, source, language: lang }));
  return out;
}

/**
 * Walk every repo, run extractors on each in-language file, and fuse the
 * results into a ContractRegistry. Manifest-derived hints are added to
 * the cross-link resolver's second pass.
 */
export async function runGroupSync(opts: RunGroupSyncOptions): Promise<ContractRegistry> {
  const contracts: Contract[] = [];
  const manifestSummaries: RepoManifestSummary[] = [];
  const repoNames: string[] = [];

  for (const repo of opts.repos) {
    repoNames.push(repo.name);
    const summary = await readRepoManifest(repo.name, repo.path);
    manifestSummaries.push(summary);
    const files = await walkFiles(repo.path);
    for (const abs of files) {
      const perFile = await extractContractsForFile(repo.name, repo.path, abs);
      contracts.push(...perFile);
    }
  }

  const manifestLinks = buildManifestLinks(manifestSummaries);
  return buildRegistry({
    repos: repoNames,
    contracts,
    manifestLinks,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
}
