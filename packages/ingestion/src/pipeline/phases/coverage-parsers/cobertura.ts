/**
 * Cobertura coverage.xml parser.
 *
 * Cobertura / Python coverage-xml reports nest per-file coverage under:
 *   <coverage>
 *     <packages>
 *       <package>
 *         <classes>
 *           <class filename="src/foo.py">
 *             <lines>
 *               <line number="1" hits="2"/>
 *               <line number="2" hits="0"/>
 *             </lines>
 *           </class>
 *
 * The phase uses `fast-xml-parser` (already a dep). We set
 * `ignoreAttributes=false` so the `number`/`hits`/`filename` attributes are
 * reachable via the attribute-prefix key (`@_`).
 *
 * Determinism: the parser returns a map, which the calling phase sorts
 * before mutating the graph.
 */

import { XMLParser } from "fast-xml-parser";
import { canonLines, type FileCoverage, ratio } from "./types.js";

interface ClassEntry {
  readonly filename?: string;
  readonly lines?: readonly { readonly line: number; readonly hits: number }[];
}

export function parseCobertura(raw: string, repoRoot: string): ReadonlyMap<string, FileCoverage> {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    // Force singletons into arrays where we walk over them.
    isArray: (name) =>
      name === "package" ||
      name === "class" ||
      name === "line" ||
      name === "packages" ||
      name === "classes" ||
      name === "lines",
  });
  let parsed: unknown;
  try {
    parsed = parser.parse(raw);
  } catch {
    return new Map();
  }

  const classes = collectClasses(parsed);
  const out = new Map<string, FileCoverage>();
  for (const c of classes) {
    const filename = c.filename;
    if (filename === undefined || filename.length === 0) continue;
    const linesIn = c.lines ?? [];
    if (linesIn.length === 0) continue;
    let covered = 0;
    const coveredLines: number[] = [];
    for (const line of linesIn) {
      if (line.hits > 0) {
        covered += 1;
        coveredLines.push(line.line);
      }
    }
    const total = linesIn.length;
    const relPath = normalisePath(filename, repoRoot);
    out.set(relPath, {
      filePath: relPath,
      coveredLines: canonLines(coveredLines),
      totalLines: total,
      coveragePercent: ratio(covered, total),
    });
  }
  return out;
}

function collectClasses(parsed: unknown): ClassEntry[] {
  const out: ClassEntry[] = [];
  const root = (parsed as { coverage?: unknown })?.coverage;
  const packagesContainer = (root as { packages?: unknown[] })?.packages;
  if (!Array.isArray(packagesContainer)) return out;
  // Each entry inside `packages[]` is itself an object that *may* nest a
  // further `package` array (repeat container). Walk one more level so both
  // shapes work.
  for (const container of packagesContainer) {
    const packages = (container as { package?: unknown[] })?.package;
    if (!Array.isArray(packages)) continue;
    for (const pkg of packages) {
      const classesContainer = (pkg as { classes?: unknown[] })?.classes;
      if (!Array.isArray(classesContainer)) continue;
      for (const cContainer of classesContainer) {
        const classes = (cContainer as { class?: unknown[] })?.class;
        if (!Array.isArray(classes)) continue;
        for (const cls of classes) {
          const filename = (cls as Record<string, unknown>)["@_filename"];
          const linesContainer = (cls as { lines?: unknown[] })?.lines;
          const linesRaw =
            Array.isArray(linesContainer) && linesContainer.length > 0
              ? ((linesContainer[0] as { line?: unknown[] })?.line ?? [])
              : [];
          const entries: { line: number; hits: number }[] = [];
          if (Array.isArray(linesRaw)) {
            for (const lv of linesRaw) {
              const rec = lv as Record<string, unknown>;
              const lineNum = numberAttr(rec["@_number"]);
              const hits = numberAttr(rec["@_hits"]);
              if (lineNum === undefined || hits === undefined) continue;
              entries.push({ line: lineNum, hits });
            }
          }
          out.push({
            ...(typeof filename === "string" ? { filename } : {}),
            lines: entries,
          });
        }
      }
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

function normalisePath(raw: string, repoRoot: string): string {
  const posix = raw.replace(/\\/g, "/");
  if (!posix.startsWith("/")) return posix;
  const rootPosix = repoRoot.replace(/\\/g, "/");
  const prefix = rootPosix.endsWith("/") ? rootPosix : `${rootPosix}/`;
  if (posix.startsWith(prefix)) return posix.slice(prefix.length);
  return posix;
}
