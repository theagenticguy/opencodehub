// Rule-file parser for the vendored .tsg Python ruleset.
//
// The .tsg DSL is a mix of tree-sitter S-expression queries and a
// small imperative language for declaring nodes, edges, and attributes.
// We parse only the surface structure we need:
//   * top-level rule blocks: `(pattern) @capture { actions }`
//   * global declarations: `global NAME`, `global NAME = value` (recorded but
//     otherwise ignored — the builder hardcodes Python's needs)
//   * attribute shorthands: `attribute name = ...` (stored raw; the builder
//     references them by name, not by macroexpansion)
//   * actions inside blocks are shallowly tokenised into `node-decl`,
//     `edge-decl`, `attr-decl`, or `unknown` so callers can surface stats.
//
// This is deliberately permissive — constructs we don't understand are
// recorded as `unknown` rather than rejected. The Python evaluator uses
// the rule file primarily as a licence-scoped manifest: our actual path
// construction lives in node-edge-builder.ts and is driven by the
// tree-sitter parse rather than a generic DSL interpreter.

import type { TsgAction, TsgActionKind, TsgMatch, TsgRule } from "./types.js";

/** Strip `;;`-prefixed comments from a line. */
function stripLineComment(line: string): string {
  const idx = line.indexOf(";;");
  if (idx < 0) return line;
  return line.slice(0, idx);
}

/** Scan the opening pattern — everything inside a balanced `(...)` pair. */
function readBalanced(
  source: string,
  start: number,
  open: string,
  close: string,
): { readonly body: string; readonly end: number } | null {
  if (source[start] !== open) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"' && source[i - 1] !== "\\") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        return { body: source.slice(start + 1, i), end: i };
      }
    }
  }
  return null;
}

/** Extract rough tree-sitter pattern info from a parenthesised pattern body. */
function parsePattern(body: string): TsgMatch {
  // The S-expression head token names the node type. Any `@capture` after
  // the closing paren is attached outside by the caller; here we only peek
  // at the very first identifier so callers can group rules by target type.
  const m = /^\s*([A-Za-z_][\w]*)/.exec(body);
  const nodeType = m?.[1] ?? "unknown";
  return { kind: "pattern", nodeType };
}

/** Classify an action line into one of our coarse buckets. */
function classifyAction(raw: string): TsgActionKind {
  const trimmed = raw.trim();
  if (trimmed.startsWith("node ")) return "node-decl";
  if (trimmed.startsWith("edge ")) return "edge-decl";
  if (trimmed.startsWith("attr ") || trimmed.startsWith("attribute ")) return "attr-decl";
  return "unknown";
}

/** Split an action body into individual statements at top-level newlines. */
function splitActions(body: string): readonly string[] {
  // We respect braces — an action like `scan x { ... }` is one statement even
  // though it spans multiple lines. This keeps the `unknown` bucket from
  // exploding.
  const out: string[] = [];
  let buf = "";
  let braceDepth = 0;
  let parenDepth = 0;
  let inString = false;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '"' && body[i - 1] !== "\\") inString = !inString;
    if (!inString) {
      if (ch === "{") braceDepth++;
      else if (ch === "}") braceDepth--;
      else if (ch === "(") parenDepth++;
      else if (ch === ")") parenDepth--;
    }
    buf += ch;
    if (!inString && braceDepth === 0 && parenDepth === 0 && (ch === "\n" || ch === ";")) {
      const cleaned = stripLineComment(buf).trim();
      if (cleaned.length > 0) out.push(cleaned);
      buf = "";
    }
  }
  const tail = stripLineComment(buf).trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

/** Result of parsing a tsg source file. */
export interface ParsedTsg {
  readonly rules: readonly TsgRule[];
  readonly globals: readonly string[];
  readonly attributeShorthands: readonly string[];
  readonly warnings: readonly string[];
}

