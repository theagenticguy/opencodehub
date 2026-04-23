/**
 * ty stdout → SARIF v2.1.0 converter.
 *
 * ty (beta Python type-checker from Astral) emits mypy-style diagnostics:
 *
 *   src/app.py:42: error: Argument 1 to "f" has incompatible type ... [arg-type]
 *   src/app.py:10:5: warning: Missing type annotation [annotation-unchecked]
 *   src/app.py:99: note: See https://... [ref]
 *
 * Column is optional. The trailing `[rule-id]` suffix carries the ty
 * diagnostic code; when absent we fall back to `ty.<severity>`.
 *
 *   - ruleId   = rule-id suffix (e.g. "arg-type") prefixed with `ty.`
 *   - level    = error|warning|note based on the severity token
 *   - message  = the diagnostic text (suffix stripped)
 *   - location = artifactLocation { uri: <path> } + region.startLine [+ startColumn]
 *
 * Output is validated against `SarifLogSchema` before return.
 */

import type { SarifLog, SarifResult, SarifRun } from "@opencodehub/sarif";
import { SarifLogSchema } from "@opencodehub/sarif";
import { TY_SPEC } from "../catalog.js";

/**
 * Match ty/mypy-style lines:
 *   <path>:<line>[:<col>]: <severity>: <message>[ [<rule-id>]]
 */
const LINE_RE =
  /^(.+?):(\d+)(?::(\d+))?:\s*(error|warning|note|info):\s*(.+?)(?:\s+\[([^\]]+)\])?\s*$/;

type TySeverity = "error" | "warning" | "note" | "info";

/** Convert raw ty stdout to a SARIF log. */
export function tyStdoutToSarif(stdout: string): SarifLog {
  const results: SarifResult[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const match = LINE_RE.exec(line);
    if (!match) continue;
    const [, uri, lineStr, colStr, severity, message, ruleIdRaw] = match;
    if (
      uri === undefined ||
      lineStr === undefined ||
      severity === undefined ||
      message === undefined
    ) {
      continue;
    }
    const startLine = Number.parseInt(lineStr, 10);
    if (!Number.isFinite(startLine) || startLine <= 0) continue;
    const startColumn =
      typeof colStr === "string" && colStr.length > 0 ? Number.parseInt(colStr, 10) : undefined;
    const region: { startLine: number; startColumn?: number } = { startLine };
    if (typeof startColumn === "number" && Number.isFinite(startColumn) && startColumn > 0) {
      region.startColumn = startColumn;
    }
    const sev = severity as TySeverity;
    const level = levelFor(sev);
    const ruleId =
      typeof ruleIdRaw === "string" && ruleIdRaw.length > 0 ? `ty.${ruleIdRaw}` : `ty.${sev}`;
    const result: SarifResult = {
      ruleId,
      level,
      message: { text: message },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri },
            region,
          },
        },
      ],
    };
    results.push(result);
  }
  const run: SarifRun = {
    tool: { driver: { name: TY_SPEC.id, version: TY_SPEC.version } },
    results,
  };
  const log: SarifLog = { version: "2.1.0", runs: [run] };
  const parsed = SarifLogSchema.safeParse(log);
  return parsed.success ? parsed.data : { version: "2.1.0", runs: [run] };
}

function levelFor(sev: TySeverity): "none" | "note" | "warning" | "error" {
  switch (sev) {
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "note":
    case "info":
      return "note";
    default:
      return "warning";
  }
}
