/**
 * Minimal gitignore evaluator.
 *
 * Supports the subset of `.gitignore` syntax used in practice:
 *  - Comments (`#`) and blank lines.
 *  - Trailing-slash directory-only matches.
 *  - Leading-slash anchored-to-root matches.
 *  - Negation (`!`) re-includes a previously excluded path.
 *  - `*` (single segment), `?` (single char), `**` (any number of segments).
 *  - Nested `.gitignore` files with layered negation (DET-U-003 /
 *    DET-E-004). Rules stack from repo root downward; deeper layers
 *    override shallower ones so `docs/.gitignore` can negate rules set
 *    by the repo-root file.
 *
 * Not supported today: character classes (`[abc]`), escaped metacharacters
 * (`\*`). We surface them as warnings when the operator enables verbose
 * mode.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { GitignoreChain } from "./gitignore-stack.js";
import { shouldIgnoreLayered } from "./gitignore-stack.js";

export type { GitignoreChain } from "./gitignore-stack.js";
export { shouldIgnoreLayered } from "./gitignore-stack.js";

/** Parsed gitignore rule — order matters; later rules win. */
export interface IgnoreRule {
  /** Original source line, for debugging. */
  readonly raw: string;
  /** `true` if the rule re-includes (was prefixed with `!`). */
  readonly negate: boolean;
  /** `true` if the rule only matches directories (trailing `/`). */
  readonly directoryOnly: boolean;
  /** `true` if the pattern is anchored to the directory that declared it. */
  readonly anchored: boolean;
  /** RegExp derived from the glob pattern. */
  readonly regex: RegExp;
}

/**
 * Parse a `.gitignore` file's contents into a list of rules.
 */
export function parseGitignore(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  const lines = content.split(/\r?\n/);
  for (const raw of lines) {
    // Strip trailing whitespace; gitignore treats trailing spaces as part
    // of the pattern only when escaped. We don't support escaped spaces.
    const trimmed = raw.replace(/\s+$/, "");
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    let pattern = trimmed;
    let negate = false;
    if (pattern.startsWith("!")) {
      negate = true;
      pattern = pattern.slice(1);
    }

    let directoryOnly = false;
    if (pattern.endsWith("/")) {
      directoryOnly = true;
      pattern = pattern.slice(0, -1);
    }

    let anchored = false;
    if (pattern.startsWith("/")) {
      anchored = true;
      pattern = pattern.slice(1);
    } else if (pattern.includes("/")) {
      // Middle-slash patterns are implicitly anchored per git's rules.
      anchored = true;
    }

    const regex = globToRegex(pattern, anchored);
    rules.push({ raw, negate, directoryOnly, anchored, regex });
  }
  return rules;
}

/**
 * Translate a gitignore glob into a RegExp matching the relative path
 * below the declaring directory. Paths are normalized to forward slashes
 * by the caller before matching.
 */
function globToRegex(glob: string, anchored: boolean): RegExp {
  // Walk character by character so we can handle `**` as a special token.
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**` — zero or more path segments.
        // `**/x` -> match `x` at any depth; `x/**` -> match anything under x.
        const next = glob[i + 2];
        if (next === "/") {
          out += "(?:.*/)?";
          i += 3;
          continue;
        }
        // Trailing `**` — match any remaining suffix.
        out += ".*";
        i += 2;
        continue;
      }
      // Single `*` — match within a single path segment.
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    // Escape regex metacharacters.
    if (/[.+^${}()|[\]\\]/.test(c)) {
      out += `\\${c}`;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }

  const anchorPrefix = anchored ? "^" : "(?:^|.*/)";
  // Allow the pattern to match either the full path or a path prefix that
  // ends on a `/` (so `build` matches `build/foo.ts`).
  const suffix = "(?:/|$)";
  return new RegExp(`${anchorPrefix}${out}${suffix}`);
}

/**
 * Evaluate a path against a rule set or a layered chain. Two calling
 * shapes are supported to preserve binary-compat with pre-P06 callers:
 *
 *   - Legacy: `shouldIgnore(relPath, rules[], opts)` treats the second
 *     argument as a flat rule list. Later rules win.
 *   - Layered: `shouldIgnore(relPath, chain, opts)` treats a `Map` or
 *     {@link GitignoreChain}-style object as a layered rule stack.
 *     Deeper layers override shallower ones (git's actual semantics).
 *
 * `relPath` must use forward slashes and be relative to the repo root.
 */
export function shouldIgnore(
  relPath: string,
  rulesOrChain: readonly IgnoreRule[] | GitignoreChain,
  opts: { readonly isDirectory?: boolean } = {},
): boolean {
  if (rulesOrChain instanceof Map) {
    return shouldIgnoreLayered(relPath, rulesOrChain, opts);
  }
  const isDir = opts.isDirectory === true;
  let ignored = false;
  for (const rule of rulesOrChain as readonly IgnoreRule[]) {
    if (rule.directoryOnly && !isDir) continue;
    if (rule.regex.test(relPath)) {
      ignored = !rule.negate;
    }
  }
  return ignored;
}

/**
 * Recursively load every `.gitignore` under `repoPath` into a single chain
 * keyed by repo-relative directory path (POSIX, no leading slash; `""` is
 * the repo root).
 *
 * The walker stops at hardcoded ignores (`node_modules`, `.git`, etc.)
 * plus any directory whose own parent-layered rule set marks it as
 * ignored — i.e. it does not recurse into a directory that the existing
 * rules already ignore. This mirrors git's own behaviour and avoids
 * expanding the ignore tree into `node_modules` subtrees.
 */
export async function loadGitignoreChain(repoPath: string): Promise<Map<string, IgnoreRule[]>> {
  const chain = new Map<string, IgnoreRule[]>();
  const hardcoded = new Set<string>(HARDCODED_IGNORES);
  await loadDir(repoPath, "", chain, hardcoded);
  // Always return a `""` entry — scan.ts and other callers rely on its
  // presence (empty array is fine when no root .gitignore exists).
  if (!chain.has("")) chain.set("", []);
  return chain;
}

async function loadDir(
  repoPath: string,
  relDir: string,
  chain: Map<string, IgnoreRule[]>,
  hardcoded: ReadonlySet<string>,
): Promise<void> {
  const absDir = path.join(repoPath, relDir);
  const ignoreFile = path.join(absDir, ".gitignore");
  try {
    const content = await fs.readFile(ignoreFile, "utf8");
    chain.set(relDir, parseGitignore(content));
  } catch {
    // No .gitignore here — nothing to stack for this layer. Deeper
    // layers may still contribute rules.
  }

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (hardcoded.has(entry.name)) continue;
    const childRel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
    // Respect the chain we've built up so far so we don't descend into a
    // subtree the parent layer already excluded. A directory ignored at
    // layer N is still ignored at layer N+1 unless a deeper .gitignore
    // re-includes it via a negation — and in that case we need to walk
    // in anyway. The conservative win here is to recurse: the extra
    // .gitignore reads are cheap and we match git's behaviour more
    // exactly.
    await loadDir(repoPath, childRel, chain, hardcoded);
  }
}

/** Hardcoded directory names we always skip, even absent a `.gitignore`. */
export const HARDCODED_IGNORES: readonly string[] = [
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "target",
  ".codehub",
  ".venv",
  "__pycache__",
  ".next",
  ".nuxt",
  ".turbo",
  "coverage",
];
