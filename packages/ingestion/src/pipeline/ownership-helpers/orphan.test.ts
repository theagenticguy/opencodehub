import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  classifyOrphan,
  classifyOrphans,
  computeOrphanEpsilon,
  orphanImpactMultiplier,
} from "./orphan.js";

describe("computeOrphanEpsilon", () => {
  it("returns zero for empty input", () => {
    assert.equal(computeOrphanEpsilon([]), 0);
  });

  it("is 1% of the median by default", () => {
    assert.equal(computeOrphanEpsilon([1, 2, 3, 4, 5]), 0.03);
  });

  it("even-length array averages the two middle values", () => {
    assert.equal(computeOrphanEpsilon([1, 2, 3, 4]), 0.025);
  });
});

describe("classifyOrphan", () => {
  it("active when history is insufficient", () => {
    assert.equal(
      classifyOrphan(
        { topContributorLastSeenDays: 10_000, coauthors365d: 0, decayedChurn: 100 },
        { epsilon: 0, hasEnoughHistory: false },
      ),
      "active",
    );
  });

  it("orphaned: last-seen > 180 days with no coauthors and churn", () => {
    assert.equal(
      classifyOrphan(
        { topContributorLastSeenDays: 200, coauthors365d: 0, decayedChurn: 1 },
        { epsilon: 0, hasEnoughHistory: true },
      ),
      "orphaned",
    );
  });

  it("abandoned: last-seen > 365 days with churn", () => {
    assert.equal(
      classifyOrphan(
        { topContributorLastSeenDays: 400, coauthors365d: 0, decayedChurn: 1 },
        { epsilon: 0, hasEnoughHistory: true },
      ),
      "abandoned",
    );
  });

  it("fossilized: last-seen > 730 days with no meaningful churn", () => {
    assert.equal(
      classifyOrphan(
        { topContributorLastSeenDays: 800, coauthors365d: 0, decayedChurn: 0 },
        { epsilon: 0.5, hasEnoughHistory: true },
      ),
      "fossilized",
    );
  });

  it("orphaned blocked by a recent coauthor", () => {
    assert.equal(
      classifyOrphan(
        { topContributorLastSeenDays: 200, coauthors365d: 2, decayedChurn: 1 },
        { epsilon: 0, hasEnoughHistory: true },
      ),
      "active",
    );
  });

  it("active when no top-contributor-last-seen is known", () => {
    assert.equal(
      classifyOrphan(
        { topContributorLastSeenDays: undefined, coauthors365d: 0, decayedChurn: 1 },
        { epsilon: 0, hasEnoughHistory: true },
      ),
      "active",
    );
  });
});

describe("classifyOrphans", () => {
  it("tags three fixture files with three distinct grades", () => {
    const inputs = new Map([
      ["active.ts", { topContributorLastSeenDays: 30, coauthors365d: 3, decayedChurn: 5 }],
      ["orphaned.ts", { topContributorLastSeenDays: 200, coauthors365d: 0, decayedChurn: 2 }],
      ["fossil.ts", { topContributorLastSeenDays: 800, coauthors365d: 0, decayedChurn: 0 }],
    ]);
    const out = classifyOrphans(inputs, { hasEnoughHistory: true });
    assert.equal(out.get("active.ts"), "active");
    assert.equal(out.get("orphaned.ts"), "orphaned");
    assert.equal(out.get("fossil.ts"), "fossilized");
  });

  it("when history is short, everything is active", () => {
    const inputs = new Map([
      ["orphaned.ts", { topContributorLastSeenDays: 200, coauthors365d: 0, decayedChurn: 2 }],
      ["fossil.ts", { topContributorLastSeenDays: 800, coauthors365d: 0, decayedChurn: 0 }],
    ]);
    const out = classifyOrphans(inputs, { hasEnoughHistory: false });
    for (const grade of out.values()) assert.equal(grade, "active");
  });
});

describe("orphanImpactMultiplier", () => {
  it("active → 1.0", () => assert.equal(orphanImpactMultiplier("active"), 1.0));
  it("orphaned → 1.3", () => assert.equal(orphanImpactMultiplier("orphaned"), 1.3));
  it("abandoned → 1.6", () => assert.equal(orphanImpactMultiplier("abandoned"), 1.6));
  it("fossilized → 1.6", () => assert.equal(orphanImpactMultiplier("fossilized"), 1.6));
  it("undefined → 1.0", () => assert.equal(orphanImpactMultiplier(undefined), 1.0));
});
