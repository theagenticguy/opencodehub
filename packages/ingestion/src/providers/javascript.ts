import type { NodeKind } from "@opencodehub/core-types";
import { getLine, innermostEnclosingDef, pairDefinitionsWithNames } from "./extract-helpers.js";
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
  const { filePath, captures, sourceText } = input;
  const paired = pairDefinitionsWithNames(captures);
  const defCaptures = captures.filter((c) => c.tag.startsWith("definition."));
  const exportedNames = collectCjsExports(sourceText);
  const out: ExtractedDefinition[] = [];

  for (const { def, name } of paired) {
    const kind = JS_DEF_KIND_MAP[def.tag];
    if (kind === undefined) continue;

    const ownerDef = innermostEnclosingDef(def, defCaptures);
    let owner: string | undefined;
    if (ownerDef !== undefined) {
      const ownerPaired = paired.find((p) => p.def === ownerDef);
      if (ownerPaired !== undefined) owner = ownerPaired.name.text;
    }

    const qualifiedName = owner !== undefined ? `${owner}.${name.text}` : name.text;
    const headerLine = getLine(sourceText, def.startLine);

    const exported =
      ownerDef !== undefined
        ? !/\bprivate\b/.test(headerLine)
        : /\bexport\b/.test(headerLine) || exportedNames.has(name.text);

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
  // Shares the TS-family stack-graphs backend — see typescript.ts.
  resolverStrategyName: "stack-graphs",
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
