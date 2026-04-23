import type { NodeKind } from "@opencodehub/core-types";
import type { ParseCapture } from "../parse/types.js";
import {
  getLine,
  innermostEnclosingDef,
  isInside,
  pairDefinitionsWithNames,
} from "./extract-helpers.js";
import type {
  ExtractedCall,
  ExtractedDefinition,
  ExtractedHeritage,
  ExtractedImport,
} from "./extraction-types.js";
import type {
  ExtractCallsInput,
  ExtractDefinitionsInput,
  ExtractHeritageInput,
  ExtractImportsInput,
  LanguageProvider,
} from "./types.js";

/**
 * C provider.
 *
 * Definitions: functions, typedefs, structs, unions, enums, static variables,
 * macro definitions. The grammar tags `struct_specifier`/`union_specifier`
 * with `@definition.class` and uses `@definition.type` for `typedef` and
 * `enum_specifier`.
 *
 * Calls: `call_expression` with a bare identifier callee. Qualified calls
 * (e.g. `namespace::foo()`) are a C++ concept — not applicable here.
 *
 * Imports: `#include` directives — system headers (`<h>`) and user headers
 * (`"h"`) are both treated as `package-wildcard` imports at MVP.
 *
 * Heritage: C has no inheritance, so this is always `[]`.
 *
 * Exports: at MVP we treat `static` identifiers (file-scoped) as not
 * exported; everything else is. We use the header line of the definition
 * to check for the `static` storage-class specifier.
 */

const C_DEF_KIND_MAP: Readonly<Record<string, NodeKind>> = {
  "definition.function": "Function",
  "definition.class": "Struct",
  "definition.type": "Typedef",
  "definition.enum": "Enum",
  "definition.union": "Union",
  "definition.constant": "Const",
  "definition.macro": "Macro",
};

function extractCDefinitions(input: ExtractDefinitionsInput): readonly ExtractedDefinition[] {
  const { filePath, captures, sourceText } = input;
  const paired = pairDefinitionsWithNames(captures);
  const defCaptures = captures.filter((c) => c.tag.startsWith("definition."));
  const out: ExtractedDefinition[] = [];

  for (const { def, name } of paired) {
    const kind = C_DEF_KIND_MAP[def.tag];
    if (kind === undefined) continue;

    let owner: string | undefined;
    const ownerDef = innermostEnclosingDef(def, defCaptures);
    if (ownerDef !== undefined) {
      const ownerPaired = paired.find((p) => p.def === ownerDef);
      if (ownerPaired !== undefined) owner = ownerPaired.name.text;
    }

    const qualifiedName = owner !== undefined ? `${owner}.${name.text}` : name.text;
    const headerLine = getLine(sourceText, def.startLine);
    const isStatic = /\bstatic\b/.test(headerLine);
    // C convention: identifiers prefixed with `_` tend to be internal; we
    // respect both `static` and leading-underscore as non-exported.
    const isExported = !isStatic && !name.text.startsWith("_");

    out.push({
      kind,
      name: name.text,
      qualifiedName,
      filePath,
      startLine: def.startLine,
      endLine: def.endLine,
      isExported,
      ...(owner !== undefined ? { owner } : {}),
    });
  }
  return out;
}

function extractCCalls(input: ExtractCallsInput): readonly ExtractedCall[] {
  const { filePath, captures, definitions } = input;
  const defCaptures = captures.filter((c) => c.tag.startsWith("definition."));
  const callRefs = captures.filter((c) => c.tag === "reference.call");
  const out: ExtractedCall[] = [];

  for (const ref of callRefs) {
    const innerName = findNameInside(captures, ref);
    const calleeName = innerName?.text ?? ref.text;

    const enclosingDef = innermostEnclosingDef(ref, defCaptures);
    const callerQualifiedName = enclosingDef
      ? qualifiedForCapture(enclosingDef, definitions)
      : "<module>";

    out.push({
      callerQualifiedName,
      calleeName,
      filePath,
      startLine: ref.startLine,
    });
  }
  return out;
}

function findNameInside(
  captures: readonly ParseCapture[],
  outer: ParseCapture,
): ParseCapture | undefined {
  let best: ParseCapture | undefined;
  for (const c of captures) {
    if (c.tag !== "name") continue;
    if (!isInside(c, outer)) continue;
    if (best === undefined || c.startLine < best.startLine) best = c;
  }
  return best;
}

function qualifiedForCapture(
  def: ParseCapture,
  definitions: readonly ExtractedDefinition[],
): string {
  for (const d of definitions) {
    if (d.startLine === def.startLine) return d.qualifiedName;
  }
  return "<module>";
}

/**
 * Parse `#include` directives. Covers both forms:
 *   `#include <stdio.h>`   system headers
 *   `#include "local.h"`   user headers
 *
 * The quoted form may appear in `localAlias` in future revisions; today we
 * just record the raw path. `kind` is `package-wildcard` since an include
 * pulls in every symbol exposed by the header.
 */
function extractCImports(input: ExtractImportsInput): readonly ExtractedImport[] {
  const { filePath, sourceText } = input;
  // We deliberately avoid the shared `stripComments` helper — it treats `#`
  // as a line-comment starter (Python/Ruby/shell convention), which would
  // eat `#include` directives. `//` and `/* */` are handled by the regex
  // itself: an include line must start with `#include` before any comment.
  const stripped = stripCStyleComments(sourceText);
  const out: ExtractedImport[] = [];

  // System includes: #include <path>
  const systemRe = /^\s*#\s*include\s+<([^>]+)>/gm;
  for (const m of stripped.matchAll(systemRe)) {
    out.push({ filePath, source: m[1] as string, kind: "package-wildcard" });
  }
  // User includes: #include "path"
  const userRe = /^\s*#\s*include\s+"([^"]+)"/gm;
  for (const m of stripped.matchAll(userRe)) {
    out.push({ filePath, source: m[1] as string, kind: "package-wildcard" });
  }
  return out;
}

/**
 * Strip C-style line and block comments without touching `#` — which is
 * a preprocessor sigil, not a comment.
 */
function stripCStyleComments(src: string): string {
  // Replace block comments with spaces to preserve line numbers.
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, " "));
  out = out.replace(/\/\/[^\n]*/g, "");
  return out;
}

function extractCHeritage(_input: ExtractHeritageInput): readonly ExtractedHeritage[] {
  return [];
}

export const cProvider: LanguageProvider = {
  id: "c",
  extensions: [".c", ".h"],
  importSemantics: "named",
  mroStrategy: "none",
  typeConfig: { structural: false, nominal: true, generics: false },
  heritageEdge: null,
  isExportedIdentifier: (name) => !name.startsWith("_"),

  extractDefinitions: extractCDefinitions,
  extractCalls: extractCCalls,
  extractImports: extractCImports,
  isExported: (def) => def.isExported,
  extractHeritage: extractCHeritage,
};
