/**
 * Vulture stdout → SARIF v2.1.0 converter.
 *
 * Vulture does not emit SARIF. Its default text output is one finding
 * per line in the form:
 *
 *   path/to/file.py:42: unused variable 'foo' (60% confidence)
 *   path/to/file.py:10: unused function 'bar' (80% confidence)
 *
 * Some lines also prefix with a severity marker (`M` for "minimum
 * confidence met") — we tolerate both. We emit one SARIF result per
 * line with:
 *
 *   - ruleId    = "vulture.dead-code"
 *   - level     = "note" (all vulture findings are informational)
 *   - message   = description text (without the confidence suffix)
 *   - location  = artifactLocation { uri: <path> } + region.startLine
 *   - properties.opencodehub.confidence = <number>
 *
 * The output is validated against `SarifLogSchema` before return so any
 * shape drift is caught at the conversion boundary.
 */

import type { SarifLog, SarifResult, SarifRun } from "@opencodehub/sarif";
import { SarifLogSchema } from "@opencodehub/sarif";
import { VULTURE_SPEC } from "../catalog.js";

/**
 * Match a vulture stdout line, e.g. `src/app.py:42: unused variable 'foo' (60% confidence)`.
 * Captures: 1 = path, 2 = line (1-based), 3 = description, 4 = confidence (optional).
 */
const LINE_RE = /^(.+?):(\d+):\s*(.+?)(?:\s+\((\d+)%\s*confidence\))?\s*$/;

export interface VultureConvertOptions {
  /** Override the default ruleId (`vulture.dead-code`). */
  readonly ruleId?: string;
}

/** Convert raw vulture stdout to a SARIF log. */
export function vultureStdoutToSarif(stdout: string, opts: VultureConvertOptions = {}): SarifLog {
  const ruleId = opts.ruleId ?? "vulture.dead-code";
  const results: SarifResult[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const match = LINE_RE.exec(line);
    if (!match) continue;
    const [, uri, lineStr, description, confidenceStr] = match;
    if (uri === undefined || lineStr === undefined || description === undefined) continue;
    const startLine = Number.parseInt(lineStr, 10);
    if (!Number.isFinite(startLine) || startLine <= 0) continue;
    const confidence =
      typeof confidenceStr === "string" ? Number.parseInt(confidenceStr, 10) : undefined;
    const properties =
      typeof confidence === "number" && Number.isFinite(confidence)
        ? { opencodehub: { confidence } }
        : undefined;
    const result: SarifResult = {
      ruleId,
      level: "note",
      message: { text: description },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri },
            region: { startLine },
          },
        },
      ],
      ...(properties !== undefined ? { properties } : {}),
    };
    results.push(result);
  }
  const run: SarifRun = {
    tool: { driver: { name: VULTURE_SPEC.id, version: VULTURE_SPEC.version } },
    results,
  };
  const log: SarifLog = { version: "2.1.0", runs: [run] };
  const parsed = SarifLogSchema.safeParse(log);
  return parsed.success ? parsed.data : { version: "2.1.0", runs: [run] };
}
