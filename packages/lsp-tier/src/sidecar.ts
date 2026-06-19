/**
 * Tier-3 sidecar writer — the packHash quarantine boundary (U2).
 *
 * **THE NON-NEGOTIABLE INVARIANT**: Tier-3 LSP facts MUST NOT enter the
 * packHash preimage. The packHash preimage is the fixed 9-key field set in
 * `@opencodehub/pack`'s `manifest.ts` (`buildManifest` → `toSnakeCaseManifest`):
 * `budget_tokens, commit, determinism_class, files, pack_hash, pins,
 * repo_origin_url, schema_version, tokenizer_id`. There is NO LSP field there,
 * and there must not be.
 *
 * This module writes facts to a **separate file** (`lsp-tier.sidecar.json`)
 * that `buildManifest` never reads. Adding or removing this sidecar therefore
 * cannot move the packHash: a pack of a repo with SCIP-blind sources produces a
 * packHash byte-identical to the same pack with Tier-3 disabled, for an
 * unchanged `(commit, tokenizer, budget, pins)`. That byte-identity is the
 * proof the quarantine holds (asserted in `quarantine.test.ts`).
 *
 * The sidecar itself is internally deterministic (canonical JSON over
 * already-canonically-sorted facts) so two runs over identical contents +
 * identical server versions produce a byte-identical sidecar (U7) — but its
 * determinism is its OWN contract, entirely outside the packHash's.
 *
 * If a future fold-in into the index is ever wanted, it enters ONLY via a
 * server-version-pinned, sorted `pins`-style entry treated as a deliberate
 * index-version bump — never silently. For this task: sidecar only.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "@opencodehub/core-types";
import type { LspTierFact } from "./provenance.js";
import { canonicalizeFacts } from "./provenance.js";

/** The on-disk sidecar filename. Deliberately NOT `manifest.json`. */
export const TIER3_SIDECAR_FILENAME = "lsp-tier.sidecar.json";

/** Schema version for the sidecar wire format (independent of the pack schema). */
export const TIER3_SIDECAR_SCHEMA_VERSION = 1;

/** The serialized sidecar shape. */
export interface Tier3Sidecar {
  readonly schema_version: number;
  /** Always `"lsp"` — the tier marker that distinguishes this from SCIP facts. */
  readonly tier: "lsp";
  /** Canonically sorted facts (U7). */
  readonly facts: readonly LspTierFact[];
}

/**
 * Serialize Tier-3 facts to the canonical sidecar JSON string. Re-canonicalizes
 * the facts defensively (idempotent if they were already sorted by the runner)
 * so the sidecar is byte-stable regardless of caller ordering.
 */
export function serializeTier3Sidecar(facts: readonly LspTierFact[]): string {
  const sidecar: Tier3Sidecar = {
    schema_version: TIER3_SIDECAR_SCHEMA_VERSION,
    tier: "lsp",
    facts: canonicalizeFacts(facts),
  };
  return canonicalJson(sidecar);
}

/**
 * Write the Tier-3 facts to `<outDir>/lsp-tier.sidecar.json` — OUTSIDE the
 * packHash preimage (U2). Returns the absolute path written.
 *
 * The caller is responsible for NEVER passing a partial result here — the
 * runner hard-fails on partial (S-A4b) before any fact reaches this function.
 */
export async function writeTier3Sidecar(
  facts: readonly LspTierFact[],
  outDir: string,
): Promise<string> {
  const path = join(outDir, TIER3_SIDECAR_FILENAME);
  await writeFile(path, serializeTier3Sidecar(facts), "utf8");
  return path;
}
