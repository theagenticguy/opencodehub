// No-op linearization. Used by languages without classical inheritance
// (Go — struct embedding is not MRO-shaped). Returns the class itself.

import type { MroStrategyName } from "../types.js";
import type { MroStrategy } from "./mro.js";

function linearize(classId: string): readonly string[] {
  return [classId];
}

const NAME: MroStrategyName = "none";

export const noneStrategy: MroStrategy = {
  name: NAME,
  linearize,
};
