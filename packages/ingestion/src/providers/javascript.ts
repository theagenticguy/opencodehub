import type { NodeKind } from "@opencodehub/core-types";
import {
  type DefinitionsConfig,
  extractDefinitionsGeneric,
  getLine,
  kindFromMap,
} from "./extract-helpers.js";
import type { ExtractedDefinition } from "./extraction-types.js";
import { detectHttpCallsTsJs } from "./http-detect.js";
import { extractTsCalls, extractTsHeritage, extractTsImports } from "./ts-shared.js";
import type { ExtractDefinitionsInput, LanguageProvider } from "./types.js";
import { extractTsFamilyPropertyAccesses } from "./typescript-family-accesses.js";

/**
 * JavaScript provider. Covers `.js`, `.jsx`, `.mjs`, and `.cjs`. Imports and
 * calls share logic with TS; exports differ — JS supports CommonJS-style
 * `module.exports = ...` / `exports.foo = ...` in addition to ESM.
 */

const JS_DEF_KIND_MAP: Readonly<Record<string, NodeKind>> = {
  "definition.class": "Class",
  "definition.function": "Function",
  "definition.method": "Method",
  "definition.constant": "Const",
  "definition.module": "Namespace",
};

function extractJsDefinitions(input: ExtractDefinitionsInput): readonly ExtractedDefinition[] {
  // CommonJS export names are collected once per file, then consulted by the
  // top-level export predicate below.
  const exportedNames = collectCjsExports(input.sourceText);

  const config: DefinitionsConfig = {
    kindFor: kindFromMap(JS_DEF_KIND_MAP),
    isExported: ({ name, def, sourceText, ownerDef }) => {
      const headerLine = getLine(sourceText, def.startLine);
      return ownerDef !== undefined
        ? !/\bprivate\b/.test(headerLine)
        : /\bexport\b/.test(headerLine) || exportedNames.has(name);
    },
    wantsConst: true,
  };
  return extractDefinitionsGeneric(input, config);
}

/** Extract `module.exports.foo = ...` / `exports.foo = ...` names. */
function collectCjsExports(sourceText: string): Set<string> {
  const names = new Set<string>();
  // `exports.foo = ...`
  for (const m of sourceText.matchAll(/\bexports\.([A-Za-z_$][\w$]*)\s*=/g)) {
    names.add(m[1] as string);
  }
  // `module.exports.foo = ...`
  for (const m of sourceText.matchAll(/\bmodule\.exports\.([A-Za-z_$][\w$]*)\s*=/g)) {
    names.add(m[1] as string);
  }
  // `module.exports = { a, b, c: ... }` — pull shorthand + property keys.
  const moduleExportsObj = /\bmodule\.exports\s*=\s*\{([\s\S]*?)\}/.exec(sourceText);
  if (moduleExportsObj !== null) {
    const body = moduleExportsObj[1] as string;
    for (const m of body.matchAll(/(?:^|[,{\s])([A-Za-z_$][\w$]*)\s*(?:,|:|$)/g)) {
      names.add(m[1] as string);
    }
  }
  return names;
}

export const javascriptProvider: LanguageProvider = {
  id: "javascript",
  extensions: [".js", ".mjs", ".cjs", ".jsx"],
  importSemantics: "named",
  mroStrategy: "first-wins",
  typeConfig: { structural: true, nominal: false, generics: false },
  heritageEdge: "EXTENDS",
  inferImplicitReceiver: () => "this",
  isExportedIdentifier: (_name, context) => context === "top-level",
  // Reference resolution runs through the three-tier walker
  // (same-file -> import-scoped -> global). SCIP edges, when present,
  // overlay as the precision oracle on top of the walker's output.
  complexityDefinitionKinds: [
    "function_declaration",
    "function_expression",
    "arrow_function",
    "method_definition",
    "generator_function_declaration",
    "generator_function",
  ],
  halsteadOperatorKinds: [
    "+",
    "-",
    "*",
    "/",
    "%",
    "=",
    "==",
    "===",
    "!=",
    "!==",
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
    "?",
    ":",
    "??",
    "?.",
    "...",
    "=>",
  ],

  extractDefinitions: extractJsDefinitions,
  extractCalls: extractTsCalls,
  extractImports: extractTsImports,
  isExported: (def) => def.isExported,
  extractHeritage: extractTsHeritage,
  detectOutboundHttp: ({ sourceText }) => detectHttpCallsTsJs(sourceText),
  extractPropertyAccesses: extractTsFamilyPropertyAccesses,
};
