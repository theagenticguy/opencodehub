/**
 * lcov.info parser (Stream Q.2).
 *
 * lcov trace files are newline-delimited records grouped into per-file blocks:
 *   SF:<source file path>
 *   DA:<line>,<hit count>[,<md5>]
 *   ...
 *   end_of_record
 *
 * A file's covered-lines set is every DA line whose hit count > 0. We ignore
 * the optional line-hash trailing field because it is irrelevant to the
 * coverage ratio.
 *
 * Path resolution: lcov records may carry either relative or absolute paths.
 * When the path is absolute and starts with `repoRoot`, we strip the prefix
 * so the phase can match against scan output (repo-relative POSIX paths).
 * Otherwise we pass the path through unchanged.
 */

import path from "node:path";
import { canonLines, type FileCoverage, ratio } from "./types.js";

export function parseLcov(raw: string, repoRoot: string): ReadonlyMap<string, FileCoverage> {
  const out = new Map<string, FileCoverage>();
  let currentFile: string | undefined;
  let covered = 0;
  let total = 0;
  let lines: number[] = [];

  const reset = (): void => {
    currentFile = undefined;
    covered = 0;
    total = 0;
    lines = [];
  };

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith("SF:")) {
      currentFile = normalisePath(line.slice(3).trim(), repoRoot);
      covered = 0;
      total = 0;
      lines = [];
      continue;
    }
    if (line.startsWith("DA:")) {
      if (currentFile === undefined) continue;
      const rest = line.slice(3);
      const comma = rest.indexOf(",");
      if (comma === -1) continue;
      const lineNum = Number.parseInt(rest.slice(0, comma), 10);
      // Hit count may be followed by an extra `,md5`. Parse only up to the
      // next comma or end-of-line.
      const tail = rest.slice(comma + 1);
      const nextComma = tail.indexOf(",");
      const hitStr = nextComma === -1 ? tail : tail.slice(0, nextComma);
      const hits = Number.parseInt(hitStr, 10);
      if (!Number.isInteger(lineNum) || !Number.isInteger(hits)) continue;
      total += 1;
      if (hits > 0) {
        covered += 1;
        lines.push(lineNum);
      }
      continue;
    }
    if (line === "end_of_record") {
      if (currentFile !== undefined && total > 0) {
        const clean = canonLines(lines);
        out.set(currentFile, {
          filePath: currentFile,
          coveredLines: clean,
          totalLines: total,
          coveragePercent: ratio(covered, total),
        });
      }
      reset();
    }
  }

  // Trailing block without `end_of_record` still matters — flush it.
  if (currentFile !== undefined && total > 0) {
    const clean = canonLines(lines);
    out.set(currentFile, {
      filePath: currentFile,
      coveredLines: clean,
      totalLines: total,
      coveragePercent: ratio(covered, total),
    });
  }

  return out;
}

function normalisePath(raw: string, repoRoot: string): string {
  // Always emit POSIX forward slashes so downstream matching against scan
  // output (which uses POSIX separators) works on every platform.
  const posix = raw.replace(/\\/g, "/");
  if (!path.isAbsolute(posix)) return posix;
  const rootPosix = repoRoot.replace(/\\/g, "/");
  const prefix = rootPosix.endsWith("/") ? rootPosix : `${rootPosix}/`;
  if (posix.startsWith(prefix)) return posix.slice(prefix.length);
  return posix;
}
