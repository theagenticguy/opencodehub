/**
 * BOM body item: dependency graph / lockfile slice (AC-M5-4 — item 4/9).
 *
 * Reads `Dependency` nodes via `IGraphStore.listNodes()` and projects
 * each onto a flat `DepRow`. Mirrors the shape of the MCP `dependencies`
 * tool (`packages/mcp/src/tools/dependencies.ts`) but does NOT depend on
 * `@opencodehub/mcp` — that would create a workspace cycle (mcp depends
 * on pack via `pack_codebase`).
 *
 * Determinism contract:
 *   - Rows are sorted by `(ecosystem ASC, name ASC, version ASC, id ASC)`
 *     for byte-identity. The id-tiebreak is the deterministic last
 *     resort when two packages share the leading three columns (e.g.
 *     a polyrepo with the same package pinned at the same version
 *     across multiple lockfiles).
 *   - Missing `license` and `version` are preserved as `undefined` —
 *     do NOT coerce to "UNKNOWN" here. The MCP tool coerces because
 *     it ships rendered Markdown; the BOM stores raw graph state and
 *     leaves coercion to the consumer.
 *   - Two consecutive calls on the same store return identical rows.
 */

import type { IGraphStore } from "@opencodehub/storage";

/** A single row in the deps BOM file. */
export interface DepRow {
  /** Graph node id (the deterministic last-resort tiebreak). */
  readonly id: string;
  /** Package name as parsed from the lockfile. */
  readonly name: string;
  /**
   * Resolved package version. The `DependencyNode` schema defines
   * `version: string` (non-optional), but we keep the row shape lenient
   * so future graphs that allow optional version (e.g. workspace `*`
   * pins) round-trip without coercion. See AC-M5-4 anti-goals.
   */
  readonly version: string;
  /** Ecosystem — `npm` / `pypi` / `go` / `cargo` / `maven` / `nuget`. */
  readonly ecosystem: string;
  /** Repo-relative path to the lockfile / manifest. */
  readonly lockfileSource: string;
  /** SPDX license id when known; preserved as `undefined` otherwise. */
  readonly license?: string;
}

/** Inputs to {@link buildDeps}. */
export interface DepsOpts {
  readonly store: IGraphStore;
}

/**
 * Build the dependency slice.
 *
 * Empty graphs (no `Dependency` nodes) return `[]`.
 */
export async function buildDeps(opts: DepsOpts): Promise<readonly DepRow[]> {
  const { store } = opts;
  const deps = await store.listNodes({ kinds: ["Dependency"] });

  const rows: DepRow[] = [];
  for (const node of deps) {
    if (node.kind !== "Dependency") continue;
    const row: DepRow = {
      id: node.id,
      name: node.name,
      version: node.version,
      ecosystem: node.ecosystem,
      lockfileSource: node.lockfileSource,
      ...(node.license !== undefined ? { license: node.license } : {}),
    };
    rows.push(row);
  }

  rows.sort((a, b) => {
    if (a.ecosystem !== b.ecosystem) return a.ecosystem < b.ecosystem ? -1 : 1;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    if (a.version !== b.version) return a.version < b.version ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return rows;
}
