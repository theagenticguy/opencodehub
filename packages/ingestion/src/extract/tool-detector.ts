/**
 * MCP / JSON-RPC tool detector.
 *
 * The heuristic is intentionally coarse: many agent frameworks (MCP, LangChain
 * tools, OpenAI function schemas) converge on a `{ name, description, ... }`
 * object literal for each tool. At MVP we only claim a match when the file
 * path *also* signals "tool-ness", which eliminates the majority of false
 * positives coming from generic config blocks.
 *
 * Pattern authored fresh — no external regex reused.
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
 * Match `inputSchema:` followed by a `{ ... }` object literal. The capture
 * begins at the opening brace; the closing brace is resolved by
 * {@link findBalancedObjectEnd} so nested objects and strings don't confuse
 * the match.
 */
const INPUT_SCHEMA_RE = /(?:^|[\s,{(])(?:"inputSchema"|'inputSchema'|inputSchema)\s*:\s*\{/g;

interface InputSchemaHit {
  readonly line: number;
  readonly rawObjectLiteral: string;
}

function collectInputSchemaLiterals(content: string): readonly InputSchemaHit[] {
  const hits: InputSchemaHit[] = [];
  INPUT_SCHEMA_RE.lastIndex = 0;
  let match: RegExpExecArray | null = INPUT_SCHEMA_RE.exec(content);
  while (match !== null) {
    const openBrace = match.index + match[0].length - 1;
    const close = findBalancedObjectEnd(content, openBrace);
    const idx = match.index;
    // Resume scanning after the open brace so a malformed literal cannot
    // wedge the loop.
    INPUT_SCHEMA_RE.lastIndex = openBrace + 1;
    match = INPUT_SCHEMA_RE.exec(content);
    if (close === -1) continue;
    const rawObjectLiteral = content.slice(openBrace, close + 1);
    let line = 1;
    for (let i = 0; i < idx; i++) {
      if (content.charCodeAt(i) === 10) line += 1;
    }
    hits.push({ line, rawObjectLiteral });
  }
  return hits;
}

/**
 * Walk forward from `start` (pointing at `{`) and return the index of the
 * matching `}`, or -1 when the brace is unbalanced / the source runs out.
 * Single-, double-, and backtick-string literals are skipped so a brace
 * inside a string doesn't fool depth counting.
 */
function findBalancedObjectEnd(source: string, start: number): number {
  if (source.charCodeAt(start) !== 0x7b /* { */) return -1;
  let depth = 0;
  let i = start;
  const n = source.length;
  while (i < n) {
    const ch = source.charCodeAt(i);
    if (ch === 0x22 /* " */ || ch === 0x27 /* ' */ || ch === 0x60 /* ` */) {
      const next = skipString(source, i, ch);
      if (next === -1) return -1;
      i = next;
      continue;
    }
    if (ch === 0x7b /* { */) {
      depth += 1;
    } else if (ch === 0x7d /* } */) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

function skipString(source: string, start: number, quote: number): number {
  const n = source.length;
  let i = start + 1;
  while (i < n) {
    const ch = source.charCodeAt(i);
    if (ch === 0x5c /* \ */) {
      // Skip escape sequence (conservatively consume one trailing char).
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    i += 1;
  }
  return -1;
}

/**
 * Translate an object literal written in relaxed JS syntax (single quotes,
 * unquoted keys, trailing commas) into strict canonical JSON sorted by key.
 * Returns `undefined` when the literal is too exotic to normalize safely
 * (template strings, bareword values, computed keys).
 */
export function canonicalizeObjectLiteral(literal: string): string | undefined {
  const jsonLike = relaxedToJson(literal);
  if (jsonLike === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonLike);
  } catch {
    return undefined;
  }
  return stableStringify(parsed);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * Rewrite a JS-ish object/array literal so `JSON.parse` accepts it:
 *   - single-quoted strings to double-quoted.
 *   - unquoted identifier keys to double-quoted keys.
 *   - trailing commas stripped.
 * Template strings and bareword values produce `undefined` so the caller
 * falls back to "no schema captured".
 */
function relaxedToJson(literal: string): string | undefined {
  let out = "";
  let i = 0;
  const n = literal.length;
  while (i < n) {
    const ch = literal[i];
    if (ch === '"') {
      const end = findStringEnd(literal, i, 0x22);
      if (end === -1) return undefined;
      out += literal.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === "'") {
      const end = findStringEnd(literal, i, 0x27);
      if (end === -1) return undefined;
      const inner = literal
        .slice(i + 1, end)
        .replace(/\\'/g, "'")
        .replace(/"/g, '\\"');
      out += `"${inner}"`;
      i = end + 1;
      continue;
    }
    if (ch === "`") return undefined;
    if (ch !== undefined && /[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < n) {
        const cj = literal[j];
        if (cj === undefined || !/[A-Za-z0-9_$]/.test(cj)) break;
        j += 1;
      }
      const ident = literal.slice(i, j);
      if (ident === "true" || ident === "false" || ident === "null") {
        out += ident;
        i = j;
        continue;
      }
      let k = j;
      while (k < n && /\s/.test(literal[k] ?? "")) k += 1;
      if (literal[k] === ":") {
        out += `"${ident}"`;
        i = j;
        continue;
      }
      return undefined;
    }
    if (ch === ",") {
      let k = i + 1;
      while (k < n && /\s/.test(literal[k] ?? "")) k += 1;
      const next = literal[k];
      if (next === "}" || next === "]") {
        i = k;
        continue;
      }
    }
    out += ch ?? "";
    i += 1;
  }
  return out;
}

function findStringEnd(src: string, start: number, quote: number): number {
  let i = start + 1;
  const n = src.length;
  while (i < n) {
    const ch = src.charCodeAt(i);
    if (ch === 0x5c /* \ */) {
      i += 2;
      continue;
    }
    if (ch === quote) return i;
    i += 1;
  }
  return -1;
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

  const schemas = collectInputSchemaLiterals(content);

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
    // Pair the nearest inputSchema literal within a 10-line window. Schemas
    // often live a few lines below the name/description pair so we allow a
    // wider span than description pairing.
    let bestSchema: InputSchemaHit | undefined;
    let bestSchemaDistance = Number.POSITIVE_INFINITY;
    for (const s of schemas) {
      const distance = Math.abs(s.line - name.line);
      if (distance <= 10 && distance < bestSchemaDistance) {
        bestSchema = s;
        bestSchemaDistance = distance;
      }
    }
    const inputSchemaJson =
      bestSchema !== undefined ? canonicalizeObjectLiteral(bestSchema.rawObjectLiteral) : undefined;
    out.push({
      toolName: name.value,
      handlerFile: filePath,
      description: best.value,
      ...(inputSchemaJson !== undefined ? { inputSchemaJson } : {}),
    });
  }
  return out;
}
