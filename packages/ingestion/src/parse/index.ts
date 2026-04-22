/**
 * Barrel exports for the parse subsystem.
 */

export type { GrammarHandle } from "./grammar-registry.js";
export { _resetGrammarCacheForTests, loadGrammar, preloadGrammars } from "./grammar-registry.js";
export { detectLanguage } from "./language-detector.js";
export type {
  LanguageId,
  ParseBatch,
  ParseCapture,
  ParseResult,
  ParseTask,
} from "./types.js";
export { getUnifiedQuery } from "./unified-queries.js";
export { isNativeAvailable, resetNativeAvailabilityCache } from "./wasm-fallback.js";
export type { DispatchOptions, ParsePoolOptions } from "./worker-pool.js";
export { chunkTasks, ParsePool } from "./worker-pool.js";
