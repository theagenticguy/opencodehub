/**
 * diffSarif / applyBaselineState — snapshot-diff SARIF v2.1.0 logs by
 * `partialFingerprints["opencodehub/v1"]` and tag each result with a
 * SARIF 2.1.0 `baselineState` ∈ {"new", "unchanged", "updated", "absent"}.
 *
 * Design notes:
 * - The match key is the `opencodehub/v1` partial fingerprint — a content
 *   + context-window hash emitted by `enrichWithFingerprints` in
 *   `./fingerprint.ts`. When absent on one or both sides, we fall back to
 *   a tuple of `(ruleId, artifactLocation.uri, region.startLine)`.
 * - Rename-follow continuity: if a fingerprint is present in the baseline
 *   but no result in the current log has that fingerprint *at the same
 *   file path*, we consult the caller-supplied `renameChainFor(filePath)`
 *   to see whether the baseline file survives under a new path. If a
 *   current Result at a file whose rename-history-chain contains the
 *   baseline path carries a matching fingerprint, we treat the two as
 *   the same finding. This honors the `FileNode.renameHistoryChain`
 *   wiring from `phases/temporal.ts`.
 * - All output arrays are sorted deterministically by
 *   `(ruleId, uri, startLine)` so the diff is stable across runs.
 * - `applyBaselineState` deep-clones its input (never mutates) and tags
 *   every result in the *current* log. Baseline-only results are NOT
 *   re-emitted into the output log — use the `fixed` bucket from
 *   `diffSarif` for those (their `baselineState` is "absent").
 * - GHAS contract: `partialFingerprints`, `fingerprints`, `ruleId`, and
 *   `artifactLocation.uri` are never mutated. We only write
 *   `result.baselineState`.
 */

import { type SarifLog, SarifLogSchema, type SarifResult } from "./schemas.js";

/**
 * SARIF 2.1.0 `result.baselineState` enum. The spec permits all four; we
 * only write these four values and never blank them.
 */
export type BaselineState = "new" | "unchanged" | "updated" | "absent";

/** Result bucketing emitted by {@link diffSarif}. */
export interface DiffResult {
  /** Fingerprints present in `current` but not in `baseline`. */
  readonly new: readonly SarifResult[];
  /** Fingerprints present in `baseline` but not in `current` (now resolved). */
  readonly fixed: readonly SarifResult[];
  /** Fingerprints present on both sides with byte-identical serialization. */
  readonly unchanged: readonly SarifResult[];
  /** Same fingerprint on both sides, different non-key fields (message, severity, etc.). */
  readonly updated: readonly SarifResult[];
}

/**
 * Optional rename-chain resolver: given a filePath seen in the *current*
 * log, return the list of paths that path has been historically known as
 * (per `FileNode.renameHistoryChain`). If omitted, rename-follow is
 * skipped and renamed files will show up as (fixed, new) pairs.
 */
export type RenameChainResolver = (filePath: string) => readonly string[];

export interface DiffOptions {
  readonly renameChainFor?: RenameChainResolver;
}

const OPENCODEHUB_KEY = "opencodehub/v1";

