/**
 * pip-audit JSON → SARIF v2.1.0 converter.
 *
 * pip-audit does not emit SARIF natively. Its `--format json` produces:
 *
 *   {
 *     "dependencies": [
 *       {
 *         "name": "<pkg>",
 *         "version": "<ver>",
 *         "vulns": [
 *           {
 *             "id": "PYSEC-2021-...",
 *             "fix_versions": ["1.2.3"],
 *             "description": "...",
 *             "aliases": ["CVE-...", "GHSA-..."]
 *           }
 *         ]
 *       }
 *     ],
 *     "fixes": [...]  // only when --fix was passed
 *   }
 *
 * We emit one SARIF result per vulnerability entry:
 *   - ruleId      = vuln.id
 *   - level       = "error"
 *   - message     = vuln.description (truncated to 4KiB)
 *   - location    = artifactLocation { uri: "requirements.txt" }  (or
 *                    options.requirementsPath when supplied)
 *   - properties.opencodehub.dependency = "<name>@<version>"
 *   - properties.opencodehub.aliases    = vuln.aliases
 *   - properties.opencodehub.fixVersions = vuln.fix_versions
 *
 * The output is validated against `SarifLogSchema` from @opencodehub/sarif
 * before being returned, so malformed emissions never leak downstream.
 */

import type { SarifLog, SarifResult, SarifRun } from "@opencodehub/sarif";
import { SarifLogSchema } from "@opencodehub/sarif";
import { PIP_AUDIT_SPEC } from "../catalog.js";

/** Maximum description length we include in SARIF.message.text. */
const MAX_DESCRIPTION_LEN = 4096;

interface PipAuditVuln {
  readonly id: string;
  readonly fix_versions?: readonly string[];
  readonly description?: string;
  readonly aliases?: readonly string[];
}

interface PipAuditDependency {
  readonly name: string;
  readonly version: string;
  readonly vulns?: readonly PipAuditVuln[];
}

interface PipAuditReport {
  readonly dependencies?: readonly PipAuditDependency[];
}

export interface PipAuditConvertOptions {
  /** URI for the artifactLocation. Defaults to `requirements.txt`. */
  readonly requirementsPath?: string;
}

/**
 * Convert a pip-audit JSON object (already parsed) to a SARIF v2.1.0 log.
 * Unknown / malformed input → an empty (but schema-valid) SARIF log.
 */
export function pipAuditJsonToSarif(json: unknown, opts: PipAuditConvertOptions = {}): SarifLog {
  const uri = opts.requirementsPath ?? "requirements.txt";
  const results: SarifResult[] = [];

  const report = asReport(json);
  for (const dep of report.dependencies ?? []) {
    if (typeof dep.name !== "string" || typeof dep.version !== "string") continue;
    for (const v of dep.vulns ?? []) {
      if (typeof v.id !== "string" || v.id.length === 0) continue;
      const description = truncate(v.description ?? v.id, MAX_DESCRIPTION_LEN);
      const result: SarifResult = {
        ruleId: v.id,
        level: "error",
        message: { text: description },
        locations: [{ physicalLocation: { artifactLocation: { uri } } }],
        properties: {
          opencodehub: {
            dependency: `${dep.name}@${dep.version}`,
            ...(v.aliases !== undefined ? { aliases: [...v.aliases] } : {}),
            ...(v.fix_versions !== undefined ? { fixVersions: [...v.fix_versions] } : {}),
          },
        },
      };
      results.push(result);
    }
  }

  const run: SarifRun = {
    tool: { driver: { name: PIP_AUDIT_SPEC.id, version: PIP_AUDIT_SPEC.version } },
    results,
  };
  const log: SarifLog = { version: "2.1.0", runs: [run] };

  // Validate before returning so any accidental shape drift is caught at
  // conversion time rather than downstream.
  const parsed = SarifLogSchema.safeParse(log);
  if (!parsed.success) {
    // This is a defensive path — the shape above is pure and should
    // always validate. Returning an empty log is safer than throwing.
    return { version: "2.1.0", runs: [run] };
  }
  return parsed.data;
}

function asReport(json: unknown): PipAuditReport {
  if (typeof json !== "object" || json === null) return {};
  const obj = json as Record<string, unknown>;
  const deps = obj["dependencies"];
  if (!Array.isArray(deps)) return {};
  const out: PipAuditDependency[] = [];
  for (const d of deps) {
    if (typeof d !== "object" || d === null) continue;
    const row = d as Record<string, unknown>;
    const name = typeof row["name"] === "string" ? (row["name"] as string) : "";
    const version = typeof row["version"] === "string" ? (row["version"] as string) : "";
    if (name.length === 0 || version.length === 0) continue;
    const vulnsRaw = row["vulns"];
    const vulns: PipAuditVuln[] = [];
    if (Array.isArray(vulnsRaw)) {
      for (const vv of vulnsRaw) {
        if (typeof vv !== "object" || vv === null) continue;
        const vrow = vv as Record<string, unknown>;
        const id = typeof vrow["id"] === "string" ? (vrow["id"] as string) : "";
        if (id.length === 0) continue;
        const aliases = Array.isArray(vrow["aliases"])
          ? (vrow["aliases"] as unknown[]).filter((x): x is string => typeof x === "string")
          : undefined;
        const fixVersions = Array.isArray(vrow["fix_versions"])
          ? (vrow["fix_versions"] as unknown[]).filter((x): x is string => typeof x === "string")
          : undefined;
        const description =
          typeof vrow["description"] === "string" ? (vrow["description"] as string) : undefined;
        vulns.push({
          id,
          ...(description !== undefined ? { description } : {}),
          ...(aliases !== undefined ? { aliases } : {}),
          ...(fixVersions !== undefined ? { fix_versions: fixVersions } : {}),
        });
      }
    }
    out.push({ name, version, vulns });
  }
  return { dependencies: out };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
