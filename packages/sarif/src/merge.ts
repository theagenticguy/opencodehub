/**
 * mergeSarif — concatenate multiple SARIF v2.1.0 logs into one.
 *
 * Semantics:
 * - Validates every input with SarifLogSchema (rejects version != "2.1.0").
 * - Deep-clones each input via structuredClone (Node 17+).
 * - Concats `runs` in argument order. Each run retains its own
 *   tool.driver.name — OpenCodeHub does NOT collapse runs across tools,
 *   because SARIF consumers use tool identity for provenance.
 * - Returns a new log pinned to version "2.1.0"; the first input's
 *   $schema URL is propagated if present, otherwise omitted.
 */

import { type SarifLog, SarifLogSchema, type SarifRun } from "./schemas.js";

export function mergeSarif(logs: readonly SarifLog[]): SarifLog {
  if (logs.length === 0) {
    return { version: "2.1.0", runs: [] };
  }

  const validated: SarifLog[] = logs.map((log, idx) => {
    const result = SarifLogSchema.safeParse(log);
    if (!result.success) {
      throw new Error(
        `mergeSarif: input log at index ${idx} failed schema validation: ${result.error.message}`,
      );
    }
    return result.data;
  });

  const mergedRuns: SarifRun[] = [];
  for (const log of validated) {
    for (const run of log.runs) {
      mergedRuns.push(structuredClone(run));
    }
  }

  const firstSchema = validated[0]?.$schema;
  const out: SarifLog = {
    version: "2.1.0",
    runs: mergedRuns,
  };
  if (typeof firstSchema === "string") {
    out.$schema = firstSchema;
  }
  return out;
}
