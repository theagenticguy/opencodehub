/** opencodehub/v1 = sha256_hex(scannerId \x00 ruleId \x00 filePath \x00 contextHash)[:32]; primaryLocationLineHash = sha256_hex(ruleId \x00 filePath \x00 normalizedSnippet)[:16] + ":" + startLine. */

import { createHash } from "node:crypto";
import { type SarifLog, SarifLogSchema, type SarifResult } from "./schemas.js";

const NUL = "\x00";
const OPENCODEHUB_KEY = "opencodehub/v1";
const GHAS_KEY = "primaryLocationLineHash";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function normalizeWhitespace(line: string): string {
  return line.replace(/[ \t]+/g, " ").trim();
}

function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function computeContextHash(source: string, startLine: number, windowLines = 3): string {
  const normalizedSource = source.replace(/\r\n?/g, "\n");
  const lines = normalizedSource.split("\n");
  const zeroBased = Math.max(0, startLine - 1);
  const first = Math.max(0, zeroBased - windowLines);
  const last = Math.min(lines.length - 1, zeroBased + windowLines);
  const window: string[] = [];
  for (let i = first; i <= last; i += 1) {
    const raw = lines[i];
    if (raw === undefined) {
      continue;
    }
    window.push(normalizeWhitespace(raw));
  }
  return sha256Hex(window.join("\n"));
}

export function computeOpenCodeHubFingerprint(params: {
  scannerId: string;
  ruleId: string;
  filePath: string;
  contextHash: string;
}): string {
  const { scannerId, ruleId, filePath, contextHash } = params;
  const normalized = normalizeFilePath(filePath);
  return sha256Hex(scannerId + NUL + ruleId + NUL + normalized + NUL + contextHash).substring(
    0,
    32,
  );
}

export function computePrimaryLocationLineHash(params: {
  ruleId: string;
  filePath: string;
  startLine: number;
  snippet: string;
}): string {
  const { ruleId, filePath, startLine, snippet } = params;
  const normalizedPath = normalizeFilePath(filePath);
  const normalizedSnippet = normalizeWhitespace(snippet.replace(/\r\n?/g, "\n"));
  const digest = sha256Hex(ruleId + NUL + normalizedPath + NUL + normalizedSnippet).substring(
    0,
    16,
  );
  return `${digest}:${startLine}`;
}

interface EnrichOptions {
  readonly readSource?: (uri: string) => string | undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeReadSource(
  reader: ((uri: string) => string | undefined) | undefined,
  uri: string,
): string | undefined {
  if (reader === undefined) {
    return undefined;
  }
  try {
    const content = reader(uri);
    return typeof content === "string" ? content : undefined;
  } catch {
    return undefined;
  }
}

function deriveContextHash(
  source: string | undefined,
  startLine: number | undefined,
  fallbackSeed: string,
): string {
  if (source !== undefined && typeof startLine === "number" && startLine > 0) {
    return computeContextHash(source, startLine);
  }
  return sha256Hex(fallbackSeed);
}

function firstLineSnippet(
  source: string | undefined,
  startLine: number | undefined,
  messageText: string,
): string {
  if (source !== undefined && typeof startLine === "number" && startLine > 0) {
    const normalized = source.replace(/\r\n?/g, "\n");
    const lines = normalized.split("\n");
    const candidate = lines[startLine - 1];
    if (candidate !== undefined) {
      return candidate;
    }
  }
  return messageText;
}

function enrichResult(
  result: SarifResult,
  scannerId: string,
  options: EnrichOptions | undefined,
): void {
  const ruleId = typeof result.ruleId === "string" ? result.ruleId : "";
  const location = result.locations?.[0];
  const physical = location?.physicalLocation;
  const uri = physical?.artifactLocation.uri;
  const filePath = typeof uri === "string" ? uri : "";
  const startLine = physical?.region?.startLine;
  const messageText = typeof result.message?.text === "string" ? result.message.text : "";

  const source = typeof uri === "string" ? safeReadSource(options?.readSource, uri) : undefined;
  const contextHash = deriveContextHash(source, startLine, messageText + NUL + ruleId);

  const existingPartial = isPlainObject(result.partialFingerprints)
    ? (result.partialFingerprints as Record<string, string>)
    : undefined;
  const nextPartial: Record<string, string> =
    existingPartial !== undefined ? { ...existingPartial } : {};

  const computedOpenCodeHub = computeOpenCodeHubFingerprint({
    scannerId,
    ruleId,
    filePath,
    contextHash,
  });
  const currentOpenCodeHub = nextPartial[OPENCODEHUB_KEY];
  if (currentOpenCodeHub !== computedOpenCodeHub) {
    nextPartial[OPENCODEHUB_KEY] = computedOpenCodeHub;
  }

  if (nextPartial[GHAS_KEY] === undefined && typeof startLine === "number" && startLine > 0) {
    const snippet = firstLineSnippet(source, startLine, messageText);
    nextPartial[GHAS_KEY] = computePrimaryLocationLineHash({
      ruleId,
      filePath,
      startLine,
      snippet,
    });
  }

  result.partialFingerprints = nextPartial;
}

export function enrichWithFingerprints(log: SarifLog, options?: EnrichOptions): SarifLog {
  const parsed = SarifLogSchema.safeParse(log);
  if (!parsed.success) {
    throw new Error(
      `enrichWithFingerprints: input failed schema validation: ${parsed.error.message}`,
    );
  }

  const cloned = structuredClone(parsed.data) as SarifLog;

  for (const run of cloned.runs) {
    const scannerId = typeof run.tool.driver.name === "string" ? run.tool.driver.name : "";
    const results = run.results;
    if (!Array.isArray(results)) {
      continue;
    }
    for (const result of results) {
      if (result === undefined) {
        continue;
      }
      enrichResult(result, scannerId, options);
    }
  }

  return cloned;
}
