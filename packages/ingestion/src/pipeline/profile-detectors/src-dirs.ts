/**
 * Source-directory detection.
 *
 * Heuristic: walk the top 2 levels of the repo. A directory qualifies as a
 * "src dir" when it contains > 10 code files directly underneath (recursive
 * descendants count). Common build/cache/vcs folders are excluded via a
 * stop-list so we don't return `node_modules`, `.git`, or `dist`.
 *
 * The scan phase has already applied the repo's gitignore so most noise is
 * filtered before this point, but the stop-list is still applied
 * defensively.
 *
 * Determinism: output is sorted alphabetically.
 */

import type { LanguageId } from "../../parse/types.js";
import type { ScannedFile } from "../phases/scan.js";

const STOP_LIST: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "target",
  "build",
  "dist",
  "__pycache__",
  ".next",
  ".turbo",
  ".nuxt",
  "vendor",
  ".tox",
  "coverage",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".idea",
  ".vscode",
]);

const MIN_CODE_FILES = 10;

/** Two-level ancestor directories for a relative path, or `undefined`. */
function topLevelAncestors(relPath: string): readonly string[] {
  const parts = relPath.split("/");
  if (parts.length < 2) return [];
  const out: string[] = [];
  // Level 1 — first segment
  const first = parts[0];
  if (first !== undefined && first !== "") out.push(first);
  // Level 2 — first two segments joined
  if (parts.length >= 3) {
    const second = parts[1];
    if (first !== undefined && second !== undefined && first !== "" && second !== "") {
      out.push(`${first}/${second}`);
    }
  }
  return out;
}

function isStopListed(dirPath: string): boolean {
  // Reject the dir if any segment appears in the stop list. This matches
  // ".venv/bin" as well as plain "node_modules".
  for (const seg of dirPath.split("/")) {
    if (STOP_LIST.has(seg)) return true;
  }
  return false;
}

function looksLikeCodeFile(lang: LanguageId | undefined): boolean {
  return lang !== undefined;
}

export function detectSrcDirs(files: readonly ScannedFile[]): readonly string[] {
  if (files.length === 0) return [];

  const counts = new Map<string, number>();
  for (const f of files) {
    if (!looksLikeCodeFile(f.language)) continue;
    for (const dir of topLevelAncestors(f.relPath)) {
      if (isStopListed(dir)) continue;
      counts.set(dir, (counts.get(dir) ?? 0) + 1);
    }
  }

  const out: string[] = [];
  for (const [dir, count] of counts) {
    if (count > MIN_CODE_FILES) out.push(dir);
  }
  out.sort();
  return out;
}
