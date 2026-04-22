/**
 * Language detection — counts scanned files per extension and emits the
 * languages that clear either threshold:
 *   - ≥ 5 files of that language, OR
 *   - ≥ 1% of the total scanned files.
 *
 * The scan phase already attaches a `LanguageId` to every file whose
 * extension resolves to one of the MVP tree-sitter grammars; we lift those
 * into language *names* here (spelled-out keys for the ProjectProfile
 * schema) so downstream scanners can match on strings like "typescript"
 * or "python" without having to learn about `LanguageId`.
 *
 * Determinism: sorted by (count desc, name asc). Tied file counts keep
 * deterministic output across runs.
 */

import type { LanguageId } from "../../parse/types.js";
import type { ScannedFile } from "../phases/scan.js";

const LANGUAGE_NAME_BY_ID: Readonly<Record<LanguageId, string>> = {
  typescript: "typescript",
  tsx: "typescript",
  javascript: "javascript",
  python: "python",
  go: "go",
  rust: "rust",
  java: "java",
  csharp: "csharp",
  // W2-C.1: names used by the ProjectProfile schema + downstream scanners.
  c: "c",
  cpp: "cpp",
  ruby: "ruby",
  kotlin: "kotlin",
  swift: "swift",
  php: "php",
  dart: "dart",
};

export function detectLanguages(files: readonly ScannedFile[]): readonly string[] {
  if (files.length === 0) return [];

  const total = files.length;
  const counts = new Map<string, number>();
  for (const f of files) {
    if (f.language === undefined) continue;
    const name = LANGUAGE_NAME_BY_ID[f.language];
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  const onePctThreshold = Math.max(1, Math.ceil(total * 0.01));
  const qualifying: Array<[string, number]> = [];
  for (const [name, count] of counts) {
    if (count >= 5 || count >= onePctThreshold) {
      qualifying.push([name, count]);
    }
  }

  qualifying.sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });

  return qualifying.map(([name]) => name);
}
