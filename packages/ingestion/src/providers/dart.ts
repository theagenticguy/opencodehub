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
 * Dart provider.
 *
 * Definitions: classes, mixins, extensions, functions, methods, enums.
 * Dart's grammar uses `class_definition`, `mixin_declaration`,
 * `extension_declaration`, `function_signature`, `method_signature`.
 *
 * Heritage: `class Foo extends Parent with M1 implements I1, I2` — the
 * three forms surface as:
 *   - `superclass`    → @reference.class    (EXTENDS)
 *   - `mixins`        → @reference.mixin    (IMPLEMENTS, for MRO linearization)
 *   - `interfaces`    → @reference.interface (IMPLEMENTS)
 *
 * Imports: `import 'package:…' as foo show a, b;` — one import per `import`
 * directive. Also `part of …` and `export …`, but those are ignored at MVP
 * since they do not participate in the dependency graph the same way.
 *
 * Exports: Dart uses a leading-underscore convention for library-private
 * symbols. We treat `_foo` as not exported, everything else as exported.
 */

const DART_DEF_KIND_MAP: Readonly<Record<string, NodeKind>> = {
  "definition.class": "Class",
  "definition.interface": "Interface",
  "definition.mixin": "Trait",
  "definition.function": "Function",
  "definition.method": "Method",
  "definition.constructor": "Constructor",
  "definition.module": "Module",
  "definition.enum": "Enum",
  "definition.constant": "Const",
  "definition.property": "Property",
};

const DART_DEFS_CONFIG: DefinitionsConfig = {
  kindFor: kindFromMap(DART_DEF_KIND_MAP),
  promoteToMethod: (def, ownerDef) =>
    def.tag === "definition.function" &&
    (ownerDef?.tag === "definition.class" ||
      ownerDef?.tag === "definition.interface" ||
      ownerDef?.tag === "definition.mixin"),
  isExported: ({ name }) => !name.startsWith("_"),
};

function extractDartDefinitions(input: ExtractDefinitionsInput): readonly ExtractedDefinition[] {
  return extractDefinitionsGeneric(input, DART_DEFS_CONFIG);
}

const DART_CALLS_CONFIG: CallsConfig = {
  inferReceiver: dotPrefixReceiver(/^[A-Za-z_][\w.]*$/),
};

function extractDartCalls(input: ExtractCallsInput): readonly ExtractedCall[] {
  return extractCallsGeneric(input, DART_CALLS_CONFIG);
}

function extractDartImports(input: ExtractImportsInput): readonly ExtractedImport[] {
  const { filePath, sourceText } = input;
  const stripped = stripComments(sourceText);
  const out: ExtractedImport[] = [];

  // `import 'package:foo/bar.dart' as foo show A, B hide C;`
  const re =
    /^\s*import\s+['"]([^'"]+)['"](?:\s+as\s+([A-Za-z_][\w]*))?(?:\s+(?:show|hide)\s+[\w, ]+)?\s*;/gm;
  for (const m of stripped.matchAll(re)) {
    const source = m[1] as string;
    const alias = m[2];
    out.push({
      filePath,
      source,
      kind: "namespace",
      ...(alias !== undefined ? { localAlias: alias } : {}),
    });
  }
  return out;
}

const DART_HERITAGE_CONFIG: HeritageConfig = {
  containerTags: ["definition.class", "definition.interface", "definition.mixin"],
  rules: [
    // superclass: `extends Parent`
    { refTag: "reference.class", relation: "EXTENDS", childKinds: ["Class", "Interface", "Trait"] },
    // implements: `implements I1, I2`
    { refTag: "reference.interface", relation: "IMPLEMENTS", childKinds: ["Class", "Interface"] },
    // mixins: `with M1, M2`
    { refTag: "reference.mixin", relation: "IMPLEMENTS", childKinds: ["Class", "Trait"] },
  ],
};

function extractDartHeritage(input: ExtractHeritageInput): readonly ExtractedHeritage[] {
  return extractHeritageRefBased(input, DART_HERITAGE_CONFIG);
}

export const dartProvider: LanguageProvider = {
  id: "dart",
  extensions: [".dart"],
  importSemantics: "package-wildcard",
  mroStrategy: "c3",
  typeConfig: { structural: false, nominal: true, generics: true },
  heritageEdge: "EXTENDS",
  inferImplicitReceiver: () => "this",
  isExportedIdentifier: (name) => !name.startsWith("_"),

  extractDefinitions: extractDartDefinitions,
  extractCalls: extractDartCalls,
  extractImports: extractDartImports,
  isExported: (def) => def.isExported,
  extractHeritage: extractDartHeritage,
};