interface ResultLocator {
  readonly ruleId: string;
  readonly uri: string;
  readonly startLine: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function locator(result: SarifResult): ResultLocator {
  const ruleId = typeof result.ruleId === "string" ? result.ruleId : "";
  const physical = result.locations?.[0]?.physicalLocation;
  const uri =
    typeof physical?.artifactLocation.uri === "string" ? physical.artifactLocation.uri : "";
  const startLine = typeof physical?.region?.startLine === "number" ? physical.region.startLine : 0;
  return { ruleId, uri, startLine };
}

function fingerprintOf(result: SarifResult): string | undefined {
  const pf = result.partialFingerprints;
  if (!isPlainObject(pf)) return undefined;
  const candidate = (pf as Record<string, unknown>)[OPENCODEHUB_KEY];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

/**
 * Deterministic match key. Prefers the `opencodehub/v1` fingerprint;
 * falls back to `ruleId\x00uri\x00startLine`. The fallback is namespaced
 * with `tuple:` so it can't collide with a hex fingerprint.
 */
function matchKey(result: SarifResult): string {
  const fp = fingerprintOf(result);
  if (fp !== undefined) return `fp:${fp}`;
  const loc = locator(result);
  return `tuple:${loc.ruleId}\x00${loc.uri}\x00${loc.startLine}`;
}

/**
 * Fingerprint-only key (no fallback). Used by rename-follow to decide
 * whether a renamed file's result is the same observation — falling back
 * to the (ruleId, uri, line) tuple across a rename would always miss
 * because the uri changed, so we only accept true fingerprint hits.
 */
function fingerprintKey(result: SarifResult): string | undefined {
  const fp = fingerprintOf(result);
  return fp === undefined ? undefined : `fp:${fp}`;
}

/**
 * Canonical JSON: object keys are sorted recursively so `{a:1,b:2}` and
 * `{b:2,a:1}` produce the same string. Arrays preserve order (order is
 * semantically meaningful for `locations`, `codeFlows`, etc.). Handles
 * primitives, objects, arrays, and `undefined` (dropped, same as
 * `JSON.stringify`).
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * Strip `baselineState` (if present) before serialization so that two
 * results identical except for a prior baselineState tag still compare as
 * `unchanged`. `properties.opencodehub.*` is excluded the same way — it's
 * enrichment, not ground truth. Everything else (message, level, region,
 * etc.) is part of the equality signature.
 */
function equalitySignature(result: SarifResult): string {
  const clone = structuredClone(result) as Record<string, unknown>;
  delete clone["baselineState"];
  const props = clone["properties"];
  if (isPlainObject(props)) {
    const cloneProps = { ...(props as Record<string, unknown>) };
    delete cloneProps["opencodehub"];
    clone["properties"] = cloneProps;
  }
  return canonicalJson(clone);
}

function indexResults(log: SarifLog): Map<string, SarifResult> {
  const out = new Map<string, SarifResult>();
  for (const run of log.runs) {
    const results = run.results;
    if (!Array.isArray(results)) continue;
    for (const r of results) {
      if (r === undefined) continue;
      const key = matchKey(r);
      // First occurrence wins; duplicates within a single log are uncommon
      // and the GHAS dedup contract already filters them at scanner level.
      if (!out.has(key)) out.set(key, r);
    }
  }
  return out;
}

function compareLocators(a: ResultLocator, b: ResultLocator): number {
  if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
  if (a.uri !== b.uri) return a.uri < b.uri ? -1 : 1;
  return a.startLine - b.startLine;
}

function sortResults(results: readonly SarifResult[]): readonly SarifResult[] {
  return [...results].sort((a, b) => compareLocators(locator(a), locator(b)));
}

/**
 * Check whether the two results differ only in the primary file location
 * URI AND the current URI's rename chain contains the baseline URI. When
 * both hold, the rename is the sole change — the finding is `unchanged`,
 * not `updated`.
 */
function isRenameOnlyChange(
  baselineResult: SarifResult,
  currentResult: SarifResult,
  renameChainFor: RenameChainResolver | undefined,
): boolean {
  if (renameChainFor === undefined) return false;
  const baselineUri = locator(baselineResult).uri;
  const currentUri = locator(currentResult).uri;
  if (baselineUri === currentUri || baselineUri.length === 0 || currentUri.length === 0) {
    return false;
  }
  const chain = renameChainFor(currentUri);
  if (!chain.includes(baselineUri)) return false;
  // Compare signatures after rewriting the baseline's URI to the current
  // URI — if they match, the rename was the only diff.
  const rewrittenBaseline = structuredClone(baselineResult) as SarifResult;
  const physical = rewrittenBaseline.locations?.[0]?.physicalLocation;
  if (physical !== undefined) {
    (physical.artifactLocation as { uri: string }).uri = currentUri;
  }
  return equalitySignature(rewrittenBaseline) === equalitySignature(currentResult);
}

/**
 * Try to match a baseline-only entry against the current log via the
 * caller-supplied rename chain. The semantics are "same fingerprint, the
 * baseline path appears in some current file's history" → treat as the
 * same finding, meaning the baseline entry is NOT actually "fixed" and
 * the matching current entry is NOT actually "new".
 */
function resolveRenameMatch(
  baselineResult: SarifResult,
  currentByKey: ReadonlyMap<string, SarifResult>,
  renameChainFor: RenameChainResolver | undefined,
): { readonly currentKey: string; readonly currentResult: SarifResult } | undefined {
  if (renameChainFor === undefined) return undefined;
  const baselineFp = fingerprintKey(baselineResult);
  if (baselineFp === undefined) return undefined;
  const baselineUri = locator(baselineResult).uri;
  if (baselineUri.length === 0) return undefined;

  // Scan current-side entries with the SAME fingerprint but a different
  // uri; if any of their rename chains contains the baseline uri, that's
  // our cross-rename match.
  for (const [key, currentResult] of currentByKey) {
    if (key !== baselineFp) continue;
    const currentUri = locator(currentResult).uri;
    if (currentUri === baselineUri) continue;
    const chain = renameChainFor(currentUri);
    if (chain.includes(baselineUri)) {
      return { currentKey: key, currentResult };
    }
  }
  return undefined;
}

/**
 * Bucket each result in `current` and `baseline` as new / unchanged /
 * updated / fixed. The output is a pure data structure; callers decide
 * whether to tag `baselineState` on a log (see `applyBaselineState`).
 */
export function diffSarif(
  baseline: SarifLog,
  current: SarifLog,
  options: DiffOptions = {},
): DiffResult {
  const baselineParsed = SarifLogSchema.safeParse(baseline);
  if (!baselineParsed.success) {
    throw new Error(
      `diffSarif: baseline failed schema validation: ${baselineParsed.error.message}`,
    );
  }
  const currentParsed = SarifLogSchema.safeParse(current);
  if (!currentParsed.success) {
    throw new Error(`diffSarif: current failed schema validation: ${currentParsed.error.message}`);
  }

  const baselineIdx = indexResults(baselineParsed.data);
  const currentIdx = indexResults(currentParsed.data);

  const newResults: SarifResult[] = [];
  const fixedResults: SarifResult[] = [];
  const unchangedResults: SarifResult[] = [];
  const updatedResults: SarifResult[] = [];

  // Track which current-side keys we already matched so we don't re-emit
  // them when iterating the baseline side. Seeded with every intersecting
  // key and updated as rename-follow resolves cross-path matches.
  const matchedCurrentKeys = new Set<string>();

  // Pass 1: iterate current-side results.
  for (const [key, currentResult] of currentIdx) {
    const baselineResult = baselineIdx.get(key);
    if (baselineResult === undefined) {
      newResults.push(currentResult);
      continue;
    }
    matchedCurrentKeys.add(key);
    if (equalitySignature(baselineResult) === equalitySignature(currentResult)) {
      unchangedResults.push(currentResult);
      continue;
    }
    // Same fingerprint, different serialization. If the only change is a
    // file rename recorded in `renameChainFor`, treat it as `unchanged` —
    // otherwise the finding is `updated`.
    if (isRenameOnlyChange(baselineResult, currentResult, options.renameChainFor)) {
      unchangedResults.push(currentResult);
    } else {
      updatedResults.push(currentResult);
    }
  }

  // Pass 2: iterate baseline-only entries; maybe resolve them via rename.
  for (const [key, baselineResult] of baselineIdx) {
    if (currentIdx.has(key)) continue; // already handled in pass 1
    const rename = resolveRenameMatch(baselineResult, currentIdx, options.renameChainFor);
    if (rename !== undefined) {
      // The baseline's fingerprint survives across a rename. Re-bucket the
      // current-side entry we previously tagged `new` back into unchanged
      // / updated based on the SARIF-payload comparison.
      const idx = newResults.indexOf(rename.currentResult);
      if (idx >= 0) newResults.splice(idx, 1);
      matchedCurrentKeys.add(rename.currentKey);
      if (equalitySignature(baselineResult) === equalitySignature(rename.currentResult)) {
        unchangedResults.push(rename.currentResult);
      } else {
        updatedResults.push(rename.currentResult);
      }
      continue;
    }
    fixedResults.push(baselineResult);
  }

  return {
    new: sortResults(newResults),
    fixed: sortResults(fixedResults),
    unchanged: sortResults(unchangedResults),
    updated: sortResults(updatedResults),
  };
}

/**
 * Return a deep-cloned copy of `current` in which every Result carries a
 * `baselineState` tag. Baseline-only findings (`fixed` in diff terms) are
 * NOT re-added into the output — the caller can surface those separately
 * (e.g., in a PR comment) via the DiffResult bucket.
 */
export function applyBaselineState(
  current: SarifLog,
  baseline: SarifLog,
  options: DiffOptions = {},
): SarifLog {
  const parsed = SarifLogSchema.safeParse(current);
  if (!parsed.success) {
    throw new Error(
      `applyBaselineState: current failed schema validation: ${parsed.error.message}`,
    );
  }
  const diff = diffSarif(baseline, current, options);
  const byIdentity = new Map<SarifResult, BaselineState>();
  for (const r of diff.new) byIdentity.set(r, "new");
  for (const r of diff.unchanged) byIdentity.set(r, "unchanged");
  for (const r of diff.updated) byIdentity.set(r, "updated");

  // `diffSarif` returned results that are the validated copies — not the
  // ones on `current` we're about to clone. Key the tag by matchKey so we
  // can look it up on the cloned side.
  const byKey = new Map<string, BaselineState>();
  for (const [result, state] of byIdentity) {
    byKey.set(matchKey(result), state);
  }

  const cloned = structuredClone(parsed.data) as SarifLog;
  for (const run of cloned.runs) {
    const results = run.results;
    if (!Array.isArray(results)) continue;
    for (const r of results) {
      if (r === undefined) continue;
      const state = byKey.get(matchKey(r));
      if (state !== undefined) {
        (r as unknown as { baselineState: BaselineState }).baselineState = state;
      }
    }
  }
  return cloned;
}
