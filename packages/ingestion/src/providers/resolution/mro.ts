import type { MroStrategyName } from "../types.js";
import { c3Strategy } from "./c3.js";
import { firstWinsStrategy } from "./first-wins.js";
import { noneStrategy } from "./none.js";
import { singleInheritanceStrategy } from "./single-inheritance.js";

/**
 * A linearization strategy for a class's method resolution order.
 *
 * @param classId          The id of the class being linearized.
 * @param bases            Direct base class ids in source order.
 * @param baseLinearizations Lookup function returning a previously computed
 *                         linearization for any base id. Strategies that do
 *                         not recurse (e.g. `none`) may ignore it.
 */
export interface MroStrategy {
  readonly name: MroStrategyName;
  linearize(
    classId: string,
    bases: readonly string[],
    baseLinearizations: (id: string) => readonly string[],
  ): readonly string[];
}

const STRATEGIES: Readonly<Record<MroStrategyName, MroStrategy>> = {
  c3: c3Strategy,
  "first-wins": firstWinsStrategy,
  "single-inheritance": singleInheritanceStrategy,
  none: noneStrategy,
};

export function getMroStrategy(name: MroStrategyName): MroStrategy {
  return STRATEGIES[name];
}
