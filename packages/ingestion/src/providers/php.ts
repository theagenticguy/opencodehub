import type { NodeKind } from "@opencodehub/core-types";
import {
  type CallsConfig,
  type DefinitionsConfig,
  extractCallsGeneric,
  extractDefinitionsGeneric,
  extractHeritageRefBased,
  type HeritageConfig,
  kindFromMap,
  sepStripReceiver,
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
 * PHP provider.
 *
 * Definitions: classes, interfaces, traits, methods, functions, consts.
 * The grammar uses `class_declaration`/`interface_declaration`/
 * `trait_declaration`/`method_declaration`/`function_definition`. Methods
 * always live inside a class/interface/trait body, so the innermost-
 * enclosing-def walk picks up the owning type correctly.
 *
 * Heritage: `class Foo extends Bar implements I1, I2` plus `use T1, T2;`
 * for trait composition inside a class body. The unified query emits
 * `@reference.class` for the `extends` target, `@reference.interface` for
 * the `implements` list, and `@reference.mixin` for traits.
 *
 * Imports: `use` namespace/class imports, plus `require`/`include` family
 * for files. At MVP we treat all four (`require`, `require_once`, `include`,
 * `include_once`) as the same kind.
 *
 * Exports: PHP public/protected/private modifiers on methods — we treat
 * `private` as non-exported, everything else as exported.
 */

const PHP_DEF_KIND_MAP: Readonly<Record<string, NodeKind>> = {
  "definition.class": "Class",
  "definition.interface": "Interface",
  "definition.trait": "Trait",
  "definition.function": "Function",
  "definition.method": "Method",
  "definition.module": "Namespace",
  "definition.constant": "Const",
  "definition.enum": "Enum",
};

const PHP_DEFS_CONFIG: DefinitionsConfig = {
  kindFor: kindFromMap(PHP_DEF_KIND_MAP),
  isExported: ({ name }) => !name.startsWith("_"),
};

function extractPhpDefinitions(input: ExtractDefinitionsInput): readonly ExtractedDefinition[] {
  return extractDefinitionsGeneric(input, PHP_DEFS_CONFIG);
}

const PHP_CALLS_CONFIG: CallsConfig = {
  // Receiver inference — PHP has `$obj->method()`, `Class::method()`, and
  // `self::method()` forms. Strip the trailing `->` / `::` off the bare-name
  // prefix; a leading `$` on the remainder is allowed.
  inferReceiver: sepStripReceiver(/(?:->|::)$/, /^\$?[A-Za-z_][\w]*$/),
};

function extractPhpCalls(input: ExtractCallsInput): readonly ExtractedCall[] {
  return extractCallsGeneric(input, PHP_CALLS_CONFIG);
}

function extractPhpImports(input: ExtractImportsInput): readonly ExtractedImport[] {
  const { filePath, sourceText } = input;
  const stripped = stripComments(sourceText);
  const out: ExtractedImport[] = [];

  // `use Namespace\Class;` or `use Namespace\{A, B as C};` or
  // `use function foo;` or `use const BAR;`
  const useRe =
    /\buse\s+(?:function\s+|const\s+)?([A-Za-z_\\][\w\\]*)(?:\s+as\s+([A-Za-z_][\w]*))?\s*;/g;
  for (const m of stripped.matchAll(useRe)) {
    const source = (m[1] as string).replace(/\\\\/g, "/").replace(/\\/g, "/");
    const alias = m[2];
    out.push({
      filePath,
      source,
      kind: "named",
      ...(alias !== undefined ? { localAlias: alias } : {}),
    });
  }

  // `require 'path'`, `require_once "path"`, `include 'path'`, etc.
  const reqRe = /\b(require|require_once|include|include_once)\s*\(?\s*["']([^"']+)["']/g;
  for (const m of stripped.matchAll(reqRe)) {
    const source = m[2] as string;
    out.push({ filePath, source, kind: "package-wildcard" });
  }

  return out;
}

const PHP_HERITAGE_CONFIG: HeritageConfig = {
  containerTags: ["definition.class", "definition.interface", "definition.trait"],
  rules: [
    // EXTENDS — `@reference.class`
    { refTag: "reference.class", relation: "EXTENDS", childKinds: ["Class", "Interface", "Trait"] },
    // IMPLEMENTS — `@reference.interface`
    { refTag: "reference.interface", relation: "IMPLEMENTS", childKinds: ["Class"] },
    // Trait use — `@reference.mixin`
    { refTag: "reference.mixin", relation: "IMPLEMENTS", childKinds: ["Class", "Trait"] },
  ],
};

function extractPhpHeritage(input: ExtractHeritageInput): readonly ExtractedHeritage[] {
  return extractHeritageRefBased(input, PHP_HERITAGE_CONFIG);
}

export const phpProvider: LanguageProvider = {
  id: "php",
  extensions: [".php", ".php3", ".php4", ".php5", ".php7", ".phtml"],
  importSemantics: "named",
  mroStrategy: "single-inheritance",
  typeConfig: { structural: false, nominal: true, generics: false },
  heritageEdge: "EXTENDS",
  inferImplicitReceiver: () => "this",
  isExportedIdentifier: (name) => !name.startsWith("_"),

  extractDefinitions: extractPhpDefinitions,
  extractCalls: extractPhpCalls,
  extractImports: extractPhpImports,
  isExported: (def) => def.isExported,
  extractHeritage: extractPhpHeritage,
};
