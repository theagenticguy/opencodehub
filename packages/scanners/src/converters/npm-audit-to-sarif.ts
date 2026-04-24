/**
 * `npm audit --json` → SARIF v2.1.0 converter.
 *
 * npm audit's JSON schema (v2/v3 formats, which both ship in npm 7+)
 * puts vulnerabilities under a top-level `vulnerabilities` map:
 *
 *   {
 *     "vulnerabilities": {
 *       "<pkg>": {
 *         "name": "<pkg>",
 *         "severity": "low|moderate|high|critical",
 *         "isDirect": true|false,
 *         "range": ">=1.0.0 <1.2.0",
 *         "via": [
 *           { "source": 1234, "name": "<pkg>", "title": "...",
 *             "url": "...", "severity": "...", "range": "..." }
 *           | "<other-pkg-name>"
 *         ],
 *         "fixAvailable": ... | false
 *       }
 *     },
 *     "metadata": { ... }
 *   }
 *
 * `via` entries are either advisory objects (primary source of the
 * finding) or bare package names (transitive chain hops). We emit one
 * SARIF result per advisory object we discover; string `via` entries
 * just describe the dependency chain and don't themselves constitute a
 * new advisory.
 *
 *   - ruleId   = via.source ? `GHSA-${via.source}` : via.url ?? via.name
 *                (we prefer `via.url` when source isn't numeric)
 *   - level    = severity mapping (critical/high → error,
 *                moderate → warning, low → note)
 *   - message  = via.title (+ url when present)
 *   - location = artifactLocation { uri: "package.json" }
 *   - properties.opencodehub.dependency = `${pkg}@${range}`
 *   - properties.opencodehub.severity   = via.severity (raw)
 */

import type { SarifResult, SarifRun } from "@opencodehub/sarif";
import { type SarifLog, SarifLogSchema } from "@opencodehub/sarif";
import { NPM_AUDIT_SPEC } from "../catalog.js";

/** URI for artifactLocation — npm audit is always scoped to package.json. */
const DEFAULT_LOCKFILE = "package.json";

type NpmSeverity = "info" | "low" | "moderate" | "high" | "critical";

interface NpmAuditVia {
  readonly source?: number | string;
  readonly name?: string;
  readonly title?: string;
  readonly url?: string;
  readonly severity?: string;
  readonly range?: string;
}

interface NpmAuditVulnerability {
  readonly name?: string;
  readonly severity?: string;
  readonly range?: string;
  readonly via?: ReadonlyArray<NpmAuditVia | string>;
}

export interface NpmAuditConvertOptions {
  /** Override the artifactLocation URI (default: `package.json`). */
  readonly lockfilePath?: string;
}

/**
 * Convert parsed `npm audit --json` output to a SARIF v2.1.0 log. Any
 * shape drift falls through to an empty log.
 */
export function npmAuditJsonToSarif(json: unknown, opts: NpmAuditConvertOptions = {}): SarifLog {
  const uri = opts.lockfilePath ?? DEFAULT_LOCKFILE;
  const results: SarifResult[] = [];

  const vulns = asVulnerabilities(json);
  // Iterate in a sorted order so output is deterministic.
  const pkgs = [...vulns.keys()].sort();
  for (const pkg of pkgs) {
    const entry = vulns.get(pkg);
    if (!entry) continue;
    const severity = asSeverity(entry.severity);
    const range = typeof entry.range === "string" ? entry.range : "*";
    for (const via of entry.via ?? []) {
      if (typeof via === "string") continue; // transitive hop, no advisory
      const ruleId = ruleIdFor(via);
      if (ruleId === undefined) continue;
      const viaSeverity = asSeverity(via.severity) ?? severity;
      const messageText = messageFor(via, pkg, range);
      const result: SarifResult = {
        ruleId,
        level: levelFor(viaSeverity),
        message: { text: messageText },
        locations: [{ physicalLocation: { artifactLocation: { uri } } }],
        properties: {
          opencodehub: {
            dependency: `${pkg}@${range}`,
            ...(viaSeverity !== undefined ? { severity: viaSeverity } : {}),
            ...(via.url !== undefined ? { advisoryUrl: via.url } : {}),
          },
        },
      };
      results.push(result);
    }
  }

  const run: SarifRun = {
    tool: { driver: { name: NPM_AUDIT_SPEC.id, version: NPM_AUDIT_SPEC.version } },
    results,
  };
  const log: SarifLog = { version: "2.1.0", runs: [run] };
  const parsed = SarifLogSchema.safeParse(log);
  return parsed.success ? parsed.data : { version: "2.1.0", runs: [run] };
}

function asVulnerabilities(json: unknown): Map<string, NpmAuditVulnerability> {
  const out = new Map<string, NpmAuditVulnerability>();
  if (typeof json !== "object" || json === null) return out;
  const obj = json as Record<string, unknown>;
  const v = obj["vulnerabilities"];
  if (typeof v !== "object" || v === null) return out;
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const row = value as Record<string, unknown>;
    const viaRaw = row["via"];
    const via: Array<NpmAuditVia | string> = [];
    if (Array.isArray(viaRaw)) {
      for (const item of viaRaw) {
        if (typeof item === "string") {
          via.push(item);
        } else if (typeof item === "object" && item !== null) {
          via.push(item as NpmAuditVia);
        }
      }
    }
    // `exactOptionalPropertyTypes` forbids `undefined` on optional fields —
    // only omission is acceptable. Build the record conditionally.
    const vuln: {
      -readonly [K in keyof NpmAuditVulnerability]?: NpmAuditVulnerability[K];
    } = { via };
    if (typeof row["name"] === "string") vuln.name = row["name"];
    if (typeof row["severity"] === "string") vuln.severity = row["severity"];
    if (typeof row["range"] === "string") vuln.range = row["range"];
    out.set(key, vuln);
  }
  return out;
}

function asSeverity(raw: string | undefined): NpmSeverity | undefined {
  if (raw === undefined) return undefined;
  const lower = raw.toLowerCase();
  if (
    lower === "info" ||
    lower === "low" ||
    lower === "moderate" ||
    lower === "high" ||
    lower === "critical"
  ) {
    return lower;
  }
  return undefined;
}

function levelFor(sev: NpmSeverity | undefined): "none" | "note" | "warning" | "error" {
  switch (sev) {
    case "critical":
    case "high":
      return "error";
    case "moderate":
      return "warning";
    case "low":
      return "note";
    case "info":
      return "note";
    default:
      return "warning";
  }
}

function ruleIdFor(via: NpmAuditVia): string | undefined {
  if (typeof via.source === "number" || typeof via.source === "string") {
    return `npm-advisory-${via.source}`;
  }
  if (typeof via.url === "string" && via.url.length > 0) return via.url;
  if (typeof via.name === "string" && via.name.length > 0) return via.name;
  return undefined;
}

function messageFor(via: NpmAuditVia, pkg: string, range: string): string {
  const title = typeof via.title === "string" ? via.title : `Vulnerability in ${pkg}`;
  const url = typeof via.url === "string" ? ` (${via.url})` : "";
  return `${title} — affects ${pkg}@${range}${url}`;
}
