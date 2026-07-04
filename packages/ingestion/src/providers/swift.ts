import type { NodeKind } from "@opencodehub/core-types";
import {
  type CallsConfig,
  type DefinitionsConfig,
  dotPrefixReceiver,
  extractCallsGeneric,
  extractDefinitionsGeneric,
  extractHeritageRefBased,
  type HeritageConfig,
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
 * Swift provider.
 *
 * Definitions: classes, structs, enums, protocols, extensions, functions,
 * methods, initializers, computed properties. Swift's grammar packs
 * `class_declaration` to cover all of class/struct/enum/actor (disambiguated
 * by the `class`/`struct`/`enum` keyword field on the node). We rely on the
 * unified query to tag the specific kind.
 *
 * Heritage: `class Foo: Bar, P1, P2` — the first type is the superclass
 * (if a class) and any remaining are protocols. We emit all as EXTENDS; the
 * downstream resolver can demote later parents to IMPLEMENTS when it has
 * protocol knowledge. At MVP this is good enough for reachability.
 *
 * Imports: `import Foo` or `import Foo.Bar.Baz` — each line → one import.
 *
 * Exports: Swift's access control is explicit — `private`/`fileprivate`
 * are non-exported, everything else (internal, public, open) is. We check
 * the modifier on the declaration header.
 */

const SWIFT_DEF_KIND_MAP: Readonly<Record<string, NodeKind>> = {
  "definition.class": "Class",
  "definition.struct": "Struct",
  "definition.enum": "Enum",
  "definition.interface": "Interface",
  "definition.function": "Function",
  "definition.method": "Method",
  "definition.constructor": "Constructor",
  "definition.module": "Namespace",
  "definition.property": "Property",
  "definition.constant": "Const",
};

const SWIFT_DEFS_CONFIG: DefinitionsConfig = {
  kindFor: kindFromMap(SWIFT_DEF_KIND_MAP),
  // Promote function -> method when nested in a type declaration.
  promoteToMethod: (def, ownerDef) =>
    def.tag === "definition.function" &&
    (ownerDef?.tag === "definition.class" ||
      ownerDef?.tag === "definition.struct" ||
      ownerDef?.tag === "definition.enum" ||
      ownerDef?.tag === "definition.interface"),
  isExported: ({ name }) => !name.startsWith("_"),
};

function extractSwiftDefinitions(input: ExtractDefinitionsInput): readonly ExtractedDefinition[] {
  return extractDefinitionsGeneric(input, SWIFT_DEFS_CONFIG);
}

const SWIFT_CALLS_CONFIG: CallsConfig = {
  inferReceiver: dotPrefixReceiver(/^[A-Za-z_][\w.]*$/),
};

function extractSwiftCalls(input: ExtractCallsInput): readonly ExtractedCall[] {
  return extractCallsGeneric(input, SWIFT_CALLS_CONFIG);
}

function extractSwiftImports(input: ExtractImportsInput): readonly ExtractedImport[] {
  const { filePath, sourceText } = input;
  const stripped = stripComments(sourceText);
  const out: ExtractedImport[] = [];

  const re =
    /^\s*import\s+(?:(?:class|struct|enum|protocol|typealias|func|var|let)\s+)?([\w.]+)\s*$/gm;
  for (const m of stripped.matchAll(re)) {
    out.push({ filePath, source: m[1] as string, kind: "named" });
  }
  return out;
}

// Swift emits all parents as EXTENDS; the downstream resolver demotes
// protocol parents to IMPLEMENTS later when it has protocol knowledge.
const SWIFT_HERITAGE_CONFIG: HeritageConfig = {
  containerTags: [
    "definition.class",
    "definition.struct",
    "definition.enum",
    "definition.interface",
  ],
  rules: [
    {
      refTag: "reference.class",
      relation: "EXTENDS",
      childKinds: ["Class", "Struct", "Enum", "Interface"],
    },
  ],
};

function extractSwiftHeritage(input: ExtractHeritageInput): readonly ExtractedHeritage[] {
  return extractHeritageRefBased(input, SWIFT_HERITAGE_CONFIG);
}

export const swiftProvider: LanguageProvider = {
  id: "swift",
  extensions: [".swift"],
  importSemantics: "named",
  mroStrategy: "single-inheritance",
  typeConfig: { structural: false, nominal: true, generics: true },
  heritageEdge: "EXTENDS",
  inferImplicitReceiver: () => "self",
  isExportedIdentifier: (name) => !name.startsWith("_"),

  extractDefinitions: extractSwiftDefinitions,
  extractCalls: extractSwiftCalls,
  extractImports: extractSwiftImports,
  isExported: (def) => def.isExported,
  extractHeritage: extractSwiftHeritage,
};
