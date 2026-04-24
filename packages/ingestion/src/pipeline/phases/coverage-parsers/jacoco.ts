/**
 * JaCoCo XML parser.
 *
 * JaCoCo's XML report tree:
 *   <report>
 *     <package name="com/foo">
 *       <sourcefile name="Bar.java">
 *         <line nr="12" mi="0" ci="3" mb="0" cb="0"/>
 *         ...
 *       </sourcefile>
 *
 * Per the JaCoCo DTD, `mi` is missed-instructions, `ci` is covered-
 * instructions. We treat a line as covered when `ci > 0`. Total is the
 * count of `<line>` elements for the sourcefile.
 *
 * Path assembly: the JaCoCo `name` attribute on `<package>` is slash-joined
 * (e.g. `com/foo`), and the `<sourcefile>` name is the basename. We join
 * them into a single POSIX path for graph matching. Callers may additionally
 * set a project-source-root prefix via `options.sourceRoot` so the returned
 * path aligns with the scan output.
 */

import { XMLParser } from "fast-xml-parser";
import { canonLines, type FileCoverage, ratio } from "./types.js";

export interface JacocoOptions {
  /**
   * Optional repo-relative prefix to prepend when assembling the source path
   * (e.g. `src/main/java`). Defaults to the empty string because JaCoCo's
   * report layout varies by build tool.
   */
  readonly sourceRoot?: string;
}

export function parseJacoco(
  raw: string,
  _repoRoot: string,
  options: JacocoOptions = {},
): ReadonlyMap<string, FileCoverage> {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    isArray: (name) => name === "package" || name === "sourcefile" || name === "line",
  });
  let parsed: unknown;
  try {
    parsed = parser.parse(raw);
  } catch {
    return new Map();
  }

  const out = new Map<string, FileCoverage>();
  const report = (parsed as { report?: unknown })?.report;
  const packages = (report as { package?: unknown[] })?.package;
  if (!Array.isArray(packages)) return out;
  const sourceRoot = options.sourceRoot ?? "";

  for (const pkg of packages) {
    const pkgName =
      typeof (pkg as Record<string, unknown>)["@_name"] === "string"
        ? String((pkg as Record<string, unknown>)["@_name"])
        : "";
    const sourcefiles = (pkg as { sourcefile?: unknown[] })?.sourcefile;
    if (!Array.isArray(sourcefiles)) continue;
    for (const sf of sourcefiles) {
      const sfName = (sf as Record<string, unknown>)["@_name"];
      if (typeof sfName !== "string" || sfName.length === 0) continue;
      const lines = (sf as { line?: unknown[] })?.line;
      if (!Array.isArray(lines) || lines.length === 0) continue;
      let covered = 0;
      const coveredLines: number[] = [];
      let total = 0;
      for (const l of lines) {
        const rec = l as Record<string, unknown>;
        const nr = numberAttr(rec["@_nr"]);
        const ci = numberAttr(rec["@_ci"]) ?? 0;
        if (nr === undefined) continue;
        total += 1;
        if (ci > 0) {
          covered += 1;
          coveredLines.push(nr);
        }
      }
      if (total === 0) continue;
      const relPath = joinPath(sourceRoot, pkgName, sfName);
      out.set(relPath, {
        filePath: relPath,
        coveredLines: canonLines(coveredLines),
        totalLines: total,
        coveragePercent: ratio(covered, total),
      });
    }
  }
  return out;
}

function numberAttr(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const n = Number.parseInt(v, 10);
    return Number.isInteger(n) ? n : undefined;
  }
  return undefined;
}

function joinPath(root: string, pkg: string, file: string): string {
  const segs = [root, pkg, file].filter((s) => s.length > 0);
  return segs.join("/").replace(/\/+/g, "/");
}
