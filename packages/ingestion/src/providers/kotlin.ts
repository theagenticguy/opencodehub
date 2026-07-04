import type { NodeKind } from "@opencodehub/core-types";
import {
  type CallsConfig,
  type DefinitionsConfig,
  dotPrefixReceiver,
  extractCallsGeneric,
  extractDefinitionsGeneric,
  innermostEnclosingContainer,
  kindFromMap,
  stripComments,
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
 * Kotlin provider.
 *
 * Definitions: classes, interfaces, objects (singletons), companion objects,
 * functions (top-level + member), properties (val/var). The grammar uses
 * `class_declaration` for data/sealed/enum/abstract variants — we treat all
 * class variants as `Class`.
 *
 * Heritage: `: Parent, Interface1, Interface2` — a class's
 * `delegation_specifier` carries one `user_type` reference per parent.
 * Kotlin distinguishes class `extends` (first non-interface, at most one)
 * from `implements` (interfaces) only at typecheck time. We emit all as
 * EXTENDS at MVP and let the downstream resolver reassign kinds when it
 * has type info.
 *
 * Imports: `import foo.bar.Baz` or `import foo.bar.*` — parsed via regex.
 *
 * Exports: leading-underscore convention does not apply in Kotlin. We
 * respect `private` / `internal` modifiers as non-exported.
 */

const KOTLIN_DEF_KIND_MAP: Readonly<Record<string, NodeKind>> = {
  "definition.class": "Class",
  "definition.interface": "Interface",
  "definition.module": "Namespace",
  "definition.function": "Function",
  "definition.method": "Method",
  "definition.constant": "Const",
  "definition.property": "Property",
};

const KOTLIN_DEFS_CONFIG: DefinitionsConfig = {
  kindFor: kindFromMap(KOTLIN_DEF_KIND_MAP),
  // Promote function -> method when nested inside a class/interface/object.
  promoteToMethod: (def, ownerDef) =>
    def.tag === "definition.function" &&
    (ownerDef?.tag === "definition.class" ||
      ownerDef?.tag === "definition.interface" ||
      ownerDef?.tag === "definition.module"),
  isExported: ({ name }) => !name.startsWith("_"),
};

function extractKotlinDefinitions(input: ExtractDefinitionsInput): readonly ExtractedDefinition[] {
  return extractDefinitionsGeneric(input, KOTLIN_DEFS_CONFIG);
}

const KOTLIN_CALLS_CONFIG: CallsConfig = {
  inferReceiver: dotPrefixReceiver(/^[A-Za-z_][\w.]*$/),
};

function extractKotlinCalls(input: ExtractCallsInput): readonly ExtractedCall[] {
  return extractCallsGeneric(input, KOTLIN_CALLS_CONFIG);
}

function extractKotlinImports(input: ExtractImportsInput): readonly ExtractedImport[] {
  const { filePath, sourceText } = input;
  const stripped = stripComments(sourceText);
  const out: ExtractedImport[] = [];

  const re = /^\s*import\s+([\w.]+)(\.\*)?(?:\s+as\s+([A-Za-z_][\w]*))?\s*$/gm;
  for (const m of stripped.matchAll(re)) {
    const source = m[1] as string;
    const isWildcard = m[2] !== undefined;
    const alias = m[3];
    out.push({
      filePath,
      source,
      kind: isWildcard ? "package-wildcard" : "named",
      ...(isWildcard ? { isWildcard: true } : {}),
      ...(alias !== undefined ? { localAlias: alias } : {}),
    });
  }
  return out;
}

function extractKotlinHeritage(input: ExtractHeritageInput): readonly ExtractedHeritage[] {
  const { filePath, captures, definitions } = input;
  const out: ExtractedHeritage[] = [];

  const classDefs = captures.filter(
    (c) => c.tag === "definition.class" || c.tag === "definition.interface",
  );
  const parentRefs = captures.filter((c) => c.tag === "reference.class");

  for (const ref of parentRefs) {
    const enclosing = innermostEnclosingContainer(ref, classDefs);
    if (enclosing === undefined) continue;
    const child = definitions.find(
      (d) => (d.kind === "Class" || d.kind === "Interface") && d.startLine === enclosing.startLine,
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

export const kotlinProvider: LanguageProvider = {
  id: "kotlin",
  extensions: [".kt", ".kts"],
  importSemantics: "package-wildcard",
  mroStrategy: "c3",
  typeConfig: { structural: false, nominal: true, generics: true },
  heritageEdge: "EXTENDS",
  inferImplicitReceiver: () => "this",
  isExportedIdentifier: (name) => !name.startsWith("_"),

  extractDefinitions: extractKotlinDefinitions,
  extractCalls: extractKotlinCalls,
  extractImports: extractKotlinImports,
  isExported: (def) => def.isExported,
  extractHeritage: extractKotlinHeritage,
};
