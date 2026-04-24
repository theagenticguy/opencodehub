/**
 * Barrel exports for @opencodehub/search.
 */

export { annSearch, DEFAULT_ANN_LIMIT } from "./ann.js";
export { bm25Search, DEFAULT_BM25_LIMIT } from "./bm25.js";
export { DEFAULT_EMBEDDER_DIM, NullEmbedder } from "./embedder.js";
export { DEFAULT_HYBRID_LIMIT, hybridBm25Only, hybridSearch } from "./hybrid.js";
export { embeddingsPopulated, tryOpenEmbedder } from "./open-embedder.js";
export { groupByProcess, type ProcessBucket } from "./process-grouping.js";
export { DEFAULT_RRF_K, DEFAULT_RRF_TOP_K, type FusedItem, type RankedItem, rrf } from "./rrf.js";
export type { BM25Query, Embedder, FusedHit, SymbolHit, VectorHit, VectorQuery } from "./types.js";
