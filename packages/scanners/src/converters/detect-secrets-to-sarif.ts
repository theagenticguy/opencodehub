/**
 * detect-secrets JSON → SARIF v2.1.0 converter.
 *
 * detect-secrets does not emit SARIF natively (Yelp/detect-secrets#488 is
 * still open as P4/help-wanted). Its `scan` subcommand writes JSON on
 * stdout shaped like:
 *
 *   {
 *     "version": "1.5.0",
 *     "plugins_used": [...],
 *     "filters_used": [...],
 *     "results": {
 *       "<path>": [
 *         {
 *           "type": "AWS Access Key",
 *           "filename": "<path>",
 *           "hashed_secret": "<sha1>",
 *           "is_verified": false,
 *           "line_number": 42
 *         }
 *       ]
 *     },
 *     "generated_at": "..."
 *   }
 *
 * We emit one SARIF result per finding:
 *   - ruleId      = type-string slug (e.g. "AWSKeyDetector")
 *   - level       = "warning" (verified=true → "error")
 *   - message     = "<type> detected in <filename>"
 *   - location    = artifactLocation { uri: "<filename>" }, region.startLine
 *   - properties.opencodehub.is_verified = boolean
 *   - partialFingerprints.detect_secrets_sha1 = hashed_secret
 *
 * We do NOT advertise hashed_secret as a cryptographic fingerprint
 * (W-B-1) — SHA-1 is not collision-resistant. The
 * `partialFingerprints.detect_secrets_sha1` slot is documented as a
 * plugin-defined identifier per SARIF §3.27.18, not a security claim.
 *
 * Overlapping findings (KeywordDetector + AWSKeyDetector on the same
 * line) are NOT deduplicated here (W-B-2) — both pass through and rely
 * on OCH's downstream SARIF dedupe at merge time.
 *
 * The output is validated against `SarifLogSchema` from @opencodehub/sarif
 * before being returned, so malformed emissions never leak downstream.
 */

import type { SarifLog, SarifResult, SarifRun } from "@opencodehub/sarif";
import { SarifLogSchema } from "@opencodehub/sarif";
import { DETECT_SECRETS_SPEC } from "../catalog.js";

/**
 * Stable detect-secrets `type` → SARIF ruleId map. Each detector class
 * is referenced by the spaced human-readable name detect-secrets emits in
 * its JSON output. Source: `detect-secrets --list-all-plugins` (v1.5.0).
 *
 * Unknown types fall back to a slug derived from the type string, so
 * future detector additions in detect-secrets do not break the converter
 * — they just emit a generic ruleId until this table is updated.
 */
const TYPE_TO_RULE_ID: Readonly<Record<string, string>> = {
  "Artifactory Credentials": "ArtifactoryDetector",
  "AWS Access Key": "AWSKeyDetector",
  "Azure Storage Account access key": "AzureStorageKeyDetector",
  "Basic Auth Credentials": "BasicAuthDetector",
  "Cloudant Credentials": "CloudantDetector",
  "Discord Bot Token": "DiscordBotTokenDetector",
  "GitHub Token": "GitHubTokenDetector",
  "GitLab Token": "GitLabTokenDetector",
  "Base64 High Entropy String": "Base64HighEntropyString",
  "Hex High Entropy String": "HexHighEntropyString",
  "IBM Cloud IAM Key": "IbmCloudIamDetector",
  "IBM COS HMAC Credentials": "IbmCosHmacDetector",
  Secret_Keyword: "KeywordDetector",
  "Mailchimp Access Key": "MailchimpDetector",
  "NPM tokens": "NpmDetector",
  "OpenAI Token": "OpenAIDetector",
  "Private Key": "PrivateKeyDetector",
  "PyPI upload token": "PypiTokenDetector",
  "SendGrid API Key": "SendGridDetector",
  "Slack Token": "SlackDetector",
  "SoftLayer Credentials": "SoftlayerDetector",
  "Square OAuth Secret": "SquareOAuthDetector",
  "Stripe Access Key": "StripeDetector",
  "Telegram Bot Token": "TelegramBotTokenDetector",
  "Twilio API Key": "TwilioKeyDetector",
};

