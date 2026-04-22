/**
 * Shared helpers used by per-language extractors.
 *
 * Kept intentionally generic: none of these functions know about a specific
 * language's grammar. Per-language providers feed them filtered subsets of
 * {@link ParseCapture} and receive back plain records.
 */

import type { ParseCapture } from "../parse/types.js";

/** One definition capture plus its inner `@name` capture (resolved by range). */
export interface PairedDefinition {
  readonly def: ParseCapture;
  readonly name: ParseCapture;
}

/**
 * Pair every `@definition.*` capture with the `@name` capture that lies
 * within its source range. Robust against match reordering: we use
 * positional containment rather than list adjacency.
 *
 * When multiple `@name` captures fall inside a single definition range
 * (e.g. a class body with methods), we pick the earliest `@name` whose
 * start line matches the definition's start line. Falls back to the
 * first inner `@name`.
 */
export function pairDefinitionsWithNames(
  captures: readonly ParseCapture[],
  defTagPrefix = "definition.",
): readonly PairedDefinition[] {
  const defs = captures.filter((c) => c.tag.startsWith(defTagPrefix));

  // Build the set of source positions that are ALSO tagged as a reference.
  // A `@name` that coincides with a `@reference.*` capture is almost always
  // a referenced type identifier (e.g. the receiver type in a Go method)
  // rather than the identifier we want to bind to the definition.
  const referencePositions = new Set<string>();
  for (const c of captures) {
    if (c.tag.startsWith("reference.")) {
      referencePositions.add(positionKey(c));
    }
  }
  // Deduplicate `@name` captures at the same source position — tree-sitter
  // can emit the same node under multiple patterns.
  const uniqueNames = dedupeByPosition(captures.filter((c) => c.tag === "name"));
  const declarationNames = uniqueNames.filter((c) => !referencePositions.has(positionKey(c)));

  const paired: PairedDefinition[] = [];
  for (const def of defs) {
    // Priority 1: a declaration name (not coinciding with a reference) on
    // the def's header line. This correctly picks `Greet` out of
    // `func (g *Greeter) Greet(...)` — `Greeter` is a reference-typed
    // identifier, `Greet` is the declaration.
    const headerDecls = declarationNames.filter(
      (n) => n.startLine === def.startLine && isInside(n, def),
    );
    if (headerDecls.length > 0) {
      // Earliest column — definitions tend to have their name earlier than
      // any trailing parameter identifiers on the same line.
      const sorted = [...headerDecls].sort((a, b) => a.startCol - b.startCol);
      paired.push({ def, name: sorted[0] as ParseCapture });
      continue;
    }

    // Priority 2: any name on the header line (recovers class/interface
    // declarations whose name is tagged with a `@reference.type` overlay).
    const headerNames = uniqueNames.filter(
      (n) => n.startLine === def.startLine && isInside(n, def),
    );
    if (headerNames.length > 0) {
      const sorted = [...headerNames].sort((a, b) => a.startCol - b.startCol);
      paired.push({ def, name: sorted[0] as ParseCapture });
      continue;
    }

    // Priority 3: declaration names anywhere inside the def range. Handles
    // module-scope `@definition.*` captures that span the whole file.
    let best = pickBestName(def, declarationNames);
    // Priority 4: fall back to any name at all.
    if (best === undefined) {
      best = pickBestName(def, uniqueNames);
    }
    if (best !== undefined) {
      paired.push({ def, name: best });
    }
  }
  return paired;
}

function pickBestName(
  def: ParseCapture,
  candidates: readonly ParseCapture[],
): ParseCapture | undefined {
  let best: ParseCapture | undefined;
  for (const n of candidates) {
    if (!isInside(n, def)) continue;
    if (best === undefined) {
      best = n;
      continue;
    }
    const bestAtHeader = best.startLine === def.startLine;
    const candAtHeader = n.startLine === def.startLine;
    if (candAtHeader && !bestAtHeader) {
      best = n;
    } else if (candAtHeader === bestAtHeader) {
      if (
        n.startLine < best.startLine ||
        (n.startLine === best.startLine && n.startCol < best.startCol)
      ) {
        best = n;
      }
    }
  }
  return best;
}

