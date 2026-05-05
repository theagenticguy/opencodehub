/**
 * `parseCobolDeep()` — public entry point for the bridge.
 *
 * Algorithm:
 *   1. Batch the input paths (default 64 per JVM invocation) to amortize
 *      the ~500 ms JVM startup cost.
 *   2. For each batch, call `runBatch()` in `subprocess.ts`.
 *   3. On a `crashed` outcome, silently reparse every path in that batch
 *      through `fallbackParseBatch()` (regex hot path) and emit one
 *      diagnostic note so the ingestion phase can surface a graph-level
 *      marker.
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
import { recordToElement, runBatch } from "./subprocess.js";
import type { CobolDeepElement, CobolDeepResult, ParseCobolDeepOptions } from "./types.js";

const DEFAULT_BATCH_SIZE = 64;

export async function parseCobolDeep(
  paths: readonly string[],
  opts: ParseCobolDeepOptions,
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
    const outcome = await runBatch(batch, opts);

    if (outcome.kind === "crashed") {
      fellBackToRegex = true;
      const note =
        `cobol-proleap: JVM batch of ${batch.length} file(s) crashed; ` +
        `falling back to regex hot path. Reason: ${outcome.reason}`;
      diagnostics.push(note);
      log(note);
      const { elements: fallbackElems, notes } = await fallbackParseBatch(batch);
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
