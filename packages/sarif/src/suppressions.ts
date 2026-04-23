/**
 * suppressions — OpenCodeHub Stream T.
 *
 * Two ways to mark a SARIF Result as suppressed:
 *   1. External rules loaded from `.codehub/suppressions.yaml`. Each rule
 *      declares a `ruleId`, a `filePathPattern` (glob), a `reason`, and an
 *      optional `expiresAt` (ISO 8601). Expired rules are dropped at load
 *      time and surface as a warning so `codehub verdict` can re-report
 *      them as blocking.
 *   2. Inline source comments on (or immediately above) the finding line:
 *        // codehub-suppress: <ruleId> <reason>
 *        # codehub-suppress: <ruleId> <reason>
 *        /* codehub-suppress: <ruleId> <reason> *\/
 *      The ruleId must match the Result.ruleId exactly; everything after
 *      it is the justification.
 *
 * Both paths append to `result.suppressions[]` using SARIF 2.1.0's
 *   { kind: "external" | "inSource", justification: string }
 * shape so downstream consumers (GHAS, SARIF viewers) see standard
 * suppression metadata. `isSuppressed(result)` is the one-stop predicate
 * used by `codehub verdict` to skip blocking findings.
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { SarifLog, SarifResult } from "./schemas.js";
import { SarifLogSchema } from "./schemas.js";

/** A single suppression rule as declared in `.codehub/suppressions.yaml`. */
export interface SuppressionRule {
  readonly ruleId: string;
  /** Glob — supports `*`, `**`, `?`, and `[abc]` character classes. */
  readonly filePathPattern: string;
  readonly reason: string;
  /** ISO 8601 date or date-time. When past `now`, the rule is dropped. */
  readonly expiresAt?: string;
}

export interface LoadedSuppressions {
  readonly rules: readonly SuppressionRule[];
  /** Expired-rule diagnostics + parse errors. Never throws. */
  readonly warnings: readonly string[];
}

/** SARIF 2.1.0 Result.suppressions[] entry shape we care about. */
interface SarifSuppression {
  kind: "external" | "inSource";
  justification: string;
}

/**
 * Load suppressions from a YAML file on disk. Missing files resolve to an
 * empty ruleset (no warning). Malformed YAML or expired rules produce
 * warnings but never throw — callers print them.
 */
export function loadSuppressions(yamlPath: string, now: Date = new Date()): LoadedSuppressions {
  const warnings: string[] = [];
  let raw: string;
  try {
    raw = readFileSync(yamlPath, "utf8");
  } catch {
    return { rules: [], warnings };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(`suppressions: failed to parse ${yamlPath}: ${message}`);
    return { rules: [], warnings };
  }

  const ruleList = extractRuleList(parsed);
  if (ruleList === undefined) {
    warnings.push(`suppressions: ${yamlPath} is not a list or { rules: [...] } shape`);
    return { rules: [], warnings };
  }

  const survivors: SuppressionRule[] = [];
  for (let i = 0; i < ruleList.length; i += 1) {
    const entry = ruleList[i];
    const validated = validateRule(entry, i);
    if (typeof validated === "string") {
      warnings.push(`suppressions: ${validated}`);
      continue;
    }
    if (validated.expiresAt !== undefined) {
      const expiry = Date.parse(validated.expiresAt);
      if (Number.isNaN(expiry)) {
        warnings.push(
          `suppressions: rule[${i}] ${validated.ruleId} has unparsable expiresAt="${validated.expiresAt}"`,
        );
        continue;
      }
      if (expiry <= now.getTime()) {
        warnings.push(
          `suppressions: rule for ${validated.ruleId} (${validated.filePathPattern}) expired at ${validated.expiresAt} — un-suppressed`,
        );
        continue;
      }
    }
    survivors.push(validated);
  }

  return { rules: survivors, warnings };
}

