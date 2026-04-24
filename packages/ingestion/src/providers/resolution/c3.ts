// C3 linearization for method resolution order.
//
// Ported from the public CPython specification:
//   https://docs.python.org/3/howto/mro.html
//   https://www.python.org/download/releases/2.3/mro/ (Michele Simionato, 2003)
//
// Algorithm (as stated in the spec):
//   L[C(B1..Bn)] = C + merge(L[B1], ..., L[Bn], [B1..Bn])
//
// merge(lists): repeatedly pick a "good head" — the first element of some
// list that does not appear in the tail (any position after the head) of any
// other list. Append it and remove it from every list. If no good head
// exists, the hierarchy is inconsistent and we raise `MroConflictError`.

import type { MroStrategyName } from "../types.js";
import type { MroStrategy } from "./mro.js";

export class MroConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MroConflictError";
  }
}

/**
 * Returns true if `candidate` appears in any list at position >= 1
 * (i.e. in the tail of that list).
 */
function appearsInTail(candidate: string, lists: readonly string[][]): boolean {
  for (const list of lists) {
    for (let i = 1; i < list.length; i++) {
      if (list[i] === candidate) return true;
    }
  }
  return false;
}

/**
 * The merge step. Mutates `lists` in place: removes picked heads and drops
 * emptied lists. Returns the merged linearization.
 */
function merge(lists: string[][]): string[] {
  const result: string[] = [];
  // Trim any initial empties so iteration is clean.
  let pending = lists.filter((l) => l.length > 0);

  while (pending.length > 0) {
    let picked: string | undefined;
    for (const list of pending) {
      const head = list[0];
      if (head === undefined) continue;
      if (!appearsInTail(head, pending)) {
        picked = head;
        break;
      }
    }

    if (picked === undefined) {
      const remaining = pending.map((l) => `[${l.join(", ")}]`).join(" ");
      throw new MroConflictError(
        `Cannot create a consistent method resolution order. Remaining lists: ${remaining}`,
      );
    }

    result.push(picked);
    for (const list of pending) {
      if (list[0] === picked) list.shift();
    }
    pending = pending.filter((l) => l.length > 0);
  }

  return result;
}

function linearize(
  classId: string,
  bases: readonly string[],
  baseLinearizations: (id: string) => readonly string[],
): readonly string[] {
  // Each argument to merge() is a fresh copy so we never mutate the caller's
  // data. `[...bases]` is the "direct bases" list required by the C3 spec.
  const lists: string[][] = [...bases.map((b) => [...baseLinearizations(b)]), [...bases]];
  return [classId, ...merge(lists)];
}

const NAME: MroStrategyName = "c3";

export const c3Strategy: MroStrategy = {
  name: NAME,
  linearize,
};
