/**
 * Shared TypeScript/TSX extraction logic.
 *
 * Both `.ts` and `.tsx` files share grammar semantics for imports, classes,
 * interfaces, and type aliases — the only difference is JSX parsing, which
 * the parse worker handles by selecting the `tsx` grammar. So both providers
 * delegate to the functions in this file.
 */

import type { NodeKind } from "@opencodehub/core-types";
import type { ParseCapture } from "../parse/types.js";
import {
  getLine,
  innermostEnclosingDef,
  isInside,
  pairDefinitionsWithNames,
  splitNamedImports,
  stripComments,
} from "./extract-helpers.js";
import type {
  ExtractedCall,
  ExtractedDefinition,
  ExtractedHeritage,
  ExtractedImport,
  ImportKind,
} from "./extraction-types.js";
import type {
  ExtractCallsInput,
  ExtractDefinitionsInput,
  ExtractHeritageInput,
  ExtractImportsInput,
} from "./types.js";

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

const TS_DEF_KIND_MAP: Readonly<Record<string, NodeKind>> = {
  "definition.class": "Class",
  "definition.interface": "Interface",
  "definition.function": "Function",
  "definition.method": "Method",
  "definition.type": "TypeAlias",
  "definition.constant": "Const",
  "definition.module": "Namespace",
};

export function extractTsDefinitions(
  input: ExtractDefinitionsInput,
): readonly ExtractedDefinition[] {
  const { filePath, captures, sourceText } = input;
  const paired = pairDefinitionsWithNames(captures);
  const defCaptures = captures.filter((c) => c.tag.startsWith("definition."));
  const out: ExtractedDefinition[] = [];

  for (const { def, name } of paired) {
    const kind = TS_DEF_KIND_MAP[def.tag];
    if (kind === undefined) continue;

    // Derive owner for nested definitions (e.g. methods inside a class).
    const ownerDef = innermostEnclosingDef(def, defCaptures);
    let owner: string | undefined;
    if (ownerDef !== undefined) {
      const ownerPaired = paired.find((p) => p.def === ownerDef);
      if (ownerPaired !== undefined) owner = ownerPaired.name.text;
    }

    const qualifiedName = owner !== undefined ? `${owner}.${name.text}` : name.text;

    // Use the header line for export/declaration analysis.
    const headerLine = getLine(sourceText, def.startLine);
    const exported = isTsDefExported(headerLine, kind, ownerDef !== undefined);

    const rec: ExtractedDefinition = {
      kind,
      name: name.text,
      qualifiedName,
      filePath,
      startLine: def.startLine,
      endLine: def.endLine,
      isExported: exported,
      ...(owner !== undefined ? { owner } : {}),
      ...(kind === "Const" ? { isConst: /\bconst\b/.test(headerLine) } : {}),
    };
    out.push(rec);
  }
  return out;
}

/**
 * TS/JS export detection. A declaration is exported when the header line
 * contains an `export` keyword. For class members the parent's export state
 * controls visibility — downstream phases may re-check via `isExported()`.
 */
