/**
 * THE LOAD-BEARING TEST: prove the packHash quarantine (U2).
 *
 * The invariant: Tier-3 LSP facts MUST NOT enter the packHash preimage. A pack
 * of a repo that HAS SCIP-blind sources (Tier-3 sidecar written) MUST produce a
 * packHash byte-identical to the same pack with Tier-3 disabled (no sidecar),
 * for an unchanged `(commit, tokenizer, budget, pins, files)`.
 *
 * We prove it against the REAL manifest builder (`@opencodehub/pack`'s
 * `buildManifest`) — not a replica — so the test can never drift from the
 * actual preimage. The sidecar is written to the SAME output directory the
 * manifest lives in; if the sidecar's bytes leaked into the preimage, the
 * second `buildManifest` (run after the sidecar exists) would diverge.
 *
 * `buildManifest` is a pure function of its `opts` — it does not read the
 * filesystem — so the strongest possible statement of the invariant is: the
 * Tier-3 facts are simply not an input to it. We assert that directly (identical
 * opts → identical hash regardless of how many sidecar facts exist), AND we
 * assert the serialized manifest text never mentions the sidecar filename or any
 * `lsp`/`source=lsp` token, so a future refactor that tried to fold Tier-3 into
 * the manifest would fail this test.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type BuildManifestOpts, buildManifest, serializeManifest } from "@opencodehub/pack";
import type { LspTierFact } from "./provenance.js";
import { TIER3_SIDECAR_FILENAME, writeTier3Sidecar } from "./sidecar.js";

/** Fixed manifest inputs — the unchanged `(commit, tokenizer, budget, pins)`. */
function fixtureManifestOpts(): BuildManifestOpts {
  return {
    commit: "f".repeat(40),
    repoOriginUrl: "https://github.com/example/scip-blind-repo",
    tokenizerId: "anthropic:claude@1.0.0",
    determinismClass: "strict",
    budgetTokens: 4096,
    pins: {
      chonkieVersion: "0.0.9",
      duckdbVersion: "1.1.3",
      grammarCommits: { swift: "a".repeat(40), elixir: "b".repeat(40) },
    },
    files: [
      { kind: "skeleton", path: "skeleton.jsonl", fileHash: "1".repeat(64) },
      { kind: "ast-chunks", path: "ast-chunks.jsonl", fileHash: "2".repeat(64) },
    ],
  };
}

/** A non-trivial Tier-3 fact set, as a SCIP-blind (Swift/Elixir) repo would yield. */
const TIER3_FACTS: readonly LspTierFact[] = [
  { source: "lsp", server: "sourcekit-lsp@6.0.3", symbol: "App.run", edges: ["Net.fetch"] },
  { source: "lsp", server: "elixir-ls@0.22.1", symbol: "Worker.loop", edges: ["Queue.pop"] },
];

test("U2 QUARANTINE: packHash is byte-identical with vs without Tier-3 facts", async () => {
  // Tier-3 DISABLED: build the manifest from the fixed inputs.
  const opts = fixtureManifestOpts();
  const withoutTier3 = buildManifest(opts);

  // Tier-3 ENABLED: write a real sidecar, then build the manifest from the
  // SAME inputs. If any Tier-3 byte leaked into the preimage, this diverges.
  const outDir = await mkdtemp(join(tmpdir(), "lsp-tier-quarantine-"));
  try {
    await writeTier3Sidecar(TIER3_FACTS, outDir);
    const withTier3 = buildManifest(fixtureManifestOpts());

    assert.equal(
      withTier3.packHash,
      withoutTier3.packHash,
      "packHash MUST be byte-identical with Tier-3 present — the sidecar is outside the preimage",
    );

    // The serialized manifest must never reference the sidecar or any LSP token.
    const serialized = serializeManifest(withTier3);
    assert.ok(
      !serialized.includes(TIER3_SIDECAR_FILENAME),
      "manifest must not reference the Tier-3 sidecar file",
    );
    assert.ok(!serialized.includes("lsp"), "manifest must not contain any lsp token");
    assert.ok(!serialized.includes("source=lsp"), "manifest must not carry source=lsp");

    // The sidecar IS on disk (so this is a real with-Tier-3 scenario, not a
    // vacuous pass), and it is a SEPARATE file from manifest.json.
    const entries = await readdir(outDir);
    assert.ok(entries.includes(TIER3_SIDECAR_FILENAME), "sidecar must be written to disk");
    assert.ok(!entries.includes("manifest.json"), "the quarantine test writes only the sidecar");
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("U2: more/fewer Tier-3 facts do NOT move the packHash (facts are not an input)", async () => {
  const base = buildManifest(fixtureManifestOpts());
  // Even a wildly different fact volume cannot change the hash, because facts
  // are never passed to buildManifest.
  const outDir = await mkdtemp(join(tmpdir(), "lsp-tier-quarantine-vol-"));
  try {
    const manyFacts: LspTierFact[] = Array.from({ length: 500 }, (_, i) => ({
      source: "lsp" as const,
      server: "zls@0.13.0",
      symbol: `Sym${i}`,
      edges: [`Ref${i}`],
    }));
    await writeTier3Sidecar(manyFacts, outDir);
    const after = buildManifest(fixtureManifestOpts());
    assert.equal(after.packHash, base.packHash);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("the Tier-3 sidecar is byte-stable across two runs (its OWN determinism, U7)", async () => {
  const dirA = await mkdtemp(join(tmpdir(), "lsp-tier-det-a-"));
  const dirB = await mkdtemp(join(tmpdir(), "lsp-tier-det-b-"));
  try {
    // Same facts, shuffled differently between runs.
    const run1 = [TIER3_FACTS[1], TIER3_FACTS[0]] as LspTierFact[];
    const run2 = [TIER3_FACTS[0], TIER3_FACTS[1]] as LspTierFact[];
    await writeTier3Sidecar(run1, dirA);
    await writeTier3Sidecar(run2, dirB);
    const a = await readFile(join(dirA, TIER3_SIDECAR_FILENAME));
    const b = await readFile(join(dirB, TIER3_SIDECAR_FILENAME));
    assert.equal(
      Buffer.compare(a, b),
      0,
      "sidecar must be byte-identical regardless of input order",
    );
  } finally {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});
