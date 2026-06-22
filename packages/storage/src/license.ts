/**
 * License-tier classification — pure, dependency-free.
 *
 * Extracted out of `duckdb-adapter.ts` so consumers (the single-file
 * `SqliteStore`, `listDependencies`, the license-audit surface) can use it
 * WITHOUT transitively importing `@duckdb/node-api`. That top-level native
 * import is exactly what would defeat the lazy-SQLite contract — importing a
 * pure helper must never load a native binding.
 */

/**
 * Map an SPDX-ish license string to one of five tiers. Case-insensitive,
 * tolerant of `-`/word-boundary-delimited family names (e.g. `GPL-3.0-only`,
 * `Apache-2.0`). Empty / unknown input returns `"unknown"`.
 */
export function classifyLicenseTier(
  license: string | undefined,
): "permissive" | "weak-copyleft" | "strong-copyleft" | "proprietary" | "unknown" {
  if (!license || license.trim().length === 0) return "unknown";
  const lower = license.trim().toLowerCase();
  // Strong copyleft — GPL/AGPL family.
  if (/(^|\b|-)agpl(-|$)/i.test(lower) || /(^|\b|-)gpl(-|$)/i.test(lower)) {
    return "strong-copyleft";
  }
  // Weak copyleft — LGPL, MPL, EPL, CDDL, CC-BY-SA.
  if (
    /(^|\b|-)lgpl(-|$)/i.test(lower) ||
    /(^|\b)mpl(-|$)/i.test(lower) ||
    /(^|\b)epl(-|$)/i.test(lower) ||
    /(^|\b)cddl(-|$)/i.test(lower) ||
    /(^|\b)cc-by-sa(-|$)/i.test(lower)
  ) {
    return "weak-copyleft";
  }
  // Permissive — MIT/Apache/BSD/ISC/0BSD/Unlicense/CC0/Zlib.
  if (
    /(^|\b)mit(\b|-|$)/.test(lower) ||
    /(^|\b)apache(-|$)/i.test(lower) ||
    /(^|\b)bsd(-|$)/i.test(lower) ||
    /(^|\b)isc(\b|-|$)/.test(lower) ||
    /(^|\b)0bsd(\b|$)/.test(lower) ||
    /(^|\b)unlicense(\b|$)/.test(lower) ||
    /(^|\b)cc0(\b|-|$)/.test(lower) ||
    /(^|\b)zlib(\b|$)/.test(lower)
  ) {
    return "permissive";
  }
  // Proprietary markers.
  if (/(^|\b)(proprietary|commercial|see license)(\b|$)/i.test(lower)) {
    return "proprietary";
  }
  return "unknown";
}