function isTsDefExported(headerLine: string, _kind: NodeKind, isNested: boolean): boolean {
  if (isNested) {
    // Method/field visibility is governed by its class, not the member line.
    // Treat as exported when `public` or no explicit modifier (TS default).
    if (/\bprivate\b/.test(headerLine) || /\bprotected\b/.test(headerLine)) return false;
    return true;
  }
  return /\bexport\b/.test(headerLine);
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export function extractTsCalls(input: ExtractCallsInput): readonly ExtractedCall[] {
  const { filePath, captures, definitions } = input;
  const defCaptures = captures.filter((c) => c.tag.startsWith("definition."));
  const callRefs = captures.filter((c) => c.tag === "reference.call");
  const out: ExtractedCall[] = [];

  for (const ref of callRefs) {
    // The `@name` capture sits inside the `@reference.call` range.
    const innerName = findNameInside(captures, ref);
    const calleeName = innerName?.text ?? ref.text;

    const enclosingDef = innermostEnclosingDef(ref, defCaptures);
    const callerQualifiedName = enclosingDef
      ? qualifiedForCapture(enclosingDef, definitions)
      : "<module>";

    // Distinguish `obj.method()` from bare `fn()`: the call capture range
    // starts where the member expression begins, so reading the source line
    // in front of the name lets us infer a receiver.
    const receiver = inferTsReceiver(ref, innerName);

    out.push({
      callerQualifiedName,
      calleeName,
      filePath,
      startLine: ref.startLine,
      ...(receiver !== undefined ? { calleeOwner: receiver } : {}),
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

function inferTsReceiver(ref: ParseCapture, name: ParseCapture | undefined): string | undefined {
  if (name === undefined) return undefined;
  // `ref.text` is the full call expression source (e.g. `this.foo(x)` or
  // `obj.method(y)`). Everything before the last `.` ahead of the callee
  // name is the receiver expression.
  const text = ref.text;
  const nameText = name.text;
  const idx = text.lastIndexOf(`.${nameText}`);
  if (idx <= 0) return undefined;
  const receiverExpr = text.slice(0, idx).trim();
  if (receiverExpr === "") return undefined;
  // We only keep simple receivers (identifiers or `this`). Chained
  // expressions like `a.b.c.method()` surface the full chain — keep the
  // full prefix so downstream typing can further resolve it.
  if (receiverExpr === "this") return "this";
  // A pure identifier receiver is the most common and useful case.
  if (/^[A-Za-z_$][\w$]*$/.test(receiverExpr)) return receiverExpr;
  return receiverExpr;
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

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

const IMPORT_NAMED_OR_NS = /^\s*import\s+(.+?)\s+from\s+(['"])([^'"]+)\2\s*;?\s*$/;
const IMPORT_BARE = /^\s*import\s+(['"])([^'"]+)\1\s*;?\s*$/;
const DYNAMIC_IMPORT = /import\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
const REQUIRE_CALL = /require\s*\(\s*(['"])([^'"]+)\1\s*\)/g;

/**
 * Parse TS/JS import statements. Covers:
 *   - `import X from "m"`
 *   - `import { a, b as c } from "m"`
 *   - `import * as ns from "m"`
 *   - `import X, { a } from "m"`
 *   - `import "side-effect"`
 *   - `import("dyn")` anywhere in source
 *   - `require("x")` for CommonJS
 *
 * `.js` / `.ts` / `.mjs` / `.cjs` suffixes are preserved verbatim in `source`;
 * consumers can strip via `provider.preprocessImportPath`.
 */
export function extractTsImports(input: ExtractImportsInput): readonly ExtractedImport[] {
  const { filePath, sourceText } = input;
  const stripped = stripComments(sourceText);
  const lines = stripped.split("\n");
  const out: ExtractedImport[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "" || !line.startsWith("import")) {
      // still handle dynamic imports / requires below via file-level scan
      continue;
    }

    const bare = IMPORT_BARE.exec(line);
    if (bare !== null) {
      out.push({ filePath, source: bare[2] as string, kind: "named" });
      continue;
    }

    const named = IMPORT_NAMED_OR_NS.exec(line);
    if (named === null) continue;
    const clause = (named[1] as string).trim();
    const source = named[3] as string;

    for (const entry of parseTsImportClause(clause)) {
      out.push({ filePath, source, ...entry });
    }
  }

  // Dynamic imports + CommonJS requires: scan the whole stripped source.
  for (const m of stripped.matchAll(DYNAMIC_IMPORT)) {
    out.push({ filePath, source: m[2] as string, kind: "namespace" });
  }
  for (const m of stripped.matchAll(REQUIRE_CALL)) {
    out.push({ filePath, source: m[2] as string, kind: "namespace" });
  }

  return out;
}

interface ImportClausePart {
  readonly kind: ImportKind;
  readonly importedNames?: readonly string[];
  readonly isWildcard?: boolean;
  readonly localAlias?: string;
}

function parseTsImportClause(clause: string): readonly ImportClausePart[] {
  const out: ImportClausePart[] = [];
  let remaining = clause;

  // `import X` followed optionally by `, { a, b }` or `, * as ns`
  const defaultMatch = /^([A-Za-z_$][\w$]*)(\s*,\s*)?/.exec(remaining);
  if (defaultMatch !== null && !/^[A-Za-z_$][\w$]*\s*\{/.test(remaining)) {
    const defaultName = defaultMatch[1] as string;
    // Must not be `from` (which would indicate no default and we mis-matched).
    if (defaultName !== "from") {
      out.push({ kind: "default", localAlias: defaultName });
      remaining = remaining.slice(defaultMatch[0].length).trim();
    }
  }

  // `* as ns`
  const nsMatch = /^\*\s+as\s+([A-Za-z_$][\w$]*)\s*$/.exec(remaining);
  if (nsMatch !== null) {
    out.push({
      kind: "namespace",
      isWildcard: true,
      localAlias: nsMatch[1] as string,
    });
    return out;
  }

  // `{ a, b as c }`
  const namedMatch = /^\{([\s\S]*)\}\s*$/.exec(remaining);
  if (namedMatch !== null) {
    const entries = splitNamedImports(namedMatch[1] as string);
    const names = entries.map((e) => e.alias ?? e.name);
    if (names.length > 0) {
      out.push({ kind: "named", importedNames: names });
    }
  }

  return out;
}

export function preprocessTsImportPath(raw: string): string {
  // Strip `.js` / `.ts` / `.mjs` / `.cjs` / `.tsx` / `.jsx` suffixes so TS
  // import specifiers collapse onto their source-side files during symbol
  // lookup. Only strip when the suffix is a known script extension.
  return raw.replace(/\.(?:js|ts|mjs|cjs|jsx|tsx)$/, "");
}

// ---------------------------------------------------------------------------
// Heritage
// ---------------------------------------------------------------------------

export function extractTsHeritage(input: ExtractHeritageInput): readonly ExtractedHeritage[] {
  const { filePath, captures, definitions } = input;

  // The unified query emits:
  //   `(implements_clause (type_identifier) @name @reference.interface)`
  // for `implements I1, I2`. For `extends Parent` we don't have a dedicated
  // capture — fall back to regex-scanning the class/interface header line.

  const out: ExtractedHeritage[] = [];

  // IMPLEMENTS via capture.
  const implementsRefs = captures.filter((c) => c.tag === "reference.interface");
  for (const ref of implementsRefs) {
    const child = findChildDef(ref, definitions);
    if (child === undefined) continue;
    out.push({
      childQualifiedName: child,
      parentName: ref.text,
      filePath,
      relation: "IMPLEMENTS",
      startLine: ref.startLine,
    });
  }

  // EXTENDS via regex on definition header lines. Covers:
  //   `class Foo extends Bar { ... }`
  //   `interface Foo extends A, B { ... }`
  for (const def of definitions) {
    if (def.kind !== "Class" && def.kind !== "Interface") continue;
    const headerLine = getLine(input.captures[0]?.text ?? "", 0); // dummy; replaced below
    const rawLine = readHeaderFromCaptures(input, def.startLine);
    const extendsMatch = /extends\s+([^\s{]+(?:\s*,\s*[^\s{]+)*)/.exec(rawLine ?? headerLine);
    if (extendsMatch === null) continue;
    const list = (extendsMatch[1] as string)
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const parent of list) {
      // Strip generic args: `Bar<T>` -> `Bar`.
      const bare = parent.replace(/<.*$/, "").trim();
      if (bare.length === 0) continue;
      out.push({
        childQualifiedName: def.qualifiedName,
        parentName: bare,
        filePath,
        relation: "EXTENDS",
        startLine: def.startLine,
      });
    }
  }

  return out;
}

function readHeaderFromCaptures(input: ExtractHeritageInput, startLine: number): string {
  // The extract-heritage inputs don't include `sourceText`; we fall back
  // to reconstructing from the largest capture's text. Providers pass the
  // class/interface definition capture whose text starts at startLine.
  for (const c of input.captures) {
    if (c.tag.startsWith("definition.") && c.startLine === startLine) {
      // Return only the first line of the capture text (the header).
      const idx = c.text.indexOf("\n");
      return idx === -1 ? c.text : c.text.slice(0, idx);
    }
  }
  return "";
}

function findChildDef(
  ref: { startLine: number },
  definitions: readonly ExtractedDefinition[],
): string | undefined {
  // Walk definitions and find the one whose range contains `ref.startLine`
  // and is a class/interface. Prefer the nearest enclosing one.
  let best: ExtractedDefinition | undefined;
  for (const d of definitions) {
    if (d.kind !== "Class" && d.kind !== "Interface") continue;
    if (ref.startLine < d.startLine || ref.startLine > d.endLine) continue;
    if (best === undefined || d.startLine > best.startLine) best = d;
  }
  return best?.qualifiedName;
}

// ---------------------------------------------------------------------------
// isExported bridge
// ---------------------------------------------------------------------------

export function tsIsExported(def: ExtractedDefinition): boolean {
  return def.isExported;
}
