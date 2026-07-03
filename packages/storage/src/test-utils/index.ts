/**
 * `@opencodehub/storage/test-utils` barrel.
 *
 * Public entry point for adapter parity testing. {@link assertGraphParity}
 * proves an adapter round-trips a `KnowledgeGraph` to a byte-identical
 * `graphHash`; {@link rebuildFromStore} reconstructs the graph from the
 * stored rows via the typed finders. In-tree, `sqlite-parity.test.ts` uses
 * both to pin the graphHash determinism invariant; a third-party SQL-shaped
 * adapter fork can compose the same checks against its own implementation.
 */

export {
  applyRepoNullables,
  assertGraphParity,
  coerceLanguageStats,
  rebuildFromStore,
  stepZeroSentinel,
} from "./parity-harness.js";
