/**
 * ClamAV stdout → SARIF v2.1.0 converter.
 *
 * `clamscan --recursive --infected --no-summary` emits one line per
 * infected file:
 *
 *   /abs/path/to/file.bin: Win.Trojan.Agent-12345 FOUND
 *   /abs/path/other.zip:  Eicar-Test-Signature FOUND
 *
 * Exit codes per clamscan(1):
 *   0 → no virus found (empty SARIF)
 *   1 → virus(es) found (parse FOUND lines)
 *   2 → error (empty SARIF + stderr warning propagated via the wrapper)
 *
 * We emit one SARIF result per FOUND line:
 *
 *   - ruleId   = `clamav.<SigName>`
 *   - level    = "error"
 *   - message  = `<SigName> detected in <path>`
 *   - location = artifactLocation { uri: <path> }
 *   - properties.opencodehub.signature = <SigName>
 *
 * Output is validated against `SarifLogSchema` before return.
 */

import type { SarifLog, SarifResult, SarifRun } from "@opencodehub/sarif";
import { SarifLogSchema } from "@opencodehub/sarif";
import { CLAMAV_SPEC } from "../catalog.js";

/** Match a `<path>: <SigName> FOUND` line. */
const LINE_RE = /^(.+?):\s+(\S.*?)\s+FOUND\s*$/;

/** Convert raw clamscan stdout to a SARIF log. */
export function clamavStdoutToSarif(stdout: string): SarifLog {
  const results: SarifResult[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const match = LINE_RE.exec(line);
    if (!match) continue;
    const [, uri, signature] = match;
    if (uri === undefined || signature === undefined) continue;
    if (signature.length === 0) continue;
    const result: SarifResult = {
      ruleId: `clamav.${signature}`,
      level: "error",
      message: { text: `${signature} detected in ${uri}` },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri },
          },
        },
      ],
      properties: {
        opencodehub: { signature },
      },
    };
    results.push(result);
  }
  const run: SarifRun = {
    tool: { driver: { name: CLAMAV_SPEC.id, version: CLAMAV_SPEC.version } },
    results,
  };
  const log: SarifLog = { version: "2.1.0", runs: [run] };
  const parsed = SarifLogSchema.safeParse(log);
  return parsed.success ? parsed.data : { version: "2.1.0", runs: [run] };
}
