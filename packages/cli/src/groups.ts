/**
 * Cross-repo group registry at `~/.codehub/groups/<name>.json`.
 *
 * A group is a named bundle of already-indexed repos. Each group lives in its
 * own JSON file so that:
 *   - `write-file-atomic` rewrites of one group never serialize against another,
 *   - deletion is a single `unlink`, and
 *   - additive use (two users sharing `~/.codehub` via sync) sees minimal
 *     conflicts.
 *
 * The on-disk shape is intentionally minimal (name + createdAt + repos[] +
 * optional description). Callers that need richer metadata should compose
 * against `~/.codehub/registry.json` via `readRegistry` at call time — we do
 * NOT duplicate per-repo stats into the group file.
 *
 * Determinism: `repos[]` is sorted by `name` on every write; on-disk JSON ends
 * with a single trailing newline; writes go through `write-file-atomic`. Group
 * names must be filesystem-safe (`[a-z0-9_-]+`) and are validated before any
 * filesystem call.
 */
// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures

import { mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { writeFileAtomic } from "./fs-atomic.js";
import { CODEHUB_HOME_DIR } from "./registry.js";

/** Per-group subdirectory under `~/.codehub`. */
export const GROUPS_DIR_NAME = "groups";

/** Allowed group names. Matches a single path segment that is safe on macOS, Linux, and Windows. */
export const GROUP_NAME_PATTERN = /^[a-z0-9_-]+$/;

export interface GroupRepo {
  readonly name: string;
  readonly path: string;
}

export interface GroupEntry {
  readonly name: string;
  readonly createdAt: string;
  readonly repos: readonly GroupRepo[];
  readonly description?: string;
}

export interface GroupsOptions {
  /** Override `~` root used to locate `~/.codehub/groups` (tests pass a tmpdir). */
  readonly home?: string;
}

/**
 * Validate a group name up front so we never create filesystem paths from
 * arbitrary user input. Throws on bad names.
 */
export function assertValidGroupName(name: string): void {
  if (!GROUP_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid group name "${name}". Names must match ${GROUP_NAME_PATTERN} ` +
        "(lowercase letters, digits, underscore, hyphen).",
    );
  }
}

/** Resolve the absolute path of the `groups/` directory. */
export function resolveGroupsDir(opts: GroupsOptions = {}): string {
  const home = opts.home ?? homedir();
  return resolve(home, CODEHUB_HOME_DIR, GROUPS_DIR_NAME);
}

/** Resolve the absolute path of a group's JSON file. */
export function resolveGroupFile(name: string, opts: GroupsOptions = {}): string {
  assertValidGroupName(name);
  return join(resolveGroupsDir(opts), `${name}.json`);
}

/** Read a single group by name. Returns `null` when the file does not exist. */
export async function readGroup(
  name: string,
  opts: GroupsOptions = {},
): Promise<GroupEntry | null> {
  assertValidGroupName(name);
  const file = resolveGroupFile(name, opts);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed = JSON.parse(raw) as unknown;
  return validateGroup(parsed, file);
}

/**
 * Write a group to disk atomically. The `repos` array is sorted by `name` so
 * byte-for-byte output is stable across invocations. Creates the parent
 * directory when missing.
 */
export async function writeGroup(group: GroupEntry, opts: GroupsOptions = {}): Promise<void> {
  assertValidGroupName(group.name);
  const file = resolveGroupFile(group.name, opts);
  await mkdir(dirname(file), { recursive: true });
  const sortedRepos = [...group.repos]
    .map((r): GroupRepo => ({ name: r.name, path: r.path }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const payload: GroupEntry = {
    name: group.name,
    createdAt: group.createdAt,
    repos: sortedRepos,
    ...(group.description !== undefined ? { description: group.description } : {}),
  };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  await writeFileAtomic(file, serialized, { raw: true });
}

/** Delete a group. Returns `true` if the file existed, `false` otherwise. */
export async function deleteGroup(name: string, opts: GroupsOptions = {}): Promise<boolean> {
  assertValidGroupName(name);
  const file = resolveGroupFile(name, opts);
  try {
    await unlink(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Enumerate every group under `~/.codehub/groups`. Returned entries are
 * sorted by name. Unreadable/malformed files are skipped with an error logged
 * to stderr rather than tearing down the caller.
 */
export async function listGroups(opts: GroupsOptions = {}): Promise<readonly GroupEntry[]> {
  const dir = resolveGroupsDir(opts);
  let dirents: string[];
  try {
    dirents = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const names = dirents
    .filter((f) => extname(f) === ".json")
    .map((f) => basename(f, ".json"))
    .filter((n) => GROUP_NAME_PATTERN.test(n))
    .sort();

  const out: GroupEntry[] = [];
  for (const name of names) {
    try {
      const group = await readGroup(name, opts);
      if (group) out.push(group);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`codehub groups: skipping malformed group "${name}": ${msg}`);
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------------------

function validateGroup(value: unknown, file: string): GroupEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid group at ${file}: expected top-level object`);
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw["name"] !== "string") {
    throw new Error(`Invalid group at ${file}: missing "name"`);
  }
  if (typeof raw["createdAt"] !== "string") {
    throw new Error(`Invalid group at ${file}: missing "createdAt"`);
  }
  if (!Array.isArray(raw["repos"])) {
    throw new Error(`Invalid group at ${file}: missing "repos" array`);
  }
  const repos: GroupRepo[] = [];
  for (const entry of raw["repos"]) {
    if (typeof entry !== "object" || entry === null) continue;
    const r = entry as Record<string, unknown>;
    if (typeof r["name"] !== "string" || typeof r["path"] !== "string") continue;
    repos.push({ name: r["name"], path: r["path"] });
  }
  repos.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out: GroupEntry = {
    name: raw["name"],
    createdAt: raw["createdAt"],
    repos,
    ...(typeof raw["description"] === "string" ? { description: raw["description"] } : {}),
  };
  return out;
}
