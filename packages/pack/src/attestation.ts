/**
 * Context attestation — an in-toto Statement v1 whose subject is the pack's
 * `packHash` and whose predicate records the context provenance (what the
 * agent read). It chains BENEATH the SLSA build provenance CI already emits
 * for the built npm tarball: this in-tool attestation attests the pack's own
 * `packHash` / `contextBomHash`, complementary and composable with the
 * `https://slsa.dev/provenance/v1` attestation on a related digest.
 *
 * in-toto Statement v1 envelope (verified against in-toto.io this session):
 *
 *   {
 *     "_type": "https://in-toto.io/Statement/v1",
 *     "subject": [ { "name": "<string>", "digest": { "sha256": "<hex>" } } ],
 *     "predicateType": "<URI>",
 *     "predicate": { ... }
 *   }
 *
 * `_type` is ALWAYS the literal `https://in-toto.io/Statement/v1` for this
 * spec version. `subject[].digest` is an algorithm→hex map; `packHash` is a
 * sha256 hex string, so the shape is `{ "sha256": manifest.packHash }`.
 *
 * The `predicateType` is a bespoke URI we mint under the repo's canonical
 * `opencodehub.dev` domain (the same domain the docmeta / tool-catalog JSON
 * schemas use), versioned v0.1. The predicate body carries the machine-
 * checkable record of exactly what was packed: the manifest provenance fields
 * plus the BOM item list (path + kind + fileHash per item), sorted by path.
 *
 * Determinism contract:
 *   - No wall-clock timestamp, no run-id, no random UUID. The Statement is a
 *     pure function of the manifest, so two builds over the same pack produce
 *     a byte-identical serialized attestation (on-thesis for OCH: the
 *     attestation is itself re-derivable).
 *   - `bomItems` are sorted by path ASC (paths are unique within a manifest,
 *     so no tiebreak is needed).
 *   - Serialization goes through the shared RFC 8785 `canonicalJson` helper,
 *     so byte-identity holds across runs.
 *
 * This module emits the UNSIGNED Statement. Signing (cosign keyless / the
 * DSSE envelope) stays a CI concern layered on top of these bytes.
 */

import { canonicalJson } from "@opencodehub/core-types";
import type { PackManifest } from "./types.js";

/**
 * The literal `_type` for an in-toto Statement v1. Never varies for this spec
 * version.
 */
export const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1" as const;

/**
 * The bespoke predicateType URI we mint for the context attestation. Under the
 * repo's canonical `opencodehub.dev` domain (matching the docmeta / tool-catalog
 * schema URLs), versioned v0.1.
 */
export const CONTEXT_ATTESTATION_PREDICATE_TYPE =
  "https://opencodehub.dev/attestation/context/v0.1" as const;

/**
 * The stable logical subject name for the pack. A verifier keys attestations
 * to the subject digest (the packHash); the name is a human-readable label.
 */
export const CONTEXT_ATTESTATION_SUBJECT_NAME = "pack" as const;

/** A digest set: algorithm id → lowercase hex string. */
export interface DigestSet {
  readonly sha256: string;
}

/** One in-toto subject: a named artifact plus its digest map. */
export interface InTotoSubject {
  readonly name: string;
  readonly digest: DigestSet;
}

/**
 * One BOM item as recorded in the context predicate — the machine-checkable
 * record of a single file that was packed/read.
 */
export interface AttestationBomItem {
  readonly path: string;
  readonly kind: string;
  readonly fileHash: string;
}

/**
 * The context-attestation predicate body. Arbitrary type-specific metadata per
 * the in-toto spec; here it is the context provenance carried by the manifest,
 * kept pure and deterministic (no clock / run-id / UUID).
 */
export interface ContextAttestationPredicate {
  readonly packHash: string;
  readonly contextBomHash: string;
  readonly commit: string;
  readonly repoOriginUrl: string | null;
  readonly tokenizerId: string;
  readonly budgetTokens: number;
  readonly determinismClass: PackManifest["determinismClass"];
  /** Every BOM item that was packed, sorted by path ASC. */
  readonly bomItems: readonly AttestationBomItem[];
}

/**
 * A complete in-toto Statement v1 carrying a context-attestation predicate.
 * `_type` and `predicateType` are pinned to the minted constants.
 */
export interface InTotoStatement {
  readonly _type: typeof IN_TOTO_STATEMENT_TYPE;
  readonly subject: readonly InTotoSubject[];
  readonly predicateType: typeof CONTEXT_ATTESTATION_PREDICATE_TYPE;
  readonly predicate: ContextAttestationPredicate;
}

/**
 * Build the in-toto context-attestation Statement for a finished pack.
 *
 * The SUBJECT is the pack's `packHash` (`{ sha256: <hex> }`); the PREDICATE
 * records the context provenance — the manifest fields plus the BOM item list.
 * Pure and deterministic: given the same manifest, this returns a value whose
 * canonical serialization is byte-identical across runs (no timestamp / UUID /
 * run-id). Composable beneath the SLSA build provenance: same Statement
 * envelope shape, distinct `predicateType`, subject keyed to the packHash.
 */
export function buildContextAttestation(manifest: PackManifest): InTotoStatement {
  const bomItems: AttestationBomItem[] = manifest.files
    .map((f) => ({ path: f.path, kind: f.kind, fileHash: f.fileHash }))
    // Sort by path ASC. Paths are unique within a manifest, so no tiebreak.
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [
      {
        name: CONTEXT_ATTESTATION_SUBJECT_NAME,
        digest: { sha256: manifest.packHash },
      },
    ],
    predicateType: CONTEXT_ATTESTATION_PREDICATE_TYPE,
    predicate: {
      packHash: manifest.packHash,
      contextBomHash: manifest.contextBomHash,
      commit: manifest.commit,
      repoOriginUrl: manifest.repoOriginUrl,
      tokenizerId: manifest.tokenizerId,
      budgetTokens: manifest.budgetTokens,
      determinismClass: manifest.determinismClass,
      bomItems,
    },
  };
}

/**
 * Serialize an {@link InTotoStatement} to canonical JSON. Byte-identical
 * across runs for the same Statement (RFC 8785 sorted keys, minimal number
 * format), so the attestation is itself re-derivable. This is what gets
 * written to `attestation.intoto.json`.
 */
export function serializeAttestation(stmt: InTotoStatement): string {
  return canonicalJson(stmt);
}
