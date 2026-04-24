/**
 * Shared types for the per-ecosystem manifest / lockfile parsers that the
 * `dependencies` pipeline phase invokes.
 *
 * Each parser is a pure async function: given a repository-relative
 * manifest or lockfile path and the absolute filesystem path, it returns
 * a de-duplicated list of parsed dependencies. Parsers never throw on
 * malformed input — they log via `onWarn` and return `[]` instead.
 *
 * License detection: each parser populates `ParsedDependency.license`
 * directly from the manifest field when one is present (SPDX identifier
 * or a free-form string — the `dependencies` phase normalises through
 * `spdx-correct` before storage). The value is `undefined` when the
 * manifest does not carry license metadata; the phase converts that to
 * the canonical `"UNKNOWN"` sentinel on the DependencyNode.
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
  /**
   * License declaration as it appears in the manifest (SPDX id or a
   * free-form expression). `undefined` when the manifest entry did not
   * carry a license; the `dependencies` phase maps that to the
   * `"UNKNOWN"` sentinel on the DependencyNode.
   */
  readonly license?: string;
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
 * `(ecosystem, name, version, lockfileSource)`. When two records collide,
 * we keep the first occurrence but prefer a defined `license` over an
 * undefined one — a lockfile with no license + a sibling manifest that
 * carries one should surface as "has license" after dedup. Callers rely
 * on the returned array being sorted canonically so graph output is
 * byte-stable.
 */
export function dedupAndSort(deps: readonly ParsedDependency[]): readonly ParsedDependency[] {
  const byKey = new Map<string, ParsedDependency>();
  for (const d of deps) {
    const key = `${d.ecosystem}\x00${d.name}\x00${d.version}\x00${d.lockfileSource}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, d);
      continue;
    }
    // Prefer an entry carrying a license over one that doesn't.
    if (existing.license === undefined && d.license !== undefined) {
      byKey.set(key, d);
    }
  }
  const out = [...byKey.values()];
  out.sort(compareParsedDependency);
  return out;
}
