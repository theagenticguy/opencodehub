import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { communityTruckFactor } from "./gini-community.js";
import type { ContributorWeight } from "./line-overlap.js";

function w(email: string, lines: number): ContributorWeight {
  return { email, lines, weight: 0 };
}

describe("communityTruckFactor", () => {
  it("returns 1 for an empty community", () => {
    assert.equal(communityTruckFactor({ memberFiles: [] }), 1);
  });

  it("returns 1 when one contributor owns everything", () => {
    const tf = communityTruckFactor({
      memberFiles: [[w("alice@example.com", 100)], [w("alice@example.com", 50)]],
    });
    assert.equal(tf, 1);
  });

  it("returns a higher count for uniform community", () => {
    const files: ContributorWeight[][] = [
      [w("a@x.com", 10), w("b@x.com", 10), w("c@x.com", 10)],
      [w("a@x.com", 10), w("b@x.com", 10), w("c@x.com", 10)],
    ];
    const tf = communityTruckFactor({ memberFiles: files });
    assert.equal(tf, 3);
  });
});
