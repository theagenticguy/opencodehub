/**
 * Read-only accessors for `~/.codehub/groups/<name>.json`.
 *
 * The MCP package intentionally reimplements a tiny reader rather than
 * depending on `@opencodehub/cli`: the CLI depends on `@opencodehub/mcp`
 * (via the `mcp` command), and the reverse would be a cycle. The on-disk
 * shape is stable — we parallel the invariants in
 * `packages/cli/src/groups.ts` (`GROUPS_DIR_NAME`, name pattern, shape)
 * and cover them in tests.
 */
// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";

const CODEHUB_HOME_DIR = ".codehub";
const GROUPS_DIR_NAME = "groups";
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
  readonly home?: string;
}

export function resolveGroupsDir(opts: GroupsOptions = {}): string {
  const home = opts.home ?? homedir();
  return resolve(home, CODEHUB_HOME_DIR, GROUPS_DIR_NAME);
}

export function resolveGroupFile(name: string, opts: GroupsOptions = {}): string {
  if (!GROUP_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid group name "${name}". Names must match ${GROUP_NAME_PATTERN}.`);
  }
  return join(resolveGroupsDir(opts), `${name}.json`);
}

export async function readGroup(
  name: string,
  opts: GroupsOptions = {},
): Promise<GroupEntry | null> {
  if (!GROUP_NAME_PATTERN.test(name)) return null;
  const file = resolveGroupFile(name, opts);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return normalizeGroup(JSON.parse(raw) as unknown);
}

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
    } catch {
      // Skip unreadable files; callers surface them via empty returns.
    }
  }
  return out;
}

function normalizeGroup(value: unknown): GroupEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw["name"] !== "string") return null;
  if (typeof raw["createdAt"] !== "string") return null;
  if (!Array.isArray(raw["repos"])) return null;
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
