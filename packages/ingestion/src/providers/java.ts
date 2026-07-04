import type { NodeKind } from "@opencodehub/core-types";
import {
  type CallsConfig,
  type DefinitionsConfig,
  dotPrefixNoRegexReceiver,
  extractCallsGeneric,
  extractDefinitionsGeneric,
  getLine,
  stripComments,
} from "./extract-helpers.js";
import type {
  ExtractedCall,
  ExtractedDefinition,
  ExtractedHeritage,
  ExtractedImport,
} from "./extraction-types.js";
import { detectHttpCallsJava } from "./http-detect.js";
import type {
  ExtractCallsInput,
  ExtractDefinitionsInput,
  ExtractHeritageInput,
  ExtractImportsInput,
  LanguageProvider,
} from "./types.js";

/**
 * Java provider.
 *
 * Kind mapping: Java's query flattens `class_declaration`, `enum_declaration`,
 * and `record_declaration` onto `@definition.class`. We distinguish by the
 * underlying `nodeType` so the graph carries accurate kinds.
 *
 * Exports: `public` modifier on the declaration line. Everything else is
 * package-private / private / protected — not exported for the graph.
 */

function mapJavaDefKind(def: import("../parse/types.js").ParseCapture): NodeKind | undefined {
  if (def.tag === "definition.class") {
    switch (def.nodeType) {
      case "class_declaration":
        return "Class";
      case "enum_declaration":
        return "Enum";
      case "record_declaration":
        return "Record";
      default:
        return "Class";
    }
  }
  if (def.tag === "definition.interface") return "Interface";
  if (def.tag === "definition.method") {
    return def.nodeType === "constructor_declaration" ? "Constructor" : "Method";
  }
  return undefined;
}

const JAVA_DEFS_CONFIG: DefinitionsConfig = {
  // Java flattens class/enum/record onto `@definition.class`; resolve by
  // `def.nodeType` via the function form (a `Record` cannot express it).
  kindFor: mapJavaDefKind,
  isExported: ({ def, sourceText }) => /\bpublic\b/.test(getLine(sourceText, def.startLine)),
};

function extractJavaDefinitions(input: ExtractDefinitionsInput): readonly ExtractedDefinition[] {
  return extractDefinitionsGeneric(input, JAVA_DEFS_CONFIG);
}

// Java call receiver: `foo()`, `this.foo()`, `obj.foo()`, `Class.foo()`. The
// `@reference.call` capture covers `method_invocation`'s name child, so
// `ref.text` is often just the bare method name (no `.`), in which case the
// dot-prefix `lastIndexOf` finds nothing and no receiver is emitted — the same
// outcome as the original body's explicit `ref.text.includes(".")` short-circuit.
const JAVA_CALLS_CONFIG: CallsConfig = {
  inferReceiver: dotPrefixNoRegexReceiver(),
};

function extractJavaCalls(input: ExtractCallsInput): readonly ExtractedCall[] {
  return extractCallsGeneric(input, JAVA_CALLS_CONFIG);
}

/**
 * Parse Java imports:
 *   `import pkg.Class;`         (named)
 *   `import pkg.*;`             (package-wildcard)
 *   `import static pkg.X.m;`    (named, static)
 *   `import static pkg.X.*;`    (package-wildcard, static)
 */
function extractJavaImports(input: ExtractImportsInput): readonly ExtractedImport[] {
  const { filePath, sourceText } = input;
  const stripped = stripComments(sourceText);
  const out: ExtractedImport[] = [];
  const importRe = /^\s*import\s+(static\s+)?([^;]+);\s*$/gm;

  for (const m of stripped.matchAll(importRe)) {
    const body = (m[2] as string).trim();
    if (body.endsWith(".*")) {
      const source = body.slice(0, -2);
      out.push({ filePath, source, kind: "package-wildcard", isWildcard: true });
      continue;
    }
    const parts = body.split(".");
    if (parts.length < 2) continue;
    const last = parts[parts.length - 1] as string;
    const source = parts.slice(0, -1).join(".");
    out.push({ filePath, source, kind: "named", importedNames: [last] });
  }
  return out;
}

function extractJavaHeritage(input: ExtractHeritageInput): readonly ExtractedHeritage[] {
  const { filePath, captures, definitions } = input;
  const out: ExtractedHeritage[] = [];

  // The unified query emits:
  //   `(superclass (type_identifier) @name @reference.class)` — single parent
  //   `(super_interfaces (type_list (type_identifier) @name @reference.implementation))`
  // Map each ref to its enclosing class/interface definition.
  const classRefs = captures.filter((c) => c.tag === "reference.class");
  const implRefs = captures.filter((c) => c.tag === "reference.implementation");

  for (const ref of classRefs) {
    const child = findChildDef(ref, definitions);
    if (child === undefined) continue;
    // Guard against `reference.class` captures that come from
    // `object_creation_expression` (`new Foo()`) rather than `superclass`.
    // Those are call-site-like and would appear outside the declaration
    // header. Keep only refs that lie on the child's header line.
    if (ref.startLine !== child.startLine) continue;
    out.push({
      childQualifiedName: child.qualifiedName,
      parentName: ref.text,
      filePath,
      relation: "EXTENDS",
      startLine: ref.startLine,
    });
  }

  for (const ref of implRefs) {
    const child = findChildDef(ref, definitions);
    if (child === undefined) continue;
    out.push({
      childQualifiedName: child.qualifiedName,
      parentName: ref.text,
      filePath,
      relation: "IMPLEMENTS",
      startLine: ref.startLine,
    });
  }

  return out;
}

function findChildDef(
  ref: { startLine: number; endLine: number },
  definitions: readonly ExtractedDefinition[],
): ExtractedDefinition | undefined {
  let best: ExtractedDefinition | undefined;
  for (const d of definitions) {
    if (d.kind !== "Class" && d.kind !== "Interface" && d.kind !== "Enum" && d.kind !== "Record") {
      continue;
    }
    if (ref.startLine < d.startLine || ref.endLine > d.endLine) continue;
    if (best === undefined || d.startLine > best.startLine) best = d;
  }
  return best;
}

export const javaProvider: LanguageProvider = {
  id: "java",
  extensions: [".java"],
  importSemantics: "named",
  mroStrategy: "single-inheritance",
  typeConfig: { structural: false, nominal: true, generics: true },
  heritageEdge: "EXTENDS",
  inferImplicitReceiver: () => "this",
  isExportedIdentifier: (_name, context) => context === "top-level",
  complexityDefinitionKinds: ["method_declaration", "constructor_declaration", "lambda_expression"],
  halsteadOperatorKinds: [
    "+",
    "-",
    "*",
    "/",
    "%",
    "=",
    "==",
    "!=",
    "<",
    ">",
    "<=",
    ">=",
    "&&",
    "||",
    "!",
    "&",
    "|",
    "^",
    "~",
    "<<",
    ">>",
    ">>>",
    "+=",
    "-=",
    "*=",
    "/=",
    "%=",
    "&=",
    "|=",
    "^=",
    "<<=",
    ">>=",
    "?",
    ":",
    "->",
    "instanceof",
  ],

  extractDefinitions: extractJavaDefinitions,
  extractCalls: extractJavaCalls,
  extractImports: extractJavaImports,
  isExported: (def) => def.isExported,
  extractHeritage: extractJavaHeritage,
  detectOutboundHttp: ({ sourceText }) => detectHttpCallsJava(sourceText),
};
