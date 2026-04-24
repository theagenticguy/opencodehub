/**
 * Unit tests for `computeConfidenceBreakdown`.
 *
 * Every bucket boundary has an explicit case:
 *   - all confirmed (>= 0.95 AND reason matches a known LSP prefix)
 *   - all heuristic (> 0.2, < 0.95 OR >= 0.95 without an LSP prefix)
 *   - all unknown   (<= 0.2)
 *   - mixed
 *   - high confidence without LSP prefix stays in `heuristic` — this is the
 *     load-bearing rule that distinguishes "we inferred this well" from
 *     "an oracle confirmed this"
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { computeConfidenceBreakdown, type EdgeConfidenceSource } from "./confidence.js";

test("computeConfidenceBreakdown: all-confirmed LSP edges", () => {
  const edges: EdgeConfidenceSource[] = [
    { confidence: 1.0, reason: "pyright@1.1.390" },
    { confidence: 1.0, reason: "typescript-language-server@4.3.3" },
    { confidence: 1.0, reason: "gopls@0.16.2" },
  ];
  const out = computeConfidenceBreakdown(edges);
  assert.deepEqual(out, { confirmed: 3, heuristic: 0, unknown: 0 });
});

test("computeConfidenceBreakdown: all-heuristic edges", () => {
  const edges: EdgeConfidenceSource[] = [
    { confidence: 0.5, reason: "heuristic/tier-2" },
    { confidence: 0.5, reason: "heuristic/tier-1" },
    { confidence: 0.5 },
  ];
  const out = computeConfidenceBreakdown(edges);
  assert.deepEqual(out, { confirmed: 0, heuristic: 3, unknown: 0 });
});

test("computeConfidenceBreakdown: all-demoted edges at the 0.2 floor", () => {
  const edges: EdgeConfidenceSource[] = [
    { confidence: 0.2, reason: "heuristic/tier-2+lsp-unconfirmed" },
    { confidence: 0.2, reason: "heuristic/tier-1+lsp-unconfirmed" },
    { confidence: 0.2 },
  ];
  const out = computeConfidenceBreakdown(edges);
  assert.deepEqual(out, { confirmed: 0, heuristic: 0, unknown: 3 });
});

test("computeConfidenceBreakdown: mixed bag yields one of each", () => {
  const edges: EdgeConfidenceSource[] = [
    { confidence: 1.0, reason: "rust-analyzer@2024-12-16" },
    { confidence: 0.5, reason: "heuristic/tier-2" },
    { confidence: 0.2, reason: "heuristic/tier-2+lsp-unconfirmed" },
  ];
  const out = computeConfidenceBreakdown(edges);
  assert.deepEqual(out, { confirmed: 1, heuristic: 1, unknown: 1 });
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
  assert.deepEqual(out, { confirmed: 0, heuristic: 3, unknown: 0 });
});

test("computeConfidenceBreakdown: 0.2 boundary counts as unknown, not heuristic", () => {
  const edges: EdgeConfidenceSource[] = [
    { confidence: 0.2, reason: "anything" },
    { confidence: 0.21, reason: "anything" },
  ];
  const out = computeConfidenceBreakdown(edges);
  // 0.2 → unknown (<= 0.2); 0.21 → heuristic (> 0.2 and < 0.95).
  assert.deepEqual(out, { confirmed: 0, heuristic: 1, unknown: 1 });
});

test("computeConfidenceBreakdown: empty input → all zero", () => {
  const out = computeConfidenceBreakdown([]);
  assert.deepEqual(out, { confirmed: 0, heuristic: 0, unknown: 0 });
});

test("computeConfidenceBreakdown: LSP reason with trailing version info matches by prefix", () => {
  const edges: EdgeConfidenceSource[] = [
    // Extra suffix after the LSP prefix should still match.
    { confidence: 1.0, reason: "pyright@1.1.390/extra-tag" },
    { confidence: 0.95, reason: "gopls@v0.16.2" },
  ];
  const out = computeConfidenceBreakdown(edges);
  assert.deepEqual(out, { confirmed: 2, heuristic: 0, unknown: 0 });
});
