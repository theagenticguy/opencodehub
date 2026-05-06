/**
 * @opencodehub/pack — public type surface for the M5 9-item BOM.
 *
 * These interfaces are the contract consumed by AC-M5-3..9. Fields are
 * `readonly` by convention (see sibling packages in this workspace for
 * precedent) so downstream code cannot mutate a manifest in-place.
 */

/** A single item in the 9-item BOM. */
export interface BomItem {
  readonly kind:
    | "manifest"
    | "skeleton"
    | "file-tree"
    | "deps"
    | "ast-chunks"
    | "xrefs"
    | "embeddings-sidecar"
    | "findings"
    | "licenses";
  readonly path: string; // relative to pack output dir
  readonly fileHash: string; // sha256 hex of the file's raw bytes
}

/**
 * Determinism class of the pack. `strict` means byte-identity holds
 * given same (commit, tokenizer, budget, pins). `best_effort` relaxes
 * the tokenizer-id guarantee (e.g. Claude tokenizers). `degraded`
 * means a primitive fallback was used (e.g. chonkie unavailable).
 */
export type DeterminismClass = "strict" | "best_effort" | "degraded";

/** Version pins embedded in the BOM manifest for reproducibility. */
export interface PackPins {
  readonly chonkieVersion: string;
  readonly duckdbVersion: string;
  readonly grammarCommits: Readonly<Record<string, string>>; // lang -> grammar commit SHA
}

export interface PackManifest {
  readonly commit: string; // 40-char SHA
  readonly repoOriginUrl: string | null; // null when no git remote
  readonly tokenizerId: string; // "<vendor>:<name>@<pin>"
  readonly determinismClass: DeterminismClass;
  readonly budgetTokens: number;
  readonly pins: PackPins;
  readonly files: readonly BomItem[];
  readonly packHash: string; // sha256 over canonicalJson of all other fields
  readonly schemaVersion: 1;
}

export interface PackOpts {
  readonly repoPath: string;
  readonly outDir: string; // absolute or repo-relative; defaults resolved by CLI
  readonly budgetTokens: number;
  readonly tokenizerId: string;
  readonly engine?: "pack" | "repomix"; // repomix fallback retained through M6 per spec
}
