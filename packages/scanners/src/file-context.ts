/**
 * Shared file-discovery for the scanner wrapper context.
 *
 * Spectral (OpenAPI lint) and hadolint (Dockerfile lint) do not recurse a
 * directory themselves — each needs an explicit file list, or it lints
 * nothing. Both the CLI (`codehub scan`) and the MCP `scan` tool must supply
 * that list; centralizing the walk here keeps the two surfaces from drifting
 * (the MCP tool previously omitted it, so Spectral silently scanned nothing).
 *
 * Pure `node:fs` breadth-first walks, bounded by a file cap so a huge repo
 * never explodes. No package dependencies beyond the spec ids.
 */

import { HADOLINT_SPEC, SPECTRAL_SPEC } from "./catalog.js";
import type { ScannerSpec } from "./spec.js";

/** Directory names skipped by every discovery walk. */
const SKIP_DIRS = new Set(["node_modules", ".git"]);

/** Matches Dockerfile, Dockerfile.prod, etc. */
const DOCKERFILE_RE = /^Dockerfile(\..+)?$/;

/** Matches openapi/swagger/asyncapi/arazzo .yaml|.yml|.json (case-insensitive). */
const CONTRACT_RE = /^(openapi|swagger|asyncapi|arazzo)\.(ya?ml|json)$/i;

interface WalkOpts {
  readonly match: RegExp;
  readonly maxFiles: number;
}

/**
 * Breadth-first walk returning repo-relative POSIX paths of files whose
 * basename matches `opts.match`, capped at `opts.maxFiles`. Unreadable
 * directories are skipped, not fatal.
 */
async function walkForFiles(repoPath: string, opts: WalkOpts): Promise<readonly string[]> {
  const { readdir } = await import("node:fs/promises");
  const { join, relative } = await import("node:path");
  type DirEntry = import("node:fs").Dirent;
  const out: string[] = [];
  const queue: string[] = [repoPath];
  while (queue.length > 0 && out.length < opts.maxFiles) {
    const dir = queue.shift();
    if (dir === undefined) break;
    let entries: DirEntry[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".codehub")) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        queue.push(abs);
      } else if (e.isFile() && opts.match.test(e.name)) {
        out.push(relative(repoPath, abs));
      }
    }
  }
  return out;
}

/** Locate OpenAPI / Swagger / AsyncAPI / Arazzo contract files (paths only). */
export function findOpenApiFiles(repoPath: string): Promise<readonly string[]> {
  return walkForFiles(repoPath, { match: CONTRACT_RE, maxFiles: 64 });
}

/** Locate Dockerfile* files for hadolint. */
export function findDockerfiles(repoPath: string): Promise<readonly string[]> {
  return walkForFiles(repoPath, { match: DOCKERFILE_RE, maxFiles: 256 });
}

/**
 * File-discovery-derived slice of the wrapper context: the spectral contract
 * list and the hadolint Dockerfile list, populated only for specs actually
 * selected (so an OpenAPI-less repo pays no walk). Both CLI and MCP build on
 * this; callers layer surface-specific fields (checkov frameworks, python
 * ignore dirs) on top.
 */
export async function buildScannerFileContext(
  repoPath: string,
  specs: readonly ScannerSpec[],
): Promise<{
  spectral?: { contractFiles: readonly string[] };
  hadolint?: { dockerfiles: readonly string[] };
}> {
  const ids = new Set(specs.map((s) => s.id));
  const ctx: {
    spectral?: { contractFiles: readonly string[] };
    hadolint?: { dockerfiles: readonly string[] };
  } = {};
  if (ids.has(SPECTRAL_SPEC.id)) {
    ctx.spectral = { contractFiles: await findOpenApiFiles(repoPath) };
  }
  if (ids.has(HADOLINT_SPEC.id)) {
    ctx.hadolint = { dockerfiles: await findDockerfiles(repoPath) };
  }
  // checkov's `frameworks` come from the ProjectProfile, not a filesystem
  // walk, so each surface supplies that field from its own profile read.
  return ctx;
}
