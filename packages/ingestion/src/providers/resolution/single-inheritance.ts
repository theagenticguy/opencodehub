// Single-inheritance linearization for Java / C# / Kotlin. Walks the single
// parent chain by concatenating the first (and only) base's linearization.
// Throws if more than one base is supplied — callers must route interface
// resolution through a separate mechanism, not this strategy.

import type { MroStrategyName } from "../types.js";
import type { MroStrategy } from "./mro.js";

function linearize(
  classId: string,
  bases: readonly string[],
  baseLinearizations: (id: string) => readonly string[],
): readonly string[] {
  if (bases.length > 1) {
    throw new Error(
      `single-inheritance strategy received ${bases.length} bases for ${classId}; ` +
        "this language does not support multiple inheritance.",
    );
  }
  const parent = bases[0];
  if (parent === undefined) {
    return [classId];
  }
  return [classId, ...baseLinearizations(parent)];
}

const NAME: MroStrategyName = "single-inheritance";

export const singleInheritanceStrategy: MroStrategy = {
  name: NAME,
  linearize,
};
