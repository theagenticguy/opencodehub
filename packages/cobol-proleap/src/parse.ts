/**
 * `parseCobolDeep()` — public entry point for the bridge.
 *
 * Algorithm:
 *   1. Batch the input paths (default 64 per JVM invocation) to amortize
 *      the ~500 ms JVM startup cost.
 *   2. For each batch, call `runBatch()` in `subprocess.ts`.
 *   3. On a `crashed` outcome, salvage any authoritative records the JVM
 *      emitted before it died (`outcome.partial`): project those at
 *      `confidence:"parse"`, then reparse only the paths NOT covered by a
 *      partial record through `fallbackParseBatch()` (regex hot path), and
 *      emit one diagnostic note so the ingestion phase can surface a
 *      graph-level marker.
 *   4. On `ok`, project the records onto the public `CobolDeepElement`
 *      shape. A `diagnostic` record inside an otherwise-ok batch
 *      triggers a per-file fallback for that specific path — the
 *      wrapper emits diagnostics from its own per-file try/catch, so
 *      the JVM may report ok overall but flag a few bad files.
 *
 * Fails FAST on structural preconditions (JAR missing, JRE < 17): the
 * caller must handle those upfront because they are user-actionable.
 */

import { fallbackParseBatch, fallbackParseFile } from "./fallback.js";
import { type RunOutcome, recordToElement, runBatch } from "./subprocess.js";
import type { CobolDeepElement, CobolDeepResult, ParseCobolDeepOptions } from "./types.js";

const DEFAULT_BATCH_SIZE = 64;

/**
 * Batch runner signature. Defaults to the real JVM {@link runBatch}; the
 * crash-salvage path is exercised through an injected runner so the test
 * suite never needs a live JVM on PATH.
 */
export type BatchRunner = (
  batch: readonly string[],
  opts: ParseCobolDeepOptions,
) => Promise<RunOutcome>;

export async function parseCobolDeep(
  paths: readonly string[],
  opts: ParseCobolDeepOptions,
  run: BatchRunner = runBatch,
): Promise<CobolDeepResult> {
  if (paths.length === 0) {
    return { elements: [], diagnostics: [], fellBackToRegex: false };
  }
  const log = opts.log ?? ((): void => undefined);
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);

  const elements: CobolDeepElement[] = [];
  const diagnostics: string[] = [];
  let fellBackToRegex = false;

  for (let i = 0; i < paths.length; i += batchSize) {
    const batch = paths.slice(i, i + batchSize);
    const outcome = await run(batch, opts);

    if (outcome.kind === "crashed") {
      fellBackToRegex = true;
      // Salvage authoritative records the JVM emitted before it died. Each
      // file with at least one ASG element keeps its high-confidence
      // emissions; only the paths the JVM never finished — including any it
      // reached but flagged with a per-file diagnostic — are re-derived via
      // the regex fallback.
      const covered = new Set<string>();
      for (const rec of outcome.partial) {
        if (rec.kind === "diagnostic") {
          diagnostics.push(`cobol-proleap: ASG crash on ${rec.filePath}: ${rec.message}`);
          continue;
        }
        const el = recordToElement(rec);
        if (el !== undefined) {
          covered.add(rec.filePath);
          elements.push(el);
        }
      }
      const uncovered = batch.filter((path) => !covered.has(path));
      const note =
        `cobol-proleap: JVM batch of ${batch.length} file(s) crashed; ` +
        `salvaged ${covered.size} file(s), falling back to regex hot path for ` +
        `${uncovered.length} file(s). Reason: ${outcome.reason}`;
      diagnostics.push(note);
      log(note);
      const { elements: fallbackElems, notes } = await fallbackParseBatch(uncovered);
      elements.push(...fallbackElems);
      diagnostics.push(...notes);
      continue;
    }

    // ok batch: project records, but re-run the regex fallback for any
    // path whose only emission was a diagnostic entry. The wrapper's
    // per-file try/catch emits those when an individual file crashes
    // inside the ASG walker while the JVM process itself stays alive.
    const diagnosticPaths = new Set<string>();
    for (const rec of outcome.records) {
      if (rec.kind === "diagnostic") {
        diagnosticPaths.add(rec.filePath);
        diagnostics.push(`cobol-proleap: ASG crash on ${rec.filePath}: ${rec.message}`);
        continue;
      }
      const el = recordToElement(rec);
      if (el !== undefined) elements.push(el);
    }
    if (diagnosticPaths.size > 0) {
      fellBackToRegex = true;
      for (const path of diagnosticPaths) {
        const { elements: fallbackElems, notes } = await fallbackParseFile(path);
        elements.push(...fallbackElems);
        diagnostics.push(...notes);
      }
    }
  }

  return { elements, diagnostics, fellBackToRegex };
}
