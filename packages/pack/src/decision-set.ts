/**
 * Decision set + `decisionHash` (spec 011 / ADR 0020).
 *
 * The pack's contract pivoted from byte-identity to **decision-equivalence**
 * (ADR 0020): two packs built from the same inputs are equivalent iff they
 * select the **same decision set** — the same files + byte ranges, under the
 * same budget — regardless of `tokenCount`, `pins`, chunk text bytes, or
 * serialization. Byte-identity (`packHash`) stays a cheap *sufficient witness*.
 *
 * This module computes the decision set as a normalized projection of the two
 * pack artifacts that already encode "which file, which byte range, selected":
 *   - `ast-chunks.jsonl` — each row's `(path, startByte, endByte)` triple.
 *   - `context-bom.json` — each file component's merged `byteRanges`.
 * ast-chunks is preferred; the context-bom is the fallback/cross-check.
 *
 * The projection deliberately EXCLUDES the incidental fields whose drift is
 * decision-irrelevant: `tokenCount`, `pins` (chonkie version, grammar
 * commits), chunk text, per-file `fileHash`, and provenance (`commit`).
 * `decisionHash` is `sha256(canonicalJson(decisionSet))` — the same RFC 8785
 * machinery as `packHash`, so two `replay` runs over the same packs serialize
 * identically.
 */

import { canonicalJson, sha256Hex } from "@opencodehub/core-types";
import { type ByteSpan, mergeSpans } from "./context-bom.js";

/** A `[start, end)` byte range, surfaced as a 2-tuple for compact hashing. */
export type RangeTuple = readonly [start: number, end: number];

/** One file's selection: its path + the merged, sorted byte ranges chosen. */
export interface Selection {
  readonly path: string;
  /** Sorted, non-overlapping `[start, end)` ranges (from {@link mergeSpans}). */
  readonly ranges: readonly RangeTuple[];
}

/** The normalized, incidental-free decision set of a pack. */
export interface DecisionSet {
  /** The budget the selection was made under — different budgets differ by design. */
  readonly budgetTokens: number;
  /** Selections sorted by path ASC; each path's ranges sorted + merged. */
  readonly selections: readonly Selection[];
}

/** A chunk row as read from `ast-chunks.jsonl` (the {@link AstChunk} shape). */
interface ChunkLike {
  readonly path: string;
  readonly startByte: number;
  readonly endByte: number;
}

/**
 * Build the decision set from AST chunks. Groups chunks by path, merges each
 * path's spans into sorted non-overlapping ranges, and sorts paths. Pure.
 */
export function decisionSetFromChunks(
  chunks: readonly ChunkLike[],
  budgetTokens: number,
): DecisionSet {
  const byPath = new Map<string, ByteSpan[]>();
  for (const c of chunks) {
    const spans = byPath.get(c.path);
    const span: ByteSpan = { start: c.startByte, end: c.endByte };
    if (spans === undefined) byPath.set(c.path, [span]);
    else spans.push(span);
  }
  return assembleDecisionSet(byPath, budgetTokens);
}

/**
 * Build the decision set from per-path byte spans (e.g. the context-bom's
 * `byteRanges`). The fallback path when ast-chunks is absent. Pure.
 */
export function decisionSetFromByteRanges(
  byteRangesByPath: ReadonlyMap<string, readonly ByteSpan[]>,
  budgetTokens: number,
): DecisionSet {
  const byPath = new Map<string, ByteSpan[]>();
  for (const [path, spans] of byteRangesByPath) {
    byPath.set(path, [...spans]);
  }
  return assembleDecisionSet(byPath, budgetTokens);
}

/** Merge + sort the per-path spans into the canonical {@link DecisionSet}. */
function assembleDecisionSet(
  byPath: ReadonlyMap<string, ByteSpan[]>,
  budgetTokens: number,
): DecisionSet {
  const selections: Selection[] = [];
  for (const [path, spans] of byPath) {
    const merged = mergeSpans(spans);
    if (merged.length === 0) continue; // a path with no real ranges is not a selection
    selections.push({
      path,
      ranges: merged.map((s) => [s.start, s.end] as const),
    });
  }
  selections.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { budgetTokens, selections };
}

/**
 * The `decisionHash` — `sha256(canonicalJson(decisionSet))`. Same RFC 8785
 * helper as `packHash`, so it is byte-stable across processes given the same
 * decision set.
 */
export function decisionHash(set: DecisionSet): string {
  return sha256Hex(canonicalDecisionSet(set));
}

/** Canonical JSON of a decision set — exported so callers can hash/compare it. */
export function canonicalDecisionSet(set: DecisionSet): string {
  // The DecisionSet shape is already canonical (sorted selections, merged
  // ranges); routing through canonicalJson sorts object keys + fixes number
  // format so the bytes match packHash's discipline exactly.
  return canonicalJson(set);
}

/** The structured difference between two decision sets (the `DIVERGED` output). */
export interface DecisionDiff {
  /** True when the two sets select identically (same paths + ranges). */
  readonly equivalent: boolean;
  /** Paths selected in A but not B. */
  readonly onlyInA: readonly string[];
  /** Paths selected in B but not A. */
  readonly onlyInB: readonly string[];
  /** Shared paths whose merged ranges differ, with both sides' ranges. */
  readonly rangeDeltas: readonly {
    readonly path: string;
    readonly a: readonly RangeTuple[];
    readonly b: readonly RangeTuple[];
  }[];
}

/**
 * Diff two decision sets. Names paths present in only one set and, for shared
 * paths, the range deltas. `equivalent` is true iff there are no path or range
 * differences. Pure; the budget is compared by the caller (a budget mismatch
 * is reported distinctly, not folded into this diff).
 */
export function diffDecisionSets(a: DecisionSet, b: DecisionSet): DecisionDiff {
  const aByPath = new Map(a.selections.map((s) => [s.path, s.ranges]));
  const bByPath = new Map(b.selections.map((s) => [s.path, s.ranges]));

  const onlyInA: string[] = [];
  const onlyInB: string[] = [];
  const rangeDeltas: { path: string; a: readonly RangeTuple[]; b: readonly RangeTuple[] }[] = [];

  for (const [path, aRanges] of aByPath) {
    const bRanges = bByPath.get(path);
    if (bRanges === undefined) {
      onlyInA.push(path);
    } else if (!rangesEqual(aRanges, bRanges)) {
      rangeDeltas.push({ path, a: aRanges, b: bRanges });
    }
  }
  for (const path of bByPath.keys()) {
    if (!aByPath.has(path)) onlyInB.push(path);
  }

  onlyInA.sort();
  onlyInB.sort();
  rangeDeltas.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));

  return {
    equivalent: onlyInA.length === 0 && onlyInB.length === 0 && rangeDeltas.length === 0,
    onlyInA,
    onlyInB,
    rangeDeltas,
  };
}

function rangesEqual(a: readonly RangeTuple[], b: readonly RangeTuple[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const ra = a[i];
    const rb = b[i];
    if (ra === undefined || rb === undefined) return false;
    if (ra[0] !== rb[0] || ra[1] !== rb[1]) return false;
  }
  return true;
}
