import type { LanguageProvider } from "../types.js";
import type { ResolutionCandidate, ResolutionQuery, SymbolIndex } from "./context.js";
import { resolve } from "./context.js";
import { stackGraphsPythonResolver } from "./stack-graphs-python.js";
import { stackGraphsTsResolver } from "./stack-graphs-ts.js";

/**
 * Seam for alternative resolution backends.
 *
 * The MVP ships the three-tier walker as the default. v1 added the Python
 * `stack-graphs` strategy; v2 extends it to the TS family. Both per-language
 * implementations register under the same public name (`"stack-graphs"`);
 * the `stackGraphsRouter` below dispatches per query based on
 * `provider.id`, so a language provider can opt in just by setting
 * `resolverStrategyName: "stack-graphs"`.
 */
export interface ResolverStrategy {
  readonly name: string;
  resolve(q: ResolutionQuery, index: SymbolIndex): ResolutionCandidate[];
}

export const defaultResolver: ResolverStrategy = {
  name: "three-tier-default",
  resolve,
};

/**
 * Dispatch to the per-language stack-graphs backend by provider id. Providers
 * outside the supported set fall through to the three-tier walker. Keeping
 * the dispatch here means each language can evolve its own builder/cache
 * without other languages paying any cost at query time.
 */
export const stackGraphsRouter: ResolverStrategy = {
  name: "stack-graphs",
  resolve(q, index): ResolutionCandidate[] {
    const id = q.provider.id;
    if (id === "python") return stackGraphsPythonResolver.resolve(q, index);
    if (id === "typescript" || id === "tsx" || id === "javascript") {
      return stackGraphsTsResolver.resolve(q, index);
    }
    return defaultResolver.resolve(q, index);
  },
};

/**
 * Registry of all known resolver strategies keyed by the name that a
 * language provider can opt into. Keeping this as a Record keeps misuses
 * visible at type level.
 */
export const RESOLVER_STRATEGIES: Readonly<Record<string, ResolverStrategy>> = {
  "three-tier-default": defaultResolver,
  "stack-graphs": stackGraphsRouter,
};

/**
 * Resolve the strategy to use for a given language provider.
 *
 * Providers may expose an optional `resolverStrategyName` hook. If absent
 * — or the referenced strategy isn't registered — we return the default
 * walker. This lets new strategies ship incrementally without a breaking
 * type-level change on every provider.
 */
export function getResolver(
  provider: Pick<LanguageProvider, "id"> & { readonly resolverStrategyName?: string },
): ResolverStrategy {
  const requested = provider.resolverStrategyName;
  if (requested === undefined) return defaultResolver;
  const strategy = RESOLVER_STRATEGIES[requested];
  return strategy ?? defaultResolver;
}
