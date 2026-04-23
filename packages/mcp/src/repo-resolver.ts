/**
 * Resolve a user-supplied (or omitted) `repo` argument to a concrete repo
 * path, DuckDB file path, and (optionally) cached store metadata.
 *
 * The authoritative mapping lives at `~/.codehub/registry.json`. Callers
 * who pass a name look it up there. When `repo` is omitted:
 *   - Exactly one registered repo: return it (friendly single-repo case).
 *   - Zero registered repos: throw `NO_INDEX`.
 *   - Two or more registered repos: throw `AMBIGUOUS_REPO` so the caller
 *     picks explicitly. Silent alphabetical-first picks are a footgun
 *     across a stdio MCP session where the server has no reliable cwd.
 */
// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  readStoreMeta,
  resolveDbPath,
  resolveRegistryPath,
  type StoreMeta,
} from "@opencodehub/storage";

export interface RegistryEntry {
  readonly name: string;
  readonly path: string;
  readonly lastCommit?: string;
  readonly indexedAt: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
}

export interface ResolvedRepo {
  readonly name: string;
  readonly repoPath: string;
  readonly dbPath: string;
  readonly entry: RegistryEntry;
  readonly meta?: StoreMeta;
}

export type RepoResolveCode = "NO_INDEX" | "NOT_FOUND" | "AMBIGUOUS_REPO";

export class RepoResolveError extends Error {
  readonly code: RepoResolveCode;
  readonly hint: string;
  constructor(code: RepoResolveCode, message: string, hint: string) {
    super(message);
    this.name = "RepoResolveError";
    this.code = code;
    this.hint = hint;
  }
}

export interface ResolveRepoOptions {
  /** Override the home directory (used by tests). */
  readonly home?: string;
  /** Skip the meta.json read (saves a syscall when caller does not need it). */
  readonly skipMeta?: boolean;
}

export async function readRegistry(
  opts: ResolveRepoOptions = {},
): Promise<Record<string, RegistryEntry>> {
  const path = opts.home ? resolveRegistryPath(opts.home) : resolveRegistryPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  const parsed = JSON.parse(raw) as unknown;
  return normalizeRegistry(parsed);
}

export async function resolveRepo(
  repoName: string | undefined,
  opts: ResolveRepoOptions = {},
): Promise<ResolvedRepo> {
  const registry = await readRegistry(opts);
  const names = Object.keys(registry).sort();
  if (names.length === 0) {
    throw new RepoResolveError(
      "NO_INDEX",
      "No repos are indexed yet.",
      "Run `codehub analyze` in a repo root to create an index.",
    );
  }

  let entry: RegistryEntry | undefined;
  let resolvedName: string | undefined;
  if (repoName === undefined) {
    if (names.length > 1) {
      const preview = names.slice(0, 5).join(", ");
      const elided = names.length > 5 ? `, +${names.length - 5} more` : "";
      throw new RepoResolveError(
        "AMBIGUOUS_REPO",
        `No \`repo\` argument provided but ${names.length} repos are registered.`,
        `Pass \`repo\` to disambiguate. Registered repos: ${preview}${elided}.`,
      );
    }
    resolvedName = names[0];
    entry = resolvedName ? registry[resolvedName] : undefined;
  } else {
    entry = registry[repoName];
    resolvedName = repoName;
  }

  if (!entry || !resolvedName) {
    throw new RepoResolveError(
      "NOT_FOUND",
      `Repo ${repoName ?? "<default>"} is not in the registry.`,
      `Known repos: ${names.join(", ")}. Run \`codehub analyze\` in the target repo first.`,
    );
  }

  const repoPath = resolve(entry.path);
  const dbPath = resolveDbPath(repoPath);

  let meta: StoreMeta | undefined;
  if (!opts.skipMeta) {
    try {
      meta = await readStoreMeta(repoPath);
    } catch {
      meta = undefined;
    }
  }

  return meta
    ? { name: resolvedName, repoPath, dbPath, entry, meta }
    : { name: resolvedName, repoPath, dbPath, entry };
}

function normalizeRegistry(value: unknown): Record<string, RegistryEntry> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, RegistryEntry> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (typeof r["name"] !== "string" || typeof r["path"] !== "string") continue;
    if (typeof r["indexedAt"] !== "string") continue;
    if (typeof r["nodeCount"] !== "number" || typeof r["edgeCount"] !== "number") continue;
    const entry: RegistryEntry = {
      name: r["name"],
      path: r["path"],
      indexedAt: r["indexedAt"],
      nodeCount: r["nodeCount"],
      edgeCount: r["edgeCount"],
      ...(typeof r["lastCommit"] === "string" ? { lastCommit: r["lastCommit"] } : {}),
    };
    out[key] = entry;
  }
  return out;
}
