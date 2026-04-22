/**
 * `codehub group <subcommand>` — create and operate on named sets of repos.
 *
 * Groups live at `~/.codehub/groups/<name>.json` (see `../groups.ts`). A
 * group is a pure pointer into the per-user registry: on create/add we
 * require every repo to already exist in `~/.codehub/registry.json`, so
 * downstream consumers (MCP `group_query`, `group_status`) can route through
 * the registry without having to re-resolve paths.
 *
 * Subcommands:
 *   create <name> <repo1> <repo2>...   create a group (repos must be registered)
 *   list                                print every group
 *   delete <name>                       remove a group
 *   add    <name> <repo>                add one registered repo to an existing group
 *   remove <name> <repo>                drop one repo from an existing group
 *   show   <name>                       print a group's metadata + member repos
 *   status <name>                       per-repo staleness within the group
 *   query  <name> <text>                RRF-fused BM25 across the group (CLI)
 *
 * `query` is provided for parity with `codehub query`; agents are expected to
 * reach for the MCP `group_query` tool instead.
 */

import { resolve } from "node:path";
import { DEFAULT_RRF_K, DEFAULT_RRF_TOP_K, rrf } from "@opencodehub/search";
import type { SearchResult } from "@opencodehub/storage";
import { DuckDbStore, readStoreMeta, resolveDbPath } from "@opencodehub/storage";
import { Command } from "commander";
import {
  deleteGroup,
  type GroupEntry,
  type GroupRepo,
  listGroups,
  readGroup,
  writeGroup,
} from "../groups.js";
import { type RepoEntry, readRegistry } from "../registry.js";

export interface GroupCommandOptions {
  /** Test hook: override home dir for the registry + groups. */
  readonly home?: string;
}

/**
 * Build a Commander subparser so `codehub group ...` dispatches to the right
 * handler. Returned via a factory so the CLI entrypoint can lazy-import this
 * module.
 */
