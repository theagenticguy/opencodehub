/**
 * @opencodehub/pack — deterministic M5 code-pack BOM.
 *
 * Public surface:
 *   - generatePack(opts): stub here; body lands in AC-M5-3 (manifest + pack_hash)
 *     and AC-M5-4..7 (BOM body implementations).
 *   - Type surface: {BomItem, DeterminismClass, PackManifest, PackOpts, PackPins}.
 *
 * AC-M5-1 provides the empty-but-wired scaffold so subsequent ACs can
 * parallel-implement against stable types.
 */

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