function dedupeByPosition(captures: readonly ParseCapture[]): ParseCapture[] {
  const seen = new Set<string>();
  const out: ParseCapture[] = [];
  for (const c of captures) {
    const k = positionKey(c);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

function positionKey(c: ParseCapture): string {
  return `${c.startLine}:${c.startCol}:${c.endLine}:${c.endCol}`;
}

/** True if `inner`'s range is inside `outer`'s range. */
export function isInside(inner: ParseCapture, outer: ParseCapture): boolean {
  if (inner.startLine < outer.startLine || inner.endLine > outer.endLine) {
    return false;
  }
  if (inner.startLine === outer.startLine && inner.startCol < outer.startCol) {
    return false;
  }
  if (inner.endLine === outer.endLine && inner.endCol > outer.endCol) {
    return false;
  }
  return true;
}

/**
 * Return the innermost (smallest enclosing) definition that contains `inner`.
 *
 * Skips:
 *  - `inner` itself.
 *  - Any `@definition.module` capture — module/file-scoped defs are logical
 *    containers, not semantic owners.
 *  - Captures with an identical source range to `inner`. A grammar query
 *    can attach multiple `@definition.*` tags to the same node (e.g. a Go
 *    `type_declaration` hitting both `@definition.type` and
 *    `@definition.class`). Those are sibling records, not parent/child.
 */
// Tags that CAN be call-edge endpoints. `definition.property`,
// `definition.variable`, and `definition.constant` are deliberately excluded:
// attributing a call like `x = foo()` inside a class body to the assignment
// target `x` (which would tightly wrap the call site) instead of the
// enclosing method is almost never what callers of impact/context analysis
// want. The enclosing scope is what owns the call.
const CALLABLE_SCOPE_TAGS: ReadonlySet<string> = new Set([
  "definition.class",
  "definition.function",
  "definition.method",
  "definition.constructor",
  "definition.interface",
  "definition.type",
  "definition.trait",
]);

export function innermostEnclosingDef(
  inner: ParseCapture,
  defs: readonly ParseCapture[],
): ParseCapture | undefined {
  let best: ParseCapture | undefined;
  let bestSpan = Infinity;
  for (const d of defs) {
    if (d === inner) continue;
    if (!CALLABLE_SCOPE_TAGS.has(d.tag)) continue;
    if (
      d.startLine === inner.startLine &&
      d.endLine === inner.endLine &&
      d.startCol === inner.startCol &&
      d.endCol === inner.endCol
    ) {
      continue;
    }
    if (!isInside(inner, d)) continue;
    const span = (d.endLine - d.startLine) * 1_000_000 + (d.endCol - d.startCol);
    if (span < bestSpan) {
      best = d;
      bestSpan = span;
    }
  }
  return best;
}

/**
 * Read a single 1-indexed line from `sourceText`. Returns `""` when the
 * line is out of range (defensive against stale captures).
 */
export function getLine(sourceText: string, line1Indexed: number): string {
  if (line1Indexed <= 0) return "";
  // Split lazily: we only call this per-capture, usually small N.
  let current = 1;
  let start = 0;
  for (let i = 0; i < sourceText.length; i += 1) {
    if (sourceText.charCodeAt(i) === 10) {
      if (current === line1Indexed) {
        return sourceText.slice(start, i);
      }
      current += 1;
      start = i + 1;
    }
  }
  if (current === line1Indexed) {
    return sourceText.slice(start);
  }
  return "";
}

/**
 * Strip line + block comments from a source string. Used by import scanners
 * where a commented-out import would otherwise produce a spurious edge.
 *
 * Language-neutral implementation: understands `//` line comments, `/* ...`
 * block comments, and `#` line comments. Leaves string contents alone
 * (tracks single/double/backtick quotes).
 */
export function stripComments(src: string): string {
  const out: string[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    // Block comment
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) break;
      // Preserve newlines so line numbers in later extracts are stable.
      for (let j = i; j < end + 2; j += 1) {
        if (src.charCodeAt(j) === 10) out.push("\n");
      }
      i = end + 2;
      continue;
    }

    // Line comment (`//` or `#`). For `#`, only treat as comment when not
    // part of a `#!` shebang at file start — caller passes stripped text
    // otherwise. We keep the rule simple: both begin a line comment here.
    if ((c === "/" && next === "/") || c === "#") {
      while (i < n && src.charCodeAt(i) !== 10) i += 1;
      continue;
    }

    // Strings: skip the body verbatim, honoring escape sequences.
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out.push(c);
      i += 1;
      while (i < n) {
        const ch = src[i];
        out.push(ch as string);
        if (ch === "\\" && i + 1 < n) {
          // Preserve the escaped char.
          out.push(src[i + 1] as string);
          i += 2;
          continue;
        }
        i += 1;
        if (ch === quote) break;
      }
      continue;
    }

    out.push(c as string);
    i += 1;
  }
  return out.join("");
}

/**
 * Split a `foo, bar as baz, qux` list into per-entry records.
 * Used by TS/JS named-import parsing.
 */
export interface NamedImportEntry {
  readonly name: string;
  readonly alias?: string;
}
export function splitNamedImports(body: string): readonly NamedImportEntry[] {
  const parts = body
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const out: NamedImportEntry[] = [];
  for (const p of parts) {
    const m = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(p);
    if (m === null) continue;
    const name = m[1] as string;
    const alias = m[2];
    out.push(alias !== undefined ? { name, alias } : { name });
  }
  return out;
}
