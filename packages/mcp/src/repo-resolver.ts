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

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  readStoreMeta,
  resolveDbPath,
  resolveRegistryPath,
  type StoreMeta,
} from "@opencodehub/storage";
import type { RepoChoice } from "./error-envelope.js";

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

/**
 * Auxiliary payload attached to `RepoResolveError` instances whose
 * `code === "AMBIGUOUS_REPO"`. `choices` is the full list (not capped);
 * the envelope builder at `error-envelope.ts` applies the 10-entry cap.
 */
export interface AmbiguousRepoInfo {
  readonly choices: readonly RepoChoice[];
  readonly totalMatches: number;
}

export class RepoResolveError extends Error {
  readonly code: RepoResolveCode;
  readonly hint: string;
  /** Populated only when `code === "AMBIGUOUS_REPO"`. */
  readonly ambiguous?: AmbiguousRepoInfo;
  constructor(code: RepoResolveCode, message: string, hint: string, ambiguous?: AmbiguousRepoInfo) {
    super(message);
    this.name = "RepoResolveError";
    this.code = code;
    this.hint = hint;
    if (ambiguous !== undefined) this.ambiguous = ambiguous;
  }
}

/**
 * Inputs accepted by {@link resolveRepo}. Back-compat: a bare `string`
 * (the registry name) or `undefined` (trigger single-repo fallback) still
 * works. The object form allows callers to pass `repo_uri` as an alias —
 * when both are provided, `repo_uri` wins.
 *
 * Fields permit explicit `undefined` so tool-handler arg types (which
 * declare `?: T | undefined` under `exactOptionalPropertyTypes`) are
 * structurally assignable without wrapping.
 */
export type ResolveRepoArg =
  | string
  | undefined
  | { readonly repo?: string | undefined; readonly repo_uri?: string | undefined };

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
  arg: ResolveRepoArg,
  opts: ResolveRepoOptions = {},
): Promise<ResolvedRepo> {
  const { repo: repoName, repoUri } = normalizeResolveArg(arg);
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

  // `repo_uri` wins when both are provided (per AC-M6-2 §5).
  if (repoUri !== undefined) {
    const wanted = normalizeRepoUri(repoUri);
    for (const key of names) {
      const candidate = registry[key];
      if (!candidate) continue;
      if (normalizeRepoUri(deriveRepoUri(candidate)) === wanted) {
        entry = candidate;
        resolvedName = key;
        break;
      }
    }
  } else if (repoName !== undefined) {
    entry = registry[repoName];
    resolvedName = repoName;
  } else {
    // Neither arg provided — single-repo defaulting, otherwise AMBIGUOUS.
    if (names.length > 1) {
      throw buildAmbiguousError(registry, names);
    }
    resolvedName = names[0];
    entry = resolvedName ? registry[resolvedName] : undefined;
  }

  if (!entry || !resolvedName) {
    const requested = repoUri ?? repoName ?? "<default>";
    throw new RepoResolveError(
      "NOT_FOUND",
      `Repo ${requested} is not in the registry.`,
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

/**
 * Normalize a `ResolveRepoArg` to its object form so the resolver can key
 * on both `repo` and `repo_uri` uniformly. Bare strings are treated as
 * `{ repo: s }` for back-compat with pre-M6 callers.
 */
function normalizeResolveArg(arg: ResolveRepoArg): {
  readonly repo: string | undefined;
  readonly repoUri: string | undefined;
} {
  if (arg === undefined) return { repo: undefined, repoUri: undefined };
  if (typeof arg === "string") return { repo: arg, repoUri: undefined };
  return { repo: arg.repo, repoUri: arg.repo_uri };
}

/**
 * Build the structured AMBIGUOUS_REPO error with a `choices[]` payload
 * derived from registry entries.
 *
 * TODO(M7 / AC-M6-1): once `RepoNode` lands in core-types and the registry
 * is reshaped to expose `default_branch` + `group`, switch this to pull
 * those fields from the node instead of defaulting to `null`. For now
 * they're placeholders so the wire shape is stable.
 */
function buildAmbiguousError(
  registry: Record<string, RegistryEntry>,
  names: readonly string[],
): RepoResolveError {
  const choices: RepoChoice[] = [];
  for (const key of names) {
    const entry = registry[key];
    if (!entry) continue;
    choices.push({
      repo_uri: deriveRepoUri(entry),
      default_branch: null,
      group: null,
    });
  }
  const preview = names.slice(0, 5).join(", ");
  const elided = names.length > 5 ? `, +${names.length - 5} more` : "";
  const hint = `Pass \`repo_uri\` (or \`repo\`) to disambiguate. Registered repos: ${preview}${elided}.`;
  return new RepoResolveError(
    "AMBIGUOUS_REPO",
    `No \`repo\` argument provided but ${names.length} repos are registered.`,
    hint,
    { choices, totalMatches: names.length },
  );
}

/**
 * Derive a stable `repo_uri` from a registry entry.
 *
 *   - If `name` already looks URI-ish (contains `/`), use it as-is (e.g.
 *     `github.com/org/repo`). This matches Sourcegraph / GitHub convention.
 *   - Else, fall back to `local:<sha256(path)[:12]>` so two local repos
 *     with colliding short names still have distinct URIs.
 *
 * M7 will replace this with the registry-backed RepoNode.repo_uri once
 * AC-M6-1 lands. Kept deterministic so tests can assert exact values.
 */
export function deriveRepoUri(entry: RegistryEntry): string {
  if (entry.name.includes("/")) return entry.name;
  const digest = createHash("sha256").update(entry.path).digest("hex").slice(0, 12);
  return `local:${digest}`;
}

/**
 * Normalize a caller-supplied `repo_uri` so it matches what
 * {@link deriveRepoUri} produces. Strips protocol and trailing `.git`,
 * lowercases the host segment but keeps path case.
 */
export function normalizeRepoUri(raw: string): string {
  let s = raw.trim();
  // `git@host:org/repo.git` → `host/org/repo`
  const scpMatch = /^git@([^:]+):(.+)$/.exec(s);
  if (scpMatch) {
    const host = (scpMatch[1] ?? "").toLowerCase();
    s = `${host}/${scpMatch[2] ?? ""}`;
  } else if (/^https?:\/\//i.test(s)) {
    // `https://host/path` → `host/path` (lowercase host, keep path case)
    s = s.replace(/^https?:\/\//i, "");
    const slash = s.indexOf("/");
    if (slash !== -1) {
      const host = s.slice(0, slash).toLowerCase();
      s = `${host}${s.slice(slash)}`;
    } else {
      s = s.toLowerCase();
    }
  }
  if (s.endsWith(".git")) s = s.slice(0, -".git".length);
  return s;
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
