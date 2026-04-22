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
 * TSX provider. Same semantics as TypeScript for imports/classes/types;
 * the parse worker already selects the `tsx` grammar for JSX-aware AST.
 */
export const tsxProvider: LanguageProvider = {
  id: "tsx",
  extensions: [".tsx"],
  importSemantics: "named",
  mroStrategy: "first-wins",
  typeConfig: { structural: true, nominal: false, generics: true },
  heritageEdge: "EXTENDS",
  inferImplicitReceiver: () => "this",
  preprocessImportPath: preprocessTsImportPath,
  isExportedIdentifier: (_name, context) => context === "top-level",
  // Shares the TS-family stack-graphs backend — see typescript.ts.
  resolverStrategyName: "stack-graphs",

  extractDefinitions: extractTsDefinitions,
  extractCalls: extractTsCalls,
  extractImports: extractTsImports,
  isExported: (def: ExtractedDefinition) => tsIsExported(def),
  extractHeritage: extractTsHeritage,
  detectOutboundHttp: ({ sourceText }) => detectHttpCallsTsJs(sourceText),
  extractPropertyAccesses: extractTsFamilyPropertyAccesses,
};
