/**
 * Regex fallback — on JVM crash, reparse every file in the failing batch
 * via `parseCobolFile()` from `@opencodehub/ingestion`. The fallback runs
 * silently from the user's perspective (no stderr spam), but every fallback
 * emits a diagnostic note the ingestion phase surfaces as a graph-level
 * marker so curious readers can see which files didn't make it through the
 * ASG.
 *
 * This module is intentionally tiny: it has no JVM, no subprocess, no
 * filesystem writes. Pure functions over `(path, content)`.
 */

import { readFile } from "node:fs/promises";

import { parse as ingestionParse } from "@opencodehub/ingestion";

const { parseCobolFile } = ingestionParse;

import type { CobolDeepElement } from "./types.js";

/**
 * Reparse one file through the regex hot path. Returns an empty array on
 * read failure — the fallback is a best-effort safety net and should never
 * throw in the ingestion path.
 */
export async function fallbackParseFile(
  path: string,
): Promise<{ readonly elements: readonly CobolDeepElement[]; readonly notes: readonly string[] }> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      elements: [],
      notes: [`cobol-proleap fallback: failed to read ${path}: ${message}`],
    };
  }

  const result = parseCobolFile(path, content);
  const elements: CobolDeepElement[] = result.elements.map((el) => ({
    kind: el.kind,
    name: el.name,
    filePath: el.filePath,
    startLine: el.startLine,
    endLine: el.endLine,
    language: el.language,
    confidence: "heuristic",
    ...(el.snippet !== undefined ? { snippet: el.snippet } : {}),
  }));
  const notes = result.diagnostics.map((d) => `cobol-proleap fallback: ${d}`);
  return { elements, notes };
}

/** Reparse many files through the regex hot path. */
export async function fallbackParseBatch(
  paths: readonly string[],
): Promise<{ readonly elements: readonly CobolDeepElement[]; readonly notes: readonly string[] }> {
  const allElements: CobolDeepElement[] = [];
  const allNotes: string[] = [];
  for (const path of paths) {
    const { elements, notes } = await fallbackParseFile(path);
    allElements.push(...elements);
    allNotes.push(...notes);
  }
  return { elements: allElements, notes: allNotes };
}
