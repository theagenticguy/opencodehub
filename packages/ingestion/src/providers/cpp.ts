import type { NodeKind } from "@opencodehub/core-types";
import type { ParseCapture } from "../parse/types.js";
import {
  getLine,
  innermostEnclosingContainer,
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

function extractCppDefinitions(input: ExtractDefinitionsInput): readonly ExtractedDefinition[] {
  const { filePath, captures, sourceText } = input;
  const paired = pairDefinitionsWithNames(captures);
  const defCaptures = captures.filter((c) => c.tag.startsWith("definition."));
  const out: ExtractedDefinition[] = [];

  for (const { def, name } of paired) {
    const kind = CPP_DEF_KIND_MAP[def.tag];
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

function extractCppCalls(input: ExtractCallsInput): readonly ExtractedCall[] {
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

    // Receiver inference — `obj.method()`, `ptr->method()`, and `ns::fn()`
    // are the common selector forms. We pick the text before the callee
    // name and normalize the two pointer-forms into a bare identifier.
    let receiver: string | undefined;
    if (innerName !== undefined) {
      const idx = ref.text.lastIndexOf(innerName.text);
      if (idx > 0) {
        const prefix = ref.text.slice(0, idx).trim();
        // Strip trailing operator: `obj.` / `ptr->` / `Ns::`.
        const stripped = prefix.replace(/(?:\.|->|::)$/, "").trim();
        if (stripped !== "" && /^[A-Za-z_][\w:]*$/.test(stripped)) {
          receiver = stripped;
        }
      }
    }

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

function qualifiedForCapture(
  def: ParseCapture,
  definitions: readonly ExtractedDefinition[],
): string {
  for (const d of definitions) {
    if (d.startLine === def.startLine) return d.qualifiedName;
  }
  return "<module>";
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
