/**
 * Unit tests for `computeConfidenceBreakdown`.
 *
 * Every bucket boundary has an explicit case:
 *   - all confirmed (>= 0.95 AND reason matches a first-party `scip:` prefix)
 *   - all scipUnofficial (Tier 1.5 — reason matches a `scip-unofficial:` prefix)
 *   - all heuristic (> 0.2, < 0.95 OR >= 0.95 without an LSP prefix)
 *   - all unknown   (<= 0.2)
 *   - mixed
 *   - high confidence without LSP prefix stays in `heuristic` — this is the
 *     load-bearing rule that distinguishes "we inferred this well" from
 *     "an oracle confirmed this"
 *   - a Tier-1.5 `scip-unofficial:` edge is its OWN tier, distinct from both
 *     first-party `confirmed` and bare `heuristic` (AC-A3)
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { computeConfidenceBreakdown, type EdgeConfidenceSource } from "./confidence.js";

test("computeConfidenceBreakdown: all-confirmed LSP edges", () => {
  const edges: EdgeConfidenceSource[] = [
    { confidence: 1.0, reason: "scip:scip-python@0.6.6" },
    { confidence: 1.0, reason: "scip:scip-typescript@0.4.0" },
    { confidence: 1.0, reason: "scip:scip-go@0.2.3" },
  ];
  const out = computeConfidenceBreakdown(edges);
  assert.deepEqual(out, { confirmed: 3, scipUnofficial: 0, heuristic: 0, unknown: 0 });
});

test("computeConfidenceBreakdown: all-heuristic edges", () => {
  const edges: EdgeConfidenceSource[] = [
    { confidence: 0.5, reason: "heuristic/tier-2" },
    { confidence: 0.5, reason: "heuristic/tier-1" },
    { confidence: 0.5 },
  ];
  const out = computeConfidenceBreakdown(edges);
  assert.deepEqual(out, { confirmed: 0, scipUnofficial: 0, heuristic: 3, unknown: 0 });
});

test("computeConfidenceBreakdown: all-demoted edges at the 0.2 floor", () => {
  const edges: EdgeConfidenceSource[] = [
    { confidence: 0.2, reason: "heuristic/tier-2+scip-unconfirmed" },
    { confidence: 0.2, reason: "heuristic/tier-1+scip-unconfirmed" },
    { confidence: 0.2 },
  ];
  const out = computeConfidenceBreakdown(edges);
  assert.deepEqual(out, { confirmed: 0, scipUnofficial: 0, heuristic: 0, unknown: 3 });
});

test("computeConfidenceBreakdown: all-scip-unofficial (Tier 1.5) edges", () => {
  // Tier-1.5 edges are bucketed by their `scip-unofficial:` reason prefix, not
  // by their numeric confidence — a clean Tier-1.5 edge sits in the (0.5, 0.95)
  // band but must NOT count as `heuristic`.
  const edges: EdgeConfidenceSource[] = [
    { confidence: 0.7, reason: "scip-unofficial:scip-php@0.0.2" },
    { confidence: 0.7, reason: "scip-unofficial:scip-dart@1.6.2" },
  ];
  const out = computeConfidenceBreakdown(edges);
  assert.deepEqual(out, { confirmed: 0, scipUnofficial: 2, heuristic: 0, unknown: 0 });
});

test("computeConfidenceBreakdown: mixed bag yields one of each", () => {
  const edges: EdgeConfidenceSource[] = [
    { confidence: 1.0, reason: "scip:rust-analyzer@release-2026-04-20" },
    { confidence: 0.7, reason: "scip-unofficial:scip-php@0.0.2" },
    { confidence: 0.5, reason: "heuristic/tier-2" },
    { confidence: 0.2, reason: "heuristic/tier-2+scip-unconfirmed" },
  ];
  const out = computeConfidenceBreakdown(edges);
  assert.deepEqual(out, { confirmed: 1, scipUnofficial: 1, heuristic: 1, unknown: 1 });
});

test("computeConfidenceBreakdown: a Tier-1.5 edge is distinct from first-party confirmed and from heuristic", () => {
  // The AC-A3 load-bearing separation: a first-party `scip:` oracle edge, a
  // Tier-1.5 `scip-unofficial:` edge, and a bare heuristic edge — all three at
  // confidences that would collide in a naive scheme — land in three different
  // buckets so a consumer can tell a pre-alpha edge from a first-party one.
  const firstParty: EdgeConfidenceSource = { confidence: 1.0, reason: "scip:scip-go@0.2.7" };
  const tier15: EdgeConfidenceSource = {
    confidence: 0.7,
    reason: "scip-unofficial:scip-dart@1.6.2",
  };
  const bareHeuristic: EdgeConfidenceSource = { confidence: 0.7, reason: "heuristic/tier-1" };
  const out = computeConfidenceBreakdown([firstParty, tier15, bareHeuristic]);
  assert.equal(out.confirmed, 1, "first-party scip: edge → confirmed");
  assert.equal(out.scipUnofficial, 1, "scip-unofficial: edge → its own tier");
  assert.equal(out.heuristic, 1, "bare heuristic edge → heuristic");
  // The two confidence-0.7 edges are split purely by provenance prefix, proving
  // the tier is surfaced distinctly from a same-confidence heuristic edge.
  assert.notEqual(out.scipUnofficial, out.heuristic + 1);
});

test("computeConfidenceBreakdown: high confidence without an LSP prefix is heuristic, NOT confirmed", () => {
  // The boundary case the docstring calls out: a heuristic tier-1 edge that
  // happens to hit 0.95 confidence is still "we inferred this well", not
  // "an oracle confirmed this". Only LSP-reason edges at >= 0.95 get credit.
  const edges: EdgeConfidenceSource[] = [
    { confidence: 0.95, reason: "heuristic/tier-1" },
    { confidence: 0.99, reason: "openapi-spec" },
    { confidence: 1.0 }, // no reason at all
  ];
  const out = computeConfidenceBreakdown(edges);
  assert.deepEqual(out, { confirmed: 0, scipUnofficial: 0, heuristic: 3, unknown: 0 });
});

test("computeConfidenceBreakdown: 0.2 boundary counts as unknown, not heuristic", () => {
  const edges: EdgeConfidenceSource[] = [
    { confidence: 0.2, reason: "anything" },
    { confidence: 0.21, reason: "anything" },
  ];
  const out = computeConfidenceBreakdown(edges);
  // 0.2 → unknown (<= 0.2); 0.21 → heuristic (> 0.2 and < 0.95).
  assert.deepEqual(out, { confirmed: 0, scipUnofficial: 0, heuristic: 1, unknown: 1 });
});

test("computeConfidenceBreakdown: empty input → all zero", () => {
  const out = computeConfidenceBreakdown([]);
  assert.deepEqual(out, { confirmed: 0, scipUnofficial: 0, heuristic: 0, unknown: 0 });
});

test("computeConfidenceBreakdown: LSP reason with trailing version info matches by prefix", () => {
  const edges: EdgeConfidenceSource[] = [
    // Extra suffix after the LSP prefix should still match.
    { confidence: 1.0, reason: "scip:scip-python@0.6.6/extra-tag" },
    { confidence: 0.95, reason: "scip:scip-go@v0.2.3" },
  ];
  const out = computeConfidenceBreakdown(edges);
  assert.deepEqual(out, { confirmed: 2, scipUnofficial: 0, heuristic: 0, unknown: 0 });
});
