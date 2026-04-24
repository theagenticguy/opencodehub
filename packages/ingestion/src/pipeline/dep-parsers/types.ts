/**
 * Shared types for the per-ecosystem manifest / lockfile parsers that the
 * `dependencies` pipeline phase invokes.
 *
 * Each parser is a pure async function: given a repository-relative
 * manifest or lockfile path and the absolute filesystem path, it returns
 * a de-duplicated list of parsed dependencies. Parsers never throw on
 * malformed input — they log via `onWarn` and return `[]` instead.
 *
 * License detection is intentionally deferred to
 * (`license_audit` MCP tool + dedicated license detector package); every
 * parser emits `license: "UNKNOWN"` for v1.0.
 */

import type { DependencyNode } from "@opencodehub/core-types";

export type Ecosystem = DependencyNode["ecosystem"];

/**
 * Minimal parsed dependency record. The `dependencies` phase promotes
 * these into full `DependencyNode` entries once all parsers have run.
 */
export interface ParsedDependency {
  readonly ecosystem: Ecosystem;
  readonly name: string;
  readonly version: string;
  /** Repo-relative POSIX path to the manifest / lockfile. */
  readonly lockfileSource: string;
}

/** Warning sink threaded through every parser for best-effort logging. */
export type WarnFn = (message: string) => void;

/** Input shape accepted by every parser. */
export interface ParseDepsInput {
  /** Absolute filesystem path to the manifest / lockfile. */
  readonly absPath: string;
  /** Repo-relative POSIX path (what goes into `lockfileSource`). */
  readonly relPath: string;
  /** Absolute repo root (needed by parsers that must locate sibling files). */
  readonly repoRoot: string;
  /** Warning hook. Errors must not propagate out of the parser. */
  readonly onWarn: WarnFn;
}

export type ParseDepsFn = (input: ParseDepsInput) => Promise<readonly ParsedDependency[]>;

/** Canonical comparison for stable `ParsedDependency[]` ordering. */
export function compareParsedDependency(a: ParsedDependency, b: ParsedDependency): number {
  if (a.ecosystem !== b.ecosystem) return a.ecosystem < b.ecosystem ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.version !== b.version) return a.version < b.version ? -1 : 1;
  if (a.lockfileSource !== b.lockfileSource) return a.lockfileSource < b.lockfileSource ? -1 : 1;
  return 0;
}

/**
 * De-duplicate a list of `ParsedDependency` on
 * `(ecosystem, name, version, lockfileSource)`. Callers rely on the
 * returned array being sorted canonically so graph output is byte-stable.
 */
export function dedupAndSort(deps: readonly ParsedDependency[]): readonly ParsedDependency[] {
  const seen = new Set<string>();
  const out: ParsedDependency[] = [];
  for (const d of deps) {
    const key = `${d.ecosystem}\x00${d.name}\x00${d.version}\x00${d.lockfileSource}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  out.sort(compareParsedDependency);
  return out;
}