interface DetectSecretsFinding {
  readonly type?: string;
  readonly filename?: string;
  readonly hashed_secret?: string;
  readonly is_verified?: boolean;
  readonly line_number?: number;
}

interface DetectSecretsReport {
  readonly results?: Readonly<Record<string, readonly DetectSecretsFinding[]>>;
}

/**
 * Convert a detect-secrets JSON object (already parsed) to a SARIF
 * v2.1.0 log. Unknown / malformed input → an empty (but schema-valid)
 * SARIF log attributed to detect-secrets.
 */
export function detectSecretsJsonToSarif(json: unknown): SarifLog {
  const results: SarifResult[] = [];
  const report = asReport(json);

  for (const [filename, findings] of Object.entries(report.results ?? {})) {
    for (const finding of findings) {
      const result = findingToResult(filename, finding);
      if (result !== undefined) results.push(result);
    }
  }

  const run: SarifRun = {
    tool: { driver: { name: DETECT_SECRETS_SPEC.id, version: DETECT_SECRETS_SPEC.version } },
    results,
  };
  const log: SarifLog = { version: "2.1.0", runs: [run] };

  // Defensive — the shape above is pure and should always validate.
  // Returning the unvalidated log is safer than throwing.
  const parsed = SarifLogSchema.safeParse(log);
  if (!parsed.success) return { version: "2.1.0", runs: [run] };
  return parsed.data;
}

function findingToResult(filename: string, finding: DetectSecretsFinding): SarifResult | undefined {
  if (typeof finding.type !== "string" || finding.type.length === 0) return undefined;
  const ruleId = TYPE_TO_RULE_ID[finding.type] ?? slugForUnknownType(finding.type);
  // detect-secrets uses 1-indexed line numbers, which matches SARIF.
  const startLine =
    typeof finding.line_number === "number" && finding.line_number >= 1 ? finding.line_number : 1;
  const isVerified = finding.is_verified === true;
  const result: SarifResult = {
    ruleId,
    level: isVerified ? "error" : "warning",
    message: { text: `${finding.type} detected in ${filename}` },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: filename },
          region: { startLine },
        },
      },
    ],
    properties: {
      opencodehub: {
        is_verified: isVerified,
      },
    },
  };
  if (typeof finding.hashed_secret === "string" && finding.hashed_secret.length > 0) {
    return {
      ...result,
      partialFingerprints: { detect_secrets_sha1: finding.hashed_secret },
    };
  }
  return result;
}

function slugForUnknownType(type: string): string {
  // Drop non-alphanumerics, preserve word boundaries.
  return type.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function asReport(json: unknown): DetectSecretsReport {
  if (typeof json !== "object" || json === null) return {};
  const obj = json as Record<string, unknown>;
  const rawResults = obj["results"];
  if (typeof rawResults !== "object" || rawResults === null || Array.isArray(rawResults)) {
    return {};
  }
  const out: Record<string, DetectSecretsFinding[]> = {};
  for (const [filename, findings] of Object.entries(rawResults as Record<string, unknown>)) {
    if (!Array.isArray(findings)) continue;
    const list: DetectSecretsFinding[] = [];
    for (const f of findings) {
      if (typeof f !== "object" || f === null) continue;
      const row = f as Record<string, unknown>;
      const finding: DetectSecretsFinding = {
        ...(typeof row["type"] === "string" ? { type: row["type"] as string } : {}),
        ...(typeof row["filename"] === "string" ? { filename: row["filename"] as string } : {}),
        ...(typeof row["hashed_secret"] === "string"
          ? { hashed_secret: row["hashed_secret"] as string }
          : {}),
        ...(typeof row["is_verified"] === "boolean"
          ? { is_verified: row["is_verified"] as boolean }
          : {}),
        ...(typeof row["line_number"] === "number"
          ? { line_number: row["line_number"] as number }
          : {}),
      };
      list.push(finding);
    }
    out[filename] = list;
  }
  return { results: out };
}
