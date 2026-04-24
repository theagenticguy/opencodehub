/**
 * Normalize informal license strings into SPDX-2.1 identifiers.
 *
 * Thin wrapper around `spdx-correct` (Apache-2.0): forwards non-empty
 * input to the corrector and returns `undefined` for blank / explicitly
 * unknown values so downstream dedup logic can prefer entries that
 * carry a real license. When `spdx-correct` cannot recognise the input
 * we pass the trimmed original through — MCP `license_audit` still
 * classifies it (e.g. a non-SPDX custom identifier triggers the
 * UNKNOWN/WARN branch if it doesn't match any copyleft / proprietary
 * pattern).
 */

import correct from "spdx-correct";

/** Normalized SPDX id, or `undefined` when no license was declared. */
export function spdxNormalize(raw: string | undefined | null): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.toUpperCase() === "UNKNOWN") return undefined;
  // `spdx-correct` returns a normalized SPDX id for common aliases
  // (`mit` -> `MIT`, `Apache 2` -> `Apache-2.0`), or `null` if the
  // input is too far from any known id. We fall back to the trimmed
  // original in that case to preserve whatever signal the manifest
  // provided.
  const normalized = correct(trimmed);
  return normalized ?? trimmed;
}
