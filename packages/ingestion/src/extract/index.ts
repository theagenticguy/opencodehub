/** Barrel exports for the extraction scaffolds used by Wave 6 pipeline phases. */

export { detectPrismaCalls, detectSupabaseCalls } from "./orm-detector.js";
export { detectExpressRoutes, detectNextJsRoutes } from "./route-detector.js";
export { detectMcpTools } from "./tool-detector.js";
export type { ExtractedOrmEdge, ExtractedRoute, ExtractedTool, ExtractInput } from "./types.js";