export function buildGroupCommand(opts: GroupCommandOptions = {}): Command {
  const root = new Command("group").description("Manage named cross-repo groups");

  root
    .command("create <name> <repos...>")
    .description("Create a group from registered repo names")
    .option("--description <text>", "Short human-readable description")
    .action(async (name: string, repos: string[], subOpts: Record<string, unknown>) => {
      await runGroupCreate(name, repos, {
        ...(typeof subOpts["description"] === "string"
          ? { description: subOpts["description"] }
          : {}),
        ...(opts.home !== undefined ? { home: opts.home } : {}),
      });
    });

  root
    .command("list")
    .description("List all groups")
    .action(async () => {
      await runGroupList(opts.home !== undefined ? { home: opts.home } : {});
    });

  root
    .command("delete <name>")
    .description("Delete a group")
    .action(async (name: string) => {
      await runGroupDelete(name, opts.home !== undefined ? { home: opts.home } : {});
    });

  root
    .command("add <name> <repo>")
    .description("Add one registered repo to an existing group")
    .action(async (name: string, repo: string) => {
      await runGroupAdd(name, repo, opts.home !== undefined ? { home: opts.home } : {});
    });

  root
    .command("remove <name> <repo>")
    .description("Remove one repo from an existing group (group stays if it becomes empty)")
    .action(async (name: string, repo: string) => {
      await runGroupRemove(name, repo, opts.home !== undefined ? { home: opts.home } : {});
    });

  root
    .command("show <name>")
    .description("Print group metadata + member repos (with registry staleness)")
    .action(async (name: string) => {
      await runGroupShow(name, opts.home !== undefined ? { home: opts.home } : {});
    });

  root
    .command("status <name>")
    .description("Per-repo index freshness within a group")
    .action(async (name: string) => {
      await runGroupStatus(name, opts.home !== undefined ? { home: opts.home } : {});
    });

  root
    .command("query <name> <text>")
    .description("BM25 over every repo in the group, fused with RRF")
    .option("--limit <n>", "Max results (default 20)", (v) => Number.parseInt(v, 10), 20)
    .option("--json", "Emit JSON on stdout")
    .action(async (name: string, text: string, subOpts: Record<string, unknown>) => {
      await runGroupQuery(name, text, {
        limit: typeof subOpts["limit"] === "number" ? subOpts["limit"] : 20,
        json: subOpts["json"] === true,
        ...(opts.home !== undefined ? { home: opts.home } : {}),
      });
    });

  return root;
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

export interface GroupCreateOptions {
  readonly home?: string;
  readonly description?: string;
  /** Override createdAt timestamp (tests). */
  readonly now?: () => string;
}

export async function runGroupCreate(
  name: string,
  repoNames: readonly string[],
  opts: GroupCreateOptions = {},
): Promise<GroupEntry> {
  if (repoNames.length === 0) {
    throw new Error("codehub group create: at least one repo name is required");
  }
  const registryOpts = opts.home !== undefined ? { home: opts.home } : {};
  const registry = await readRegistry(registryOpts);

  const resolved: GroupRepo[] = [];
  const missing: string[] = [];
  for (const n of repoNames) {
    const hit = registry[n];
    if (!hit) {
      missing.push(n);
      continue;
    }
    resolved.push({ name: hit.name, path: resolve(hit.path) });
  }
  if (missing.length > 0) {
    throw new Error(
      `codehub group create: unknown repo(s): ${missing.join(", ")}. ` +
        "Run `codehub analyze` on each first, or `codehub list` to see what's registered.",
    );
  }

  const now = opts.now ? opts.now() : new Date().toISOString();
  const group: GroupEntry = {
    name,
    createdAt: now,
    repos: resolved,
    ...(opts.description !== undefined ? { description: opts.description } : {}),
  };
  await writeGroup(group, registryOpts);
  console.warn(
    `codehub group create: ${name} (${resolved.length} repo${resolved.length === 1 ? "" : "s"})`,
  );
  return group;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export async function runGroupList(opts: GroupCommandOptions = {}): Promise<void> {
  const groups = await listGroups(opts.home !== undefined ? { home: opts.home } : {});
  if (groups.length === 0) {
    console.warn("No groups defined. Use `codehub group create <name> <repo...>`.");
    return;
  }
  for (const g of groups) {
    const repoList = g.repos.map((r) => r.name).join(", ");
    console.log(`${g.name}  (${g.repos.length}): ${repoList}`);
    if (g.description) console.log(`  ${g.description}`);
  }
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

export async function runGroupDelete(name: string, opts: GroupCommandOptions = {}): Promise<void> {
  const removed = await deleteGroup(name, opts.home !== undefined ? { home: opts.home } : {});
  if (removed) {
    console.warn(`codehub group delete: ${name}`);
  } else {
    console.warn(`codehub group delete: ${name} — not found`);
  }
}

// ---------------------------------------------------------------------------
// add / remove / show
// ---------------------------------------------------------------------------

/**
 * Add one registered repo to an existing group. Idempotent — re-adding an
 * already-member repo is a no-op (and emits a warning). Rejects unknown
 * group names and unknown registry names with actionable errors.
 */
export async function runGroupAdd(
  groupName: string,
  repoName: string,
  opts: GroupCommandOptions = {},
): Promise<GroupEntry> {
  const registryOpts = opts.home !== undefined ? { home: opts.home } : {};
  const group = await readGroup(groupName, registryOpts);
  if (!group) {
    throw new Error(
      `codehub group add: group ${groupName} not found. Run \`codehub group create\` first.`,
    );
  }
  const registry = await readRegistry(registryOpts);
  const hit = registry[repoName];
  if (!hit) {
    throw new Error(
      `codehub group add: unknown repo "${repoName}". Run \`codehub analyze\` on it first, or \`codehub list\` to see what's registered.`,
    );
  }
  if (group.repos.some((r) => r.name === repoName)) {
    console.warn(`codehub group add: ${repoName} is already a member of ${groupName}`);
    return group;
  }
  const nextRepos: GroupRepo[] = [...group.repos, { name: hit.name, path: resolve(hit.path) }];
  const next: GroupEntry = {
    ...group,
    repos: nextRepos,
  };
  await writeGroup(next, registryOpts);
  console.warn(`codehub group add: ${groupName} += ${repoName}`);
  return next;
}

/**
 * Drop a repo from a group. Idempotent — removing a non-member is a no-op
 * (and emits a warning). If the group becomes empty, the group is retained
 * (callers who want it gone should call `codehub group delete`).
 */
export async function runGroupRemove(
  groupName: string,
  repoName: string,
  opts: GroupCommandOptions = {},
): Promise<GroupEntry> {
  const registryOpts = opts.home !== undefined ? { home: opts.home } : {};
  const group = await readGroup(groupName, registryOpts);
  if (!group) {
    throw new Error(`codehub group remove: group ${groupName} not found`);
  }
  const filtered = group.repos.filter((r) => r.name !== repoName);
  if (filtered.length === group.repos.length) {
    console.warn(`codehub group remove: ${repoName} is not a member of ${groupName}`);
    return group;
  }
  const next: GroupEntry = { ...group, repos: filtered };
  await writeGroup(next, registryOpts);
  console.warn(`codehub group remove: ${groupName} -= ${repoName}`);
  return next;
}

/**
 * Print a single group's metadata + member repos. Each member is annotated
 * with registry staleness (indexedAt, node/edge counts, lastCommit) so the
 * reader can see which repos need a re-analyze without a second call.
 */
export async function runGroupShow(
  name: string,
  opts: GroupCommandOptions = {},
): Promise<GroupEntry | null> {
  const registryOpts = opts.home !== undefined ? { home: opts.home } : {};
  const group = await readGroup(name, registryOpts);
  if (!group) {
    console.warn(`codehub group show: ${name} not found`);
    return null;
  }
  const registry = await readRegistry(registryOpts);
  console.log(`${group.name}  (createdAt: ${group.createdAt})`);
  if (group.description) console.log(`  ${group.description}`);
  if (group.repos.length === 0) {
    console.log("  (no member repos)");
    return group;
  }
  for (const repo of group.repos) {
    const hit = registry[repo.name];
    const trailer = hit
      ? `(${hit.nodeCount} nodes, ${hit.edgeCount} edges, indexedAt ${hit.indexedAt})`
      : "[orphan — no registry entry]";
    console.log(`  ${repo.name}  ${repo.path}  ${trailer}`);
  }
  return group;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export interface GroupStatusRow {
  readonly name: string;
  readonly path: string;
  readonly indexedAt: string | undefined;
  readonly nodeCount: number | undefined;
  readonly edgeCount: number | undefined;
  readonly lastCommit: string | undefined;
  readonly inRegistry: boolean;
}

export async function runGroupStatus(
  name: string,
  opts: GroupCommandOptions = {},
): Promise<readonly GroupStatusRow[]> {
  const registryOpts = opts.home !== undefined ? { home: opts.home } : {};
  const group = await readGroup(name, registryOpts);
  if (!group) {
    console.warn(`codehub group status: ${name} not found`);
    return [];
  }
  const registry = await readRegistry(registryOpts);
  const rows = await collectStatusRows(group, registry);
  for (const r of rows) {
    const header = r.inRegistry
      ? `${r.name}  (${r.nodeCount ?? "?"} nodes, ${r.edgeCount ?? "?"} edges)`
      : `${r.name}  [orphan — no registry entry]`;
    console.log(header);
    console.log(`  path:       ${r.path}`);
    if (r.indexedAt) console.log(`  indexedAt:  ${r.indexedAt}`);
    if (r.lastCommit) console.log(`  lastCommit: ${r.lastCommit}`);
  }
  return rows;
}

async function collectStatusRows(
  group: GroupEntry,
  registry: Record<string, RepoEntry>,
): Promise<readonly GroupStatusRow[]> {
  const rows: GroupStatusRow[] = [];
  for (const repo of group.repos) {
    const registryHit = registry[repo.name];
    const row: GroupStatusRow = {
      name: repo.name,
      path: repo.path,
      indexedAt: registryHit?.indexedAt,
      nodeCount: registryHit?.nodeCount,
      edgeCount: registryHit?.edgeCount,
      lastCommit: registryHit?.lastCommit,
      inRegistry: registryHit !== undefined,
    };
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// query
// ---------------------------------------------------------------------------

export interface GroupQueryOptions {
  readonly home?: string;
  readonly limit?: number;
  readonly json?: boolean;
}

export interface GroupQueryResultRow {
  readonly repoName: string;
  readonly nodeId: string;
  readonly name: string;
  readonly kind: string;
  readonly filePath: string;
  readonly score: number;
}

export async function runGroupQuery(
  name: string,
  text: string,
  opts: GroupQueryOptions = {},
): Promise<readonly GroupQueryResultRow[]> {
  const limit = opts.limit ?? 20;
  const registryOpts = opts.home !== undefined ? { home: opts.home } : {};
  const group = await readGroup(name, registryOpts);
  if (!group) {
    throw new Error(`codehub group query: group ${name} not found`);
  }
  const registry = await readRegistry(registryOpts);
  // Sort alphabetically for deterministic RRF iteration.
  const sortedRepos = [...group.repos].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const perRepoRuns: { repoName: string; results: SearchResult[] }[] = [];
  for (const repo of sortedRepos) {
    const registryHit = registry[repo.name];
    if (!registryHit) {
      console.warn(
        `codehub group query: repo "${repo.name}" referenced by group ${name} is no longer in the registry`,
      );
      continue;
    }
    const repoPath = resolve(registryHit.path);
    const dbPath = resolveDbPath(repoPath);
    const store = new DuckDbStore(dbPath, { readOnly: true });
    try {
      await store.open();
      const results = await store.search({ text, limit: 50 });
      perRepoRuns.push({ repoName: repo.name, results: [...results] });
    } finally {
      await store.close();
    }
  }

  const merged = fuseGroupRuns(perRepoRuns, limit);
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          groupName: name,
          repos: sortedRepos.map((r) => r.name),
          results: merged,
        },
        null,
        2,
      ),
    );
    return merged;
  }
  if (merged.length === 0) {
    console.warn(`codehub group query: no matches for "${text}" in ${name}`);
    return merged;
  }
  for (const row of merged) {
    console.log(
      `${row.score.toFixed(4)}  ${row.repoName}::${row.name} [${row.kind}]  ${row.filePath}`,
    );
  }
  return merged;
}

/**
 * Turn N per-repo BM25 runs into a single RRF-fused list. Keys are
 * `${repoName}::${nodeId}` so a symbol that exists in two repos contributes
 * two entries. Ties break lexically on `(repoName, nodeId)`.
 */
export function fuseGroupRuns(
  perRepoRuns: readonly { readonly repoName: string; readonly results: readonly SearchResult[] }[],
  topK: number,
): GroupQueryResultRow[] {
  const meta = new Map<string, GroupQueryResultRow>();
  const runs: { id: string }[][] = [];
  for (const run of perRepoRuns) {
    const ranked: { id: string }[] = [];
    for (const r of run.results) {
      const id = `${run.repoName}::${r.nodeId}`;
      ranked.push({ id });
      if (!meta.has(id)) {
        meta.set(id, {
          repoName: run.repoName,
          nodeId: r.nodeId,
          name: r.name,
          kind: r.kind,
          filePath: r.filePath,
          score: 0,
        });
      }
    }
    runs.push(ranked);
  }
  const fused = rrf(runs, DEFAULT_RRF_K, Math.max(topK, DEFAULT_RRF_TOP_K));
  const out: GroupQueryResultRow[] = [];
  for (const f of fused) {
    const row = meta.get(f.id);
    if (!row) continue;
    out.push({ ...row, score: f.score });
  }
  // Deterministic final ordering: score desc, then (repoName, nodeId) lex asc.
  out.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.repoName !== b.repoName) return a.repoName < b.repoName ? -1 : 1;
    if (a.nodeId !== b.nodeId) return a.nodeId < b.nodeId ? -1 : 1;
    return 0;
  });
  return out.slice(0, topK);
}

// ---------------------------------------------------------------------------
// Optional per-repo staleness helper — exported for reuse by the MCP tool.
// ---------------------------------------------------------------------------

export async function readGroupRepoMeta(
  repoPath: string,
): Promise<{ readonly indexedAt?: string; readonly lastCommit?: string } | undefined> {
  const meta = await readStoreMeta(repoPath);
  if (!meta) return undefined;
  return {
    ...(typeof meta.indexedAt === "string" ? { indexedAt: meta.indexedAt } : {}),
    ...(typeof meta.lastCommit === "string" ? { lastCommit: meta.lastCommit } : {}),
  };
}