function extractRuleList(parsed: unknown): readonly unknown[] | undefined {
  if (Array.isArray(parsed)) return parsed;
  if (parsed !== null && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    const under = record["rules"] ?? record["suppressions"];
    if (Array.isArray(under)) return under;
  }
  return undefined;
}

function validateRule(value: unknown, index: number): SuppressionRule | string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return `rule[${index}] is not an object`;
  }
  const record = value as Record<string, unknown>;
  const ruleId = record["ruleId"];
  const filePathPattern = record["filePathPattern"];
  const reason = record["reason"];
  const expiresAt = record["expiresAt"];
  if (typeof ruleId !== "string" || ruleId.length === 0) {
    return `rule[${index}] missing or empty ruleId`;
  }
  if (typeof filePathPattern !== "string" || filePathPattern.length === 0) {
    return `rule[${index}] ${ruleId} missing or empty filePathPattern`;
  }
  if (typeof reason !== "string" || reason.length === 0) {
    return `rule[${index}] ${ruleId} missing or empty reason`;
  }
  const out: SuppressionRule = { ruleId, filePathPattern, reason };
  if (typeof expiresAt === "string" && expiresAt.length > 0) {
    return { ...out, expiresAt };
  }
  return out;
}

/**
 * Convert a simple glob to a RegExp. Supports:
 *   - `**`  → any path segments (including `/`)
 *   - `*`   → any run of non-`/` characters
 *   - `?`   → any single non-`/` character
 *   - `[ab]`→ character class
 * Every other regex metacharacter is escaped.
 */
function globToRegExp(glob: string): RegExp {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 2;
        // Eat an optional trailing slash so `tests/**` matches `tests/a.py`.
        if (glob[i] === "/") i += 1;
        continue;
      }
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if (ch === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close === -1) {
        out += "\\[";
        i += 1;
        continue;
      }
      out += glob.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    // Escape every regex metacharacter except those handled above.
    if (/[.+^$(){}|\\/]/.test(ch ?? "")) {
      out += `\\${ch}`;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return new RegExp(`^${out}$`);
}

function normalizePath(uri: string): string {
  return uri.replace(/\\/g, "/");
}

