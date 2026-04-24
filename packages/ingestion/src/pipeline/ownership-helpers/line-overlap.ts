/**
 * Given a symbol's line range and a file's per-line blame attribution,
 * compute each contributor's normalised line share.
 *
 * The formula is deliberately simple: count how many of the symbol's lines
 * each contributor claims, divide by the symbol's line count, and emit the
 * result sorted by email hash for determinism.
 *
 * File-level shares reuse this helper by passing `startLine=1` and
 * `endLine=fileLineCount`.
 */

import type { LineOwner } from "./git-blame-batcher.js";

export interface ContributorWeight {
  readonly email: string;
  readonly lines: number;
  /** Share in `[0, 1]` of the symbol's lines attributed to this contributor. */
  readonly weight: number;
}

export interface AttributionOptions {
  /** Minimum share to keep; defaults to 0 (no filter). */
  readonly minWeight?: number;
}

/**
 * Build a map from email → {lines, weight} for every contributor with at
 * least one line in the `[startLine, endLine]` range.
 *
 * `fileBlame` is expected to be ordered by line ascending; the caller obtains
 * it via `batchBlame`. Lines outside the range are ignored; lines inside
 * the range with no blame entry (a rare parse-skip case) contribute to the
 * denominator but not to any contributor's numerator.
 */
export function attributeSymbolOwnership(
  startLine: number,
  endLine: number,
  fileBlame: readonly LineOwner[],
  opts: AttributionOptions = {},
): readonly ContributorWeight[] {
  if (endLine < startLine) return [];
  const span = endLine - startLine + 1;
  if (span <= 0) return [];
  const counts = new Map<string, number>();
  for (const owner of fileBlame) {
    if (owner.line < startLine || owner.line > endLine) continue;
    counts.set(owner.email, (counts.get(owner.email) ?? 0) + 1);
  }
  if (counts.size === 0) return [];
  const minWeight = opts.minWeight ?? 0;
  const entries: ContributorWeight[] = [];
  for (const [email, lines] of counts) {
    const weight = lines / span;
    if (weight < minWeight) continue;
    entries.push({ email, lines, weight });
  }
  // Sort by descending weight, then ascending email for stable tiebreaks.
  entries.sort((a, b) => {
    if (a.weight !== b.weight) return b.weight - a.weight;
    return a.email < b.email ? -1 : a.email > b.email ? 1 : 0;
  });
  return entries;
}

/** Sum of lines attributed to each contributor across the whole file. */
export function attributeFileOwnership(
  fileBlame: readonly LineOwner[],
): readonly ContributorWeight[] {
  if (fileBlame.length === 0) return [];
  let maxLine = 0;
  for (const owner of fileBlame) {
    if (owner.line > maxLine) maxLine = owner.line;
  }
  return attributeSymbolOwnership(1, maxLine, fileBlame);
}
