/**
 * Minimal gitignore evaluator.
 *
 * Supports the subset of `.gitignore` syntax used in practice:
 *  - Comments (`#`) and blank lines.
 *  - Trailing-slash directory-only matches.
 *  - Leading-slash anchored-to-root matches.
 *  - Negation (`!`) re-includes a previously excluded path.
 *  - `*` (single segment), `?` (single char), `**` (any number of segments).
 *
 * Not supported today: character classes (`[abc]`), escaped metacharacters
 * (`\*`), nested `.gitignore` files with re-inclusion across directories.
 * These fall outside the MVP cut and we surface them as a warning when the
 * operator enables verbose mode.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

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
 * Evaluate a path against a rule set. Later rules win (match git's
 * semantics where a negation at the end of the file overrides an earlier
 * exclusion).
 *
 * `relPath` must use forward slashes and be relative to the directory
 * that owns `rules`.
 */
export function shouldIgnore(
  relPath: string,
  rules: readonly IgnoreRule[],
  opts: { readonly isDirectory?: boolean } = {},
): boolean {
  const isDir = opts.isDirectory === true;
  let ignored = false;
  for (const rule of rules) {
    if (rule.directoryOnly && !isDir) continue;
    if (rule.regex.test(relPath)) {
      ignored = !rule.negate;
    }
  }
  return ignored;
}

/**
 * Load the root `.gitignore` (if any) into a chain keyed by directory
 * path. At MVP we only honor the repo-root file; future waves may walk
 * subdirectories and merge layered rule sets.
 */
export async function loadGitignoreChain(
  repoPath: string,
): Promise<Readonly<Record<string, IgnoreRule[]>>> {
  const chain: Record<string, IgnoreRule[]> = {};
  const rootIgnore = path.join(repoPath, ".gitignore");
  try {
    const content = await fs.readFile(rootIgnore, "utf8");
    chain[""] = parseGitignore(content);
  } catch {
    // File missing is fine — just no rules at the root.
    chain[""] = [];
  }
  return chain;
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
