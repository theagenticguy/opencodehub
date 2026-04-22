/**
 * MCP / JSON-RPC tool detector.
 *
 * The heuristic is intentionally coarse: many agent frameworks (MCP, LangChain
 * tools, OpenAI function schemas) converge on a `{ name, description, ... }`
 * object literal for each tool. At MVP we only claim a match when the file
 * path *also* signals "tool-ness", which eliminates the majority of false
 * positives coming from generic config blocks.
 *
 * Pattern authored fresh — no upstream regex reused.
 */

import type { ExtractedTool, ExtractInput } from "./types.js";

/** Path-based gate: file must look like a tool definition. */
function filePathLooksLikeTool(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  if (normalized.includes("/tool")) return true;
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  // `*-tool.ts`, `*_tool.ts`, or `*tool*.ts` (and JS/MJS siblings).
  if (/(^|[-_])tool([-_.]|s?\.)/.test(basename)) return true;
  if (/tool/.test(basename)) return true;
  return false;
}

/** A string-valued key followed by a string literal, captured with its line. */
interface StringKeyHit {
  readonly line: number;
  readonly value: string;
}

/**
 * Match `name: "..."`, `"name": '...'`, `name: \`...\`` (no interpolation).
 * The key itself is captured so the same regex can harvest `description:`.
 */
const STRING_PROP_RE =
  /(?:^|[\s,{(])(?:"([a-zA-Z_][\w]*)"|'([a-zA-Z_][\w]*)'|([a-zA-Z_][\w]*))\s*:\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`$]*)`)/g;

function collectStringProps(content: string, keyName: string): readonly StringKeyHit[] {
  const hits: StringKeyHit[] = [];
  STRING_PROP_RE.lastIndex = 0;
  let match: RegExpExecArray | null = STRING_PROP_RE.exec(content);
  while (match !== null) {
    const key = match[1] ?? match[2] ?? match[3];
    const value = match[4] ?? match[5] ?? match[6];
    const idx = match.index;
    match = STRING_PROP_RE.exec(content);
    if (key !== keyName || value === undefined) continue;
    // Count newlines in prefix to convert byte-offset -> 1-based line number.
    let line = 1;
    for (let i = 0; i < idx; i++) {
      if (content.charCodeAt(i) === 10) line += 1;
    }
    hits.push({ line, value });
  }
  return hits;
}

/**
 * Emit one `ExtractedTool` per `{ name, description }` literal pair found in
 * the same 5-line window. Duplicates (same `toolName` + `description`) are
 * de-duplicated per file; cross-file de-duplication is a later phase concern.
 */
export function detectMcpTools(input: ExtractInput): readonly ExtractedTool[] {
  const { filePath, content } = input;
  if (!filePathLooksLikeTool(filePath)) return [];
  if (!/\bname\b/.test(content) || !/\bdescription\b/.test(content)) return [];

  const names = collectStringProps(content, "name");
  const descriptions = collectStringProps(content, "description");
  if (names.length === 0 || descriptions.length === 0) return [];

  const seen = new Set<string>();
  const out: ExtractedTool[] = [];
  for (const name of names) {
    // Pick the nearest description within 5 lines in either direction.
    let best: StringKeyHit | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const desc of descriptions) {
      const distance = Math.abs(desc.line - name.line);
      if (distance <= 5 && distance < bestDistance) {
        best = desc;
        bestDistance = distance;
      }
    }
    if (best === undefined) continue;
    const key = `${name.value}\u0000${best.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      toolName: name.value,
      handlerFile: filePath,
      description: best.value,
    });
  }
  return out;
}
