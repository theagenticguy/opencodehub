/**
 * Unit tests for Tier-3 provenance tagging + the canonical re-sort (U7).
 *
 * No live LSP spawn — pure fixtures. Asserts:
 *   - `lspProvenanceReason` emits `lsp:<bin>@<ver>` and matches
 *     `LSP_PROVENANCE_PREFIXES` but NEITHER SCIP prefix set (tier disjointness).
 *   - `canonicalizeFacts` imposes a total order: edges sorted+deduped, facts
 *     sorted by (server, symbol, edges) — two shuffles produce identical bytes.
 *   - `assertTagged` throws on a missing/malformed tag.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  LSP_PROVENANCE_PREFIXES,
  SCIP_PROVENANCE_PREFIXES,
  SCIP_UNOFFICIAL_PROVENANCE_PREFIXES,
} from "@opencodehub/core-types";
import type { LspTierFact } from "./provenance.js";
import { assertTagged, canonicalizeFacts, lspProvenanceReason } from "./provenance.js";
import { LSP_SERVER_REGISTRY } from "./servers.js";

test("lspProvenanceReason emits lsp:<binary>@<pinnedVersion>", () => {
  const reason = lspProvenanceReason(LSP_SERVER_REGISTRY.swift);
  assert.equal(reason, "lsp:sourcekit-lsp@6.0.3");
});

test("Tier-3 reason matches LSP_PROVENANCE_PREFIXES but NOT either SCIP set (disjoint tiers)", () => {
  const reason = lspProvenanceReason(LSP_SERVER_REGISTRY.elixir);
  assert.ok(
    LSP_PROVENANCE_PREFIXES.some((p) => reason.startsWith(p)),
    "must be a Tier-3 lsp: edge",
  );
  assert.ok(
    !SCIP_PROVENANCE_PREFIXES.some((p) => reason.startsWith(p)),
    "must NOT be a Tier-1 scip: oracle edge",
  );
  assert.ok(
    !SCIP_UNOFFICIAL_PROVENANCE_PREFIXES.some((p) => reason.startsWith(p)),
    "must NOT be a Tier-1.5 scip-unofficial: edge",
  );
});

test("the three provenance prefix sets are pairwise disjoint", () => {
  const all = [
    ...SCIP_PROVENANCE_PREFIXES,
    ...SCIP_UNOFFICIAL_PROVENANCE_PREFIXES,
    ...LSP_PROVENANCE_PREFIXES,
  ];
  // No prefix in one set is a prefix of (or prefixed by) a prefix in another in
  // a way that would let a reader misclassify. The concrete check: no `lsp:`
  // string can ever match a scip prefix and vice-versa.
  for (const lsp of LSP_PROVENANCE_PREFIXES) {
    for (const scip of [...SCIP_PROVENANCE_PREFIXES, ...SCIP_UNOFFICIAL_PROVENANCE_PREFIXES]) {
      assert.ok(!lsp.startsWith(scip) && !scip.startsWith(lsp), `${lsp} collides with ${scip}`);
    }
  }
  assert.ok(all.length >= 12);
});

const SERVER = "sourcekit-lsp@6.0.3";

function fact(symbol: string, edges: readonly string[]): LspTierFact {
  return { source: "lsp", server: SERVER, symbol, edges: [...edges] };
}

test("canonicalizeFacts sorts edges, dedupes, and orders facts deterministically", () => {
  const a = canonicalizeFacts([
    fact("Zebra.run", ["c", "a", "b", "a"]),
    fact("Apple.go", ["y", "x"]),
  ]);
  assert.deepEqual(
    a.map((f) => f.symbol),
    ["Apple.go", "Zebra.run"],
    "facts sort by symbol within a single server",
  );
  assert.deepEqual(a[1]?.edges, ["a", "b", "c"], "edges sorted + deduped");
  assert.deepEqual(a[0]?.edges, ["x", "y"]);
});

test("canonicalizeFacts is order-insensitive: two shuffles → byte-identical JSON", () => {
  const shuffle1 = [fact("B.x", ["q", "p"]), fact("A.y", ["m"]), fact("C.z", ["s", "r", "s"])];
  const shuffle2 = [shuffle1[2], shuffle1[0], shuffle1[1]] as LspTierFact[];
  const j1 = JSON.stringify(canonicalizeFacts(shuffle1));
  const j2 = JSON.stringify(canonicalizeFacts(shuffle2));
  assert.equal(j1, j2, "re-sort must erase input ordering");
});

test("canonicalizeFacts always stamps source=lsp", () => {
  const out = canonicalizeFacts([fact("F.g", ["a"])]);
  for (const f of out) assert.equal(f.source, "lsp");
});

test("assertTagged throws when server tag is not <binary>@<version>", () => {
  const bad: LspTierFact = { source: "lsp", server: "sourcekit-lsp", symbol: "X", edges: [] };
  assert.throws(() => assertTagged([bad]), /server tag must be <binary>@<version>/);
});

test("assertTagged throws when source is not lsp", () => {
  const bad = {
    source: "scip",
    server: "zls@0.13.0",
    symbol: "X",
    edges: [],
  } as unknown as LspTierFact;
  assert.throws(() => assertTagged([bad]), /missing source=lsp tag/);
});

test("assertTagged passes a well-formed fact", () => {
  assert.doesNotThrow(() => assertTagged([fact("X", ["y"])]));
});
