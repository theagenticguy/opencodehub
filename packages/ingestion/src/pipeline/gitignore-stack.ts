/**
 * Gitignore rule stacking helper — encapsulates the "layered rule set"
 * semantics git itself honours when nested `.gitignore` files are present.
 *
 * Git's rules (see `man gitignore`):
 *   - A `.gitignore` in a subdirectory shadows and extends the rules from
 *     its parents. Rules are evaluated from the repo root downward.
 *   - A negation (`!pat`) at a deeper layer can re-include a path that a
 *     parent layer excluded (and vice versa).
 *   - For a given path, evaluation walks the chain top-down; later matches
 *     override earlier ones. The final state (ignored / not-ignored) wins.
 *
 * This module does NOT scan the filesystem; it takes a pre-loaded
 * {@link GitignoreChain} (directory-relative paths → parsed rules) and
 * resolves the effective ignored state for a given path. The scan-time
 * walker in `gitignore.ts` handles the actual filesystem recursion.
 */

import type { IgnoreRule } from "./gitignore.js";

/**
 * Map from repo-relative directory path (POSIX, no leading slash; empty
 * string for the repo root) to that directory's parsed `.gitignore`
 * rules. A directory with no `.gitignore` is simply absent from the map.
 */
export type GitignoreChain = ReadonlyMap<string, readonly IgnoreRule[]>;

/**
 * Walk every parent directory of `relPath` from the repo root downward,
 * returning the sequence of layered rule sets that apply to it. Each
 * returned entry carries the owning directory (so rule paths can be made
 * relative to it) plus its rules.
 */
export function layersFor(
  relPath: string,
  chain: GitignoreChain,
): readonly { readonly dir: string; readonly rules: readonly IgnoreRule[] }[] {
  // Build the sequence of ancestor directories, root first.
  const out: { dir: string; rules: readonly IgnoreRule[] }[] = [];
  const rootRules = chain.get("");
  if (rootRules !== undefined && rootRules.length > 0) {
    out.push({ dir: "", rules: rootRules });
  }

  if (relPath === "" || !relPath.includes("/")) return out;
  const parts = relPath.split("/");
  // Walk ancestors excluding the file's own name (parts[0..-1)).
  let cur = "";
  for (let i = 0; i < parts.length - 1; i += 1) {
    cur = cur === "" ? (parts[i] as string) : `${cur}/${parts[i]}`;
    const rules = chain.get(cur);
    if (rules !== undefined && rules.length > 0) {
      out.push({ dir: cur, rules });
    }
  }
  return out;
}

/**
 * Evaluate `relPath` against the layered chain. Rules at deeper layers
 * override rules at shallower layers; within a layer, the last-matching
 * rule wins (same as git). Returns `true` when the path should be
 * ignored.
 */
export function shouldIgnoreLayered(
  relPath: string,
  chain: GitignoreChain,
  opts: { readonly isDirectory?: boolean } = {},
): boolean {
  const isDir = opts.isDirectory === true;
  let ignored = false;
  for (const layer of layersFor(relPath, chain)) {
    // Paths inside a `.gitignore` are interpreted relative to the
    // directory that owns the file. Strip the ancestor prefix so the
    // layer's rules match against the correct sub-path.
    const pathUnderLayer = layer.dir === "" ? relPath : relPath.slice(layer.dir.length + 1);
    for (const rule of layer.rules) {
      if (rule.directoryOnly && !isDir) continue;
      if (rule.regex.test(pathUnderLayer)) {
        ignored = !rule.negate;
      }
    }
  }
  return ignored;
}
