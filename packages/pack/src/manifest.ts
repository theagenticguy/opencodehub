/**
 * BOM manifest builder for @opencodehub/pack.
 *
 * `buildManifest(opts)` constructs a {@link PackManifest} and computes its
 * `packHash` as `sha256(canonicalJson(manifest with packHash omitted))`.
 * The preimage uses the empty string as the placeholder for the hash —
 * the field is stripped from the canonical JSON via the same
 * `undefined`-drop semantics `canonicalJson` already implements.
 *
 * `serializeManifest(m)` produces the on-disk canonical JSON form with
 * snake_case keys and RFC 8785 canonical layout. The conversion from the
 * camelCase TS surface to the snake_case wire surface is done up-front so
 * every consumer (disk write, hashing, downstream transport) sees the same
 * bytes.
 *
 * This module reuses the RFC 8785 machinery from `@opencodehub/core-types`;
 * see `packages/core-types/src/hash.ts` for the audit trail confirming the
 * shared helpers are compliant.
 */

import { canonicalJson, sha256Hex } from "@opencodehub/core-types";
import type { BomItem, DeterminismClass, PackManifest, PackPins } from "./types.js";

/** Inputs to {@link buildManifest}. BOM items must already have `fileHash` populated. */
export interface BuildManifestOpts {
  readonly commit: string;
  readonly repoOriginUrl: string | null;
  readonly tokenizerId: string;
  readonly determinismClass: DeterminismClass;
  readonly budgetTokens: number;
  readonly pins: PackPins;
  readonly files: readonly BomItem[];
}

/**
 * Build a deterministic {@link PackManifest}.
 *
 * packHash is computed by:
 *   1. Assemble the manifest shape with `packHash: ""` as placeholder.
 *   2. Canonicalize via `canonicalJson` (`@opencodehub/core-types`), which
 *      applies RFC 8785 rules: sorted keys, minimal number format, UTF-16
 *      code-unit key order.
 *   3. SHA-256 the UTF-8 bytes of the canonical string.
 *   4. Return the manifest with the real hash substituted in.
 *
 * Empty string is the placeholder (not `undefined`) because `canonicalJson`
 * drops `undefined` fields from objects — we want the `pack_hash` key to be
 * present in the preimage with a stable sentinel, so this is equivalent in
 * the snake_case wire form to `{..., "pack_hash": "", ...}`.
 */
export function buildManifest(opts: BuildManifestOpts): PackManifest {
  const withoutHash: PackManifest = {
    commit: opts.commit,
    repoOriginUrl: opts.repoOriginUrl,
    tokenizerId: opts.tokenizerId,
    determinismClass: opts.determinismClass,
    budgetTokens: opts.budgetTokens,
    pins: opts.pins,
    files: opts.files,
    packHash: "",
    schemaVersion: 1,
  };
  const preimage = canonicalJson(toSnakeCaseManifest(withoutHash));
  const packHash = sha256Hex(preimage);
  return { ...withoutHash, packHash };
}

/**
 * Serialize a {@link PackManifest} to canonical JSON with snake_case keys.
 *
 * The output is byte-identical across runs with the same manifest and is
 * RFC 8785 compliant (sorted keys, minimum-escape strings, ES6-ToString
 * numbers). This is what gets written to disk as `manifest.json`.
 */
export function serializeManifest(m: PackManifest): string {
  return canonicalJson(toSnakeCaseManifest(m));
}

/** Private helper: camelCase → snake_case for the manifest wire surface. */
function toSnakeCaseManifest(m: PackManifest): Record<string, unknown> {
  return {
    budget_tokens: m.budgetTokens,
    commit: m.commit,
    determinism_class: m.determinismClass,
    files: m.files.map((f) => ({
      file_hash: f.fileHash,
      kind: f.kind,
      path: f.path,
    })),
    pack_hash: m.packHash,
    pins: {
      chonkie_version: m.pins.chonkieVersion,
      grammar_commits: m.pins.grammarCommits,
    },
    repo_origin_url: m.repoOriginUrl,
    schema_version: m.schemaVersion,
    tokenizer_id: m.tokenizerId,
  };
}
