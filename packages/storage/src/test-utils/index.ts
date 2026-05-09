/**
 * `@opencodehub/storage/test-utils` barrel.
 *
 * Public entry point for adapter conformance testing. Third-party
 * `IGraphStore` adapter authors (community AGE / Memgraph / Neo4j /
 * Neptune forks) import {@link assertIGraphStoreConformance} from here and
 * run it against their own implementation to prove they satisfy the v1.0
 * graphHash byte-identity + typed-finder contract (architecture-revised.md
 * §AC-A-11).
 *
 * {@link assertGraphParity} + {@link rebuildFromStore} are the lower-level
 * primitives that the conformance suite is built on; they are re-exported
 * for adapter authors who want to compose their own bespoke checks.
 */

export { assertIGraphStoreConformance } from "./conformance.js";
export {
  applyRepoNullables,
  assertGraphParity,
  coerceLanguageStats,
  rebuildFromStore,
  stepZeroSentinel,
} from "./parity-harness.js";
