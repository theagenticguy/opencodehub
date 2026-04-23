/**
 * Barrel exports for the providers subsystem (Wave 3c).
 *
 * Shape:
 *  - `types`           — `LanguageId`, `LanguageProvider`, MRO-strategy names.
 *  - `registry`        — compile-time exhaustive provider table.
 *  - per-language providers — fully implemented across all 15 language IDs.
 *  - `resolution/*`    — three-tier resolver + MRO strategy registry.
 */

export { cProvider } from "./c.js";
export { cppProvider } from "./cpp.js";
export { csharpProvider } from "./csharp.js";
export { dartProvider } from "./dart.js";
export type {
  ExtractedCall,
  ExtractedDefinition,
  ExtractedHeritage,
  ExtractedImport,
  ImportKind,
} from "./extraction-types.js";
export { goProvider } from "./go.js";
export { javaProvider } from "./java.js";
export { javascriptProvider } from "./javascript.js";
export { kotlinProvider } from "./kotlin.js";
export { phpProvider } from "./php.js";
export { pythonProvider } from "./python.js";
export { getProvider, listProviders } from "./registry.js";
export { c3Strategy, MroConflictError } from "./resolution/c3.js";
export type {
  ResolutionCandidate,
  ResolutionQuery,
  ResolutionTier,
  SymbolIndex,
} from "./resolution/context.js";
export { CONFIDENCE_BY_TIER, resolve } from "./resolution/context.js";
export { firstWinsStrategy } from "./resolution/first-wins.js";
export type { MroStrategy } from "./resolution/mro.js";
export { getMroStrategy } from "./resolution/mro.js";
export { noneStrategy } from "./resolution/none.js";
export type { ResolverStrategy } from "./resolution/resolver-strategy.js";
export { defaultResolver } from "./resolution/resolver-strategy.js";
export { singleInheritanceStrategy } from "./resolution/single-inheritance.js";
export { rubyProvider } from "./ruby.js";
export { rustProvider } from "./rust.js";
export { swiftProvider } from "./swift.js";
export { tsxProvider } from "./tsx.js";
export type {
  DetectOutboundHttpInput,
  ExtractCallsInput,
  ExtractDefinitionsInput,
  ExtractHeritageInput,
  ExtractImportsInput,
  HttpCall,
  ImportSemantics,
  LanguageId,
  LanguageProvider,
  MroStrategyName,
  TypeExtractionConfig,
} from "./types.js";
export { typescriptProvider } from "./typescript.js";
