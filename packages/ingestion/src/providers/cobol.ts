/**
 * COBOL language provider — stub.
 *
 * COBOL has no tree-sitter grammar, so the parse pipeline does NOT route
 * `.cbl` / `.cob` / `.cpy` files through the worker pool or this provider's
 * extract methods. Instead, `packages/ingestion/src/parse/cobol-regex.ts`
 * emits `CodeElement` graph nodes directly from a regex pass; see T-M4-5.
 *
 * This stub exists solely to satisfy the compile-time
 * `satisfies Record<LanguageId, LanguageProvider>` constraint in
 * `providers/registry.ts`. Every extract method returns an empty array; the
 * receiver-inference and heritage hooks follow the "no inheritance" defaults.
 * Calling any of these methods indicates the parse phase failed to route
 * COBOL files correctly — the resulting empty output is preferable to a
 * crash, but upstream callers should treat it as a bug signal.
 */

import type {
  ExtractedCall,
  ExtractedDefinition,
  ExtractedHeritage,
  ExtractedImport,
} from "./extraction-types.js";
import type { LanguageProvider } from "./types.js";

export const cobolProvider: LanguageProvider = {
  id: "cobol",
  extensions: [".cbl", ".cob", ".cpy"],
  importSemantics: "named",
  mroStrategy: "none",
  typeConfig: {
    structural: false,
    nominal: false,
    generics: false,
  },
  heritageEdge: null,

  extractDefinitions(): readonly ExtractedDefinition[] {
    return [];
  },
  extractCalls(): readonly ExtractedCall[] {
    return [];
  },
  extractImports(): readonly ExtractedImport[] {
    return [];
  },
  isExported(): boolean {
    return false;
  },
  extractHeritage(): readonly ExtractedHeritage[] {
    return [];
  },
};