/** Parse a .tsg source string into a set of rules plus ancillary decls. */
export function parseTsg(source: string): ParsedTsg {
  const rules: TsgRule[] = [];
  const globals: string[] = [];
  const attributeShorthands: string[] = [];
  const warnings: string[] = [];

  let i = 0;
  const n = source.length;

  const skipSpaceAndComments = (): void => {
    while (i < n) {
      const ch = source[i];
      if (ch === undefined) break;
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        i++;
        continue;
      }
      if (ch === ";" && source[i + 1] === ";") {
        while (i < n && source[i] !== "\n") i++;
        continue;
      }
      break;
    }
  };

  while (i < n) {
    skipSpaceAndComments();
    if (i >= n) break;

    // Top-level keywords we track explicitly.
    if (source.startsWith("global", i)) {
      const end = source.indexOf("\n", i);
      const line = source.slice(i, end < 0 ? n : end).trim();
      globals.push(line);
      i = end < 0 ? n : end;
      continue;
    }
    if (source.startsWith("attribute", i)) {
      const end = source.indexOf("\n", i);
      const line = source.slice(i, end < 0 ? n : end).trim();
      attributeShorthands.push(line);
      i = end < 0 ? n : end;
      continue;
    }
    if (source.startsWith("inherit", i)) {
      const end = source.indexOf("\n", i);
      i = end < 0 ? n : end;
      continue;
    }

    // A rule block must start with `(` or `[`.
    const ch = source[i];
    if (ch !== "(" && ch !== "[") {
      // Skip unrecognised tokens to the next newline.
      const end = source.indexOf("\n", i);
      if (end < 0) break;
      i = end + 1;
      continue;
    }

    const patterns: TsgMatch[] = [];
    if (ch === "[") {
      // Multi-pattern rule: `[ pat1 pat2 ... ] @capture { ... }`
      const block = readBalanced(source, i, "[", "]");
      if (block === null) {
        warnings.push(`unterminated '[' at offset ${i}`);
        break;
      }
      // Walk the bracket body picking out each top-level `(...)` pattern.
      let j = 0;
      while (j < block.body.length) {
        const c = block.body[j];
        if (c === undefined) break;
        if (c === " " || c === "\n" || c === "\t" || c === "\r") {
          j++;
          continue;
        }
        if (c === ";" && block.body[j + 1] === ";") {
          while (j < block.body.length && block.body[j] !== "\n") j++;
          continue;
        }
        if (c === "(") {
          const inner = readBalanced(block.body, j, "(", ")");
          if (inner === null) break;
          patterns.push(parsePattern(inner.body));
          j = inner.end + 1;
          continue;
        }
        j++;
      }
      i = block.end + 1;
    } else {
      const pat = readBalanced(source, i, "(", ")");
      if (pat === null) {
        warnings.push(`unterminated '(' at offset ${i}`);
        break;
      }
      patterns.push(parsePattern(pat.body));
      i = pat.end + 1;
    }

    // Skip to the action block `{ ... }` — the `@capture` name, if any, lives
    // between the pattern and the brace; we don't need to retain it.
    while (i < n && source[i] !== "{") {
      if (source[i] === "\n" || source[i] === " " || source[i] === "\t" || source[i] === "@") {
        i++;
        continue;
      }
      if (source[i] === "(") {
        const pred = readBalanced(source, i, "(", ")");
        if (pred === null) break;
        i = pred.end + 1;
        continue;
      }
      // Unknown chars before the block — drift forward rather than abort.
      i++;
    }
    if (source[i] !== "{") {
      warnings.push(`missing action block after pattern at offset ${i}`);
      continue;
    }
    const action = readBalanced(source, i, "{", "}");
    if (action === null) {
      warnings.push(`unterminated action block at offset ${i}`);
      break;
    }
    const statements = splitActions(action.body);
    const actions: TsgAction[] = statements.map((s) => ({
      kind: classifyAction(s),
      raw: s,
    }));
    rules.push({ patterns, actions });
    i = action.end + 1;
  }

  return { rules, globals, attributeShorthands, warnings };
}