function matchesPath(pattern: string, filePath: string): boolean {
  const normalizedPattern = pattern.replace(/\\/g, "/");
  const normalizedPath = normalizePath(filePath);
  if (normalizedPattern === normalizedPath) return true;
  return globToRegExp(normalizedPattern).test(normalizedPath);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getResultUri(result: SarifResult): string | undefined {
  const location = result.locations?.[0];
  const uri = location?.physicalLocation?.artifactLocation?.uri;
  return typeof uri === "string" ? uri : undefined;
}

function getResultStartLine(result: SarifResult): number | undefined {
  const line = result.locations?.[0]?.physicalLocation?.region?.startLine;
  return typeof line === "number" && line > 0 ? line : undefined;
}

/**
 * Scan source lines near `startLine` (1-based) for a
 * `codehub-suppress: <ruleId> <reason>` marker. Returns the justification
 * when the ruleId matches; undefined otherwise.
 */
export function findInlineSuppressionReason(
  source: string,
  startLine: number,
  ruleId: string,
): string | undefined {
  const normalized = source.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const zeroBased = startLine - 1;
  // Finding line + immediate preceding line so users can put the marker on
  // the line above an expression that spans multiple tokens.
  for (const idx of [zeroBased, zeroBased - 1]) {
    if (idx < 0 || idx >= lines.length) continue;
    const line = lines[idx];
    if (line === undefined) continue;
    const reason = extractInlineReason(line, ruleId);
    if (reason !== undefined) return reason;
  }
  return undefined;
}

const INLINE_MARKER = /codehub-suppress\s*:\s*(\S+)\s*(.*)$/;

function extractInlineReason(line: string, ruleId: string): string | undefined {
  const match = INLINE_MARKER.exec(line);
  if (match === null) return undefined;
  const markerRuleId = match[1];
  const reasonRaw = match[2] ?? "";
  if (markerRuleId !== ruleId) return undefined;
  // Strip a trailing C-family block-comment closer if one rode in with the
  // reason, then collapse whitespace. If the user wrote no reason, fall
  // back to a generic marker so the Result still reads as suppressed.
  const cleaned = reasonRaw.replace(/\*+\/\s*$/, "").trim();
  return cleaned.length > 0 ? cleaned : "suppressed in source";
}

function ensureSuppressions(result: SarifResult): SarifSuppression[] {
  const owner = result as SarifResult & { suppressions?: unknown };
  const existing = owner.suppressions;
  if (Array.isArray(existing)) {
    return existing as SarifSuppression[];
  }
  const fresh: SarifSuppression[] = [];
  owner.suppressions = fresh;
  return fresh;
}

function hasKindJustification(
  arr: readonly SarifSuppression[],
  kind: SarifSuppression["kind"],
  justification: string,
): boolean {
  for (const s of arr) {
    if (s.kind === kind && s.justification === justification) return true;
  }
  return false;
}

/**
 * Apply the loaded rules to every Result in the log. Deep-clones so the
 * input is never mutated. Inline-comment suppressions are also detected
 * when `readSource` can fetch the artifact body.
 */
export function applySuppressions(
  log: SarifLog,
  rules: readonly SuppressionRule[],
  readSource?: (uri: string) => string | undefined,
): SarifLog {
  const parsed = SarifLogSchema.safeParse(log);
  if (!parsed.success) {
    throw new Error(`applySuppressions: input failed schema validation: ${parsed.error.message}`);
  }
  const cloned = structuredClone(parsed.data) as SarifLog;

  for (const run of cloned.runs) {
    const results = run.results;
    if (!Array.isArray(results)) continue;
    for (const result of results) {
      if (result === undefined) continue;
      applyToResult(result, rules, readSource);
    }
  }
  return cloned;
}

function applyToResult(
  result: SarifResult,
  rules: readonly SuppressionRule[],
  readSource: ((uri: string) => string | undefined) | undefined,
): void {
  const ruleId = typeof result.ruleId === "string" ? result.ruleId : undefined;
  if (ruleId === undefined) return;
  const uri = getResultUri(result);
  const existing = ensureSuppressions(result);

  // External rule matches.
  if (uri !== undefined) {
    for (const rule of rules) {
      if (rule.ruleId !== ruleId) continue;
      if (!matchesPath(rule.filePathPattern, uri)) continue;
      if (hasKindJustification(existing, "external", rule.reason)) continue;
      existing.push({ kind: "external", justification: rule.reason });
    }
  }

  // Inline-comment matches.
  if (readSource !== undefined && uri !== undefined) {
    const startLine = getResultStartLine(result);
    if (startLine !== undefined) {
      const source = safeRead(readSource, uri);
      if (source !== undefined) {
        const reason = findInlineSuppressionReason(source, startLine, ruleId);
        if (reason !== undefined && !hasKindJustification(existing, "inSource", reason)) {
          existing.push({ kind: "inSource", justification: reason });
        }
      }
    }
  }

  // Prune empty suppressions[] we may have ensured above (keeps the wire
  // format byte-identical to the input when nothing matched).
  if (existing.length === 0) {
    delete (result as SarifResult & { suppressions?: unknown }).suppressions;
  }
}

function safeRead(reader: (uri: string) => string | undefined, uri: string): string | undefined {
  try {
    const content = reader(uri);
    return typeof content === "string" ? content : undefined;
  } catch {
    return undefined;
  }
}

/** True when the result carries any non-empty `suppressions[]` entry. */
export function isSuppressed(result: SarifResult): boolean {
  const owner = result as SarifResult & { suppressions?: unknown };
  const arr = owner.suppressions;
  if (!Array.isArray(arr)) return false;
  for (const entry of arr) {
    if (isPlainObject(entry)) return true;
  }
  return false;
}
