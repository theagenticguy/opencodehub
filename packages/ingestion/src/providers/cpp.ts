import type { NodeKind } from "@opencodehub/core-types";
import {
  type CallsConfig,
  type DefinitionsConfig,
  extractCallsGeneric,
  extractDefinitionsGeneric,
  getLine,
  innermostEnclosingContainer,
  kindFromMap,
  sepStripReceiver,
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
 * C++ provider.
 *
 * Definitions: classes, structs, namespaces, functions, methods, constructors,
 * destructors, templates, enums, typedefs. The unified query tags classes
 * with `@definition.class`, namespaces with `@definition.module`, and member
 * functions with `@definition.method`.
 *
 * Heritage: the query emits `(base_class_clause (type_identifier) @name
 * @reference.class)` — one reference per parent type. Downstream C3
 * linearization sees each class/struct's ordered parents.
 *
 * Imports: `#include` plus C++20 `import` (three shapes — named
 * module, `<system-header>` header-unit, `"user-header"` header-unit).
 * `kind` is `package-wildcard` for `#include` / header-unit imports,
 * `named` for module imports like `import std;`.
 *
 * Exports: C++ has no formal notion of a file-scoped export at MVP.
 * `static` members are non-exported; everything else is considered
 * accessible through the header. Namespace-private via `anonymous_namespace`
 * is not detected here (rare at MVP).
 */

const CPP_DEF_KIND_MAP: Readonly<Record<string, NodeKind>> = {
  "definition.class": "Class",
  "definition.struct": "Struct",
  "definition.function": "Function",
  "definition.method": "Method",
  "definition.constructor": "Constructor",
  "definition.module": "Namespace",
  "definition.type": "Typedef",
  "definition.enum": "Enum",
  "definition.union": "Union",
  "definition.macro": "Macro",
  "definition.template": "Template",
};

const CPP_DEFS_CONFIG: DefinitionsConfig = {
  kindFor: kindFromMap(CPP_DEF_KIND_MAP),
  isExported: ({ name, def, sourceText }) =>
    !/\bstatic\b/.test(getLine(sourceText, def.startLine)) && !name.startsWith("_"),
};

function extractCppDefinitions(input: ExtractDefinitionsInput): readonly ExtractedDefinition[] {
  return extractDefinitionsGeneric(input, CPP_DEFS_CONFIG);
}

const CPP_CALLS_CONFIG: CallsConfig = {
  // Receiver inference — `obj.method()`, `ptr->method()`, and `ns::fn()` are
  // the common selector forms. Strip the trailing operator (`.` / `->` / `::`)
  // off the bare-name prefix and normalize into a bare identifier.
  inferReceiver: sepStripReceiver(/(?:\.|->|::)$/, /^[A-Za-z_][\w:]*$/),
};

function extractCppCalls(input: ExtractCallsInput): readonly ExtractedCall[] {
  return extractCallsGeneric(input, CPP_CALLS_CONFIG);
}

function extractCppImports(input: ExtractImportsInput): readonly ExtractedImport[] {
  const { filePath, sourceText } = input;
  // See c.ts for why we avoid the shared stripComments helper (it eats `#`).
  const stripped = stripCStyleComments(sourceText);
  const out: ExtractedImport[] = [];

  const systemRe = /^\s*#\s*include\s+<([^>]+)>/gm;
  for (const m of stripped.matchAll(systemRe)) {
    out.push({ filePath, source: m[1] as string, kind: "package-wildcard" });
  }
  const userRe = /^\s*#\s*include\s+"([^"]+)"/gm;
  for (const m of stripped.matchAll(userRe)) {
    out.push({ filePath, source: m[1] as string, kind: "package-wildcard" });
  }

  // C++20 module imports. Three shapes coexist:
  //   `import std;`                — named module
  //   `import <vector>;`           — header-unit of a system header
  //   `import "utility.hpp";`      — header-unit of a user header
  // Also matches `export import std;` (re-export), which we treat the
  // same as a regular import for graph purposes.
  const moduleNamedRe = /^\s*(?:export\s+)?import\s+([A-Za-z_][\w.:]*)\s*;/gm;
  for (const m of stripped.matchAll(moduleNamedRe)) {
    out.push({ filePath, source: m[1] as string, kind: "named" });
  }
  const moduleSystemRe = /^\s*(?:export\s+)?import\s+<([^>]+)>\s*;/gm;
  for (const m of stripped.matchAll(moduleSystemRe)) {
    out.push({ filePath, source: m[1] as string, kind: "package-wildcard" });
  }
  const moduleUserRe = /^\s*(?:export\s+)?import\s+"([^"]+)"\s*;/gm;
  for (const m of stripped.matchAll(moduleUserRe)) {
    out.push({ filePath, source: m[1] as string, kind: "package-wildcard" });
  }
  return out;
}

function stripCStyleComments(src: string): string {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, " "));
  out = out.replace(/\/\/[^\n]*/g, "");
  return out;
}

function extractCppHeritage(input: ExtractHeritageInput): readonly ExtractedHeritage[] {
  const { filePath, captures, definitions } = input;
  const classDefs = captures.filter(
    (c) => c.tag === "definition.class" || c.tag === "definition.struct",
  );
  const parentRefs = captures.filter((c) => c.tag === "reference.class");
  const out: ExtractedHeritage[] = [];

  for (const ref of parentRefs) {
    const enclosing = innermostEnclosingContainer(ref, classDefs);
    if (enclosing === undefined) continue;
    const child = definitions.find(
      (d) => (d.kind === "Class" || d.kind === "Struct") && d.startLine === enclosing.startLine,
    );
    if (child === undefined) continue;
    out.push({
      childQualifiedName: child.qualifiedName,
      parentName: ref.text,
      filePath,
      relation: "EXTENDS",
      startLine: ref.startLine,
    });
  }

  return out;
}

export const cppProvider: LanguageProvider = {
  id: "cpp",
  extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"],
  importSemantics: "named",
  mroStrategy: "c3",
  typeConfig: { structural: false, nominal: true, generics: true },
  heritageEdge: "EXTENDS",
  isExportedIdentifier: (name) => !name.startsWith("_"),

  extractDefinitions: extractCppDefinitions,
  extractCalls: extractCppCalls,
  extractImports: extractCppImports,
  isExported: (def) => def.isExported,
  extractHeritage: extractCppHeritage,
};
