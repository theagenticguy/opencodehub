/**
 * Cross-repo registry at `~/.codehub/registry.json`.
 *
 * The registry is a flat JSON map keyed by repo name. It is the authoritative
 * list of "what has codehub ever analyzed" for this user, and is used by
 *  - `codehub list` / `status` / `clean` to enumerate repos without scanning disk
 *  - `codehub query` and friends when called without an explicit path, to resolve
 *    the current working directory back to a registered repo
 *
 * The file is rewritten atomically on every change via `write-file-atomic`. We
 * keep the whole thing small (one record per repo) so serialization overhead is
 * irrelevant.
 *
 * An in-process LRU pool of open `IGraphStore` connections is expected to live
 * elsewhere (the MCP server manages its own via lru-cache). This module's
 * concern is strictly the on-disk registry.
 */

import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { writeFileAtomic } from "./fs-atomic.js";

/** Default name of the per-user codehub data directory. */
export const CODEHUB_HOME_DIR = ".codehub";
/** Default registry file name under `~/.codehub`. */
export const REGISTRY_FILE = "registry.json";

export interface RepoEntry {
  readonly name: string;
  readonly path: string;
  readonly lastCommit?: string;
  readonly indexedAt: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
}

export interface RegistryOptions {
  /**
   * Override the home directory used to resolve the registry path. Tests pass
   * a tmpdir here. Defaults to `os.homedir()`.
   */
  readonly home?: string;
}

/** Resolve the absolute path of the registry JSON file. */
export function resolveRegistryFile(opts: RegistryOptions = {}): string {
  const home = opts.home ?? homedir();
  return resolve(home, CODEHUB_HOME_DIR, REGISTRY_FILE);
}

/**
 * Read the registry. Returns an empty map if the file does not exist yet, and
 * throws on malformed JSON so corruption is surfaced early rather than silently
 * clobbered.
 */
export async function readRegistry(opts: RegistryOptions = {}): Promise<Record<string, RepoEntry>> {
  const file = resolveRegistryFile(opts);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  const parsed = JSON.parse(raw) as unknown;
  return validateRegistry(parsed, file);
}

/**
 * Upsert a single repo entry, keyed by `entry.name`. Preserves every other
 * entry. Creates the `~/.codehub/` directory if missing.
 */
export async function upsertRegistry(entry: RepoEntry, opts: RegistryOptions = {}): Promise<void> {
  const current = await readRegistry(opts);
  const next: Record<string, RepoEntry> = { ...current, [entry.name]: entry };
  await writeRegistry(next, opts);
}

/** Remove a single entry. No-op if the entry is absent. */
export async function removeFromRegistry(name: string, opts: RegistryOptions = {}): Promise<void> {
  const current = await readRegistry(opts);
  if (!(name in current)) return;
  const next: Record<string, RepoEntry> = { ...current };
  delete next[name];
  await writeRegistry(next, opts);
}

/** Replace the registry with an empty object. */
export async function clearRegistry(opts: RegistryOptions = {}): Promise<void> {
  await writeRegistry({}, opts);
}

/**
 * Find an entry whose `path` matches `repoPath` exactly. Used by
 * `list`/`status`/`clean` when the user points at a path rather than a name.
 */
export async function findRegistryEntryByPath(
  repoPath: string,
  opts: RegistryOptions = {},
): Promise<RepoEntry | undefined> {
  const resolved = resolve(repoPath);
  const all = await readRegistry(opts);
  for (const entry of Object.values(all)) {
    if (resolve(entry.path) === resolved) return entry;
  }
  return undefined;
}

/**
 * Resolve a repo path — optionally by registered name — back to an absolute
 * filesystem path. Returns `undefined` if no such entry exists.
 */
export async function resolveRegisteredRepoPath(
  nameOrPath: string | undefined,
  opts: RegistryOptions = {},
): Promise<string | undefined> {
  if (nameOrPath === undefined) return undefined;
  const registry = await readRegistry(opts);
  const hit = registry[nameOrPath];
  if (hit) return resolve(hit.path);
  // Treat the argument as a filesystem path if it isn't a registered name.
  return resolve(nameOrPath);
}

// ----------------------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------------------

async function writeRegistry(
  data: Record<string, RepoEntry>,
  opts: RegistryOptions,
): Promise<void> {
  const file = resolveRegistryFile(opts);
  await mkdir(dirname(file), { recursive: true });
  const ordered = sortByKey(data);
  const payload = `${JSON.stringify(ordered, null, 2)}\n`;
  await writeFileAtomic(file, payload, { raw: true });
}

function sortByKey(data: Record<string, RepoEntry>): Record<string, RepoEntry> {
  const out: Record<string, RepoEntry> = {};
  for (const key of Object.keys(data).sort()) {
    const entry = data[key];
    if (entry) out[key] = entry;
  }
  return out;
}

function validateRegistry(value: unknown, file: string): Record<string, RepoEntry> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid registry at ${file}: expected top-level object`);
  }
  const out: Record<string, RepoEntry> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry["name"] !== "string" || typeof entry["path"] !== "string") continue;
    if (typeof entry["indexedAt"] !== "string") continue;
    if (typeof entry["nodeCount"] !== "number" || typeof entry["edgeCount"] !== "number") continue;
    const normalized: RepoEntry = {
      name: entry["name"],
      path: entry["path"],
      indexedAt: entry["indexedAt"],
      nodeCount: entry["nodeCount"],
      edgeCount: entry["edgeCount"],
      ...(typeof entry["lastCommit"] === "string" ? { lastCommit: entry["lastCommit"] } : {}),
    };
    out[key] = normalized;
  }
  return out;
}
