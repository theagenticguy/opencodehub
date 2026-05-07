/**
 * @opencodehub/pack — deterministic M5 code-pack BOM.
 *
 * Public surface:
 *   - generatePack(opts): stub here; body lands in AC-M5-7.
 *   - buildManifest / serializeManifest: BOM manifest + pack_hash (AC-M5-3).
 *   - Type surface: {BomItem, DeterminismClass, PackManifest, PackOpts, PackPins}.
 *
 * AC-M5-3 lands the deterministic manifest core; AC-M5-4..6 fill the BOM
 * bodies; AC-M5-7 wires generatePack through the CLI.
 */

export type { DepRow, DepsOpts } from "./deps.js";
export { buildDeps } from "./deps.js";
export type { FileTreeNode, FileTreeOpts } from "./file-tree.js";
export { buildFileTree } from "./file-tree.js";
export type { BuildManifestOpts } from "./manifest.js";
export { buildManifest, serializeManifest } from "./manifest.js";
export type { SkeletonOpts, SkeletonRow } from "./skeleton.js";
export { buildSkeleton } from "./skeleton.js";
export type { BomItem, DeterminismClass, PackManifest, PackOpts, PackPins } from "./types.js";

import type { PackManifest, PackOpts } from "./types.js";

/**
 * Generate a deterministic code-pack per the M5 9-item BOM contract.
 * Body is implemented across AC-M5-3..7; this AC provides the signature.
 */
export async function generatePack(_opts: PackOpts): Promise<PackManifest> {
  // Implementation lands in AC-M5-3 (manifest) + AC-M5-4..7 (BOM bodies).
  // Throwing here forces the wiring ACs to implement before anything can run.
  throw new Error(
    "generatePack: not yet implemented (AC-M5-3 lands the manifest; AC-M5-4+ fill the BOM bodies)",
  );
}
