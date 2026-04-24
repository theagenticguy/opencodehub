import type { ExtractedDefinition } from "./extraction-types.js";
import { detectHttpCallsTsJs } from "./http-detect.js";
import {
  extractTsCalls,
  extractTsDefinitions,
  extractTsHeritage,
  extractTsImports,
  preprocessTsImportPath,
  tsIsExported,
} from "./ts-shared.js";
import type { LanguageProvider } from "./types.js";
import { extractTsFamilyPropertyAccesses } from "./typescript-family-accesses.js";

/**
 * TypeScript provider. Covers `.ts` (non-JSX) files. Shares extraction
 * logic with {@link tsxProvider} via `ts-shared.ts`; the split exists so
 * that JSX-specific adjustments (e.g. JSX tag -> call resolution) can land
 * later without branching on file suffix at call sites.
 */
export const typescriptProvider: LanguageProvider = {
  id: "typescript",
  extensions: [".ts"],
  importSemantics: "named",
  mroStrategy: "first-wins",
  typeConfig: { structural: true, nominal: false, generics: true },
  heritageEdge: "EXTENDS",
  inferImplicitReceiver: () => "this",
  preprocessImportPath: preprocessTsImportPath,
  isExportedIdentifier: (_name, context) => context === "top-level",
  // Opt into the clean-room stack-graphs evaluator. The router in
  // resolver-strategy.ts dispatches this name by provider.id; the TS/TSX/JS
  // backend handles barrel re-exports, default/namespace imports, and falls
  // back to the three-tier walker when stack-graphs can't resolve.
  resolverStrategyName: "stack-graphs",
  complexityDefinitionKinds: [
    "function_declaration",
    "function_expression",
    "arrow_function",
    "method_definition",
    "method_signature",
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
    "&=",
    "|=",
    "^=",
    "<<=",
    ">>=",
    "?",
    ":",
    "??",
    "?.",
    "...",
    "=>",
  ],

  extractDefinitions: extractTsDefinitions,
  extractCalls: extractTsCalls,
  extractImports: extractTsImports,
  isExported: (def: ExtractedDefinition) => tsIsExported(def),
  extractHeritage: extractTsHeritage,
  detectOutboundHttp: ({ sourceText }) => detectHttpCallsTsJs(sourceText),
  extractPropertyAccesses: extractTsFamilyPropertyAccesses,
};
