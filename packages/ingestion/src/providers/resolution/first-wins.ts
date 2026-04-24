// "First wins" linearization. Used for TypeScript / JavaScript mixin chains
// and as a pragmatic default for trait walking. Walks bases left-to-right,
// flattens each base's linearization in order, and deduplicates by first
// occurrence. No monotonicity guarantee — the caller accepts that.

import type { MroStrategyName } from "../types.js";
import type { MroStrategy } from "./mro.js";

function linearize(
  classId: string,
  bases: readonly string[],
  baseLinearizations: (id: string) => readonly string[],
): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  const push = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  };

  push(classId);
  for (const base of bases) {
    for (const id of baseLinearizations(base)) {
      push(id);
    }
  }
  return result;
}

const NAME: MroStrategyName = "first-wins";

export const firstWinsStrategy: MroStrategy = {
  name: NAME,
  linearize,
};
