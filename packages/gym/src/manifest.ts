import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";

const sha40 = z.string().regex(/^[0-9a-f]{40}$/, "must be 40 hex chars");
const sha64 = z.string().regex(/^[0-9a-f]{64}$/, "must be 64 hex chars");
const isoUtc = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/, "must be ISO 8601 UTC (Z suffix)");
const oneBased = z.number().int().min(1);

export const manifestLanguageSchema = z.enum(["python", "typescript", "go", "rust"]);

export const manifestRequestKindSchema = z.enum(["references", "implementations", "callers"]);

export const manifestCorpusSchema = z.object({
  name: z.string().min(1),
  commit: sha40,
  path: z.string().min(1),
});

export const manifestToolSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  sha256: sha64.optional(),
});

export const manifestTargetSchema = z.object({
  symbolName: z.string().min(1),
  file: z.string().min(1),
  line: oneBased,
  column: oneBased,
});

export const manifestRequestSchema = z.object({
  kind: manifestRequestKindSchema,
  target: manifestTargetSchema,
});

export const manifestResultSchema = z.object({
  file: z.string().min(1),
  line: oneBased,
  column: oneBased,
  enclosing: z.string().min(1).optional(),
});

export const manifestRecordSchema = z.object({
  manifest_version: z.literal("1"),
  language: manifestLanguageSchema,
  corpus: manifestCorpusSchema,
  tool: manifestToolSchema,
  request: manifestRequestSchema,
  result_set: z.array(manifestResultSchema),
  captured_at: isoUtc,
  labeler: z.string().min(1).optional(),
  labeler_note: z.string().optional(),
  waived: z.literal(true).optional(),
});

export type ManifestLanguage = z.infer<typeof manifestLanguageSchema>;
export type ManifestRequestKind = z.infer<typeof manifestRequestKindSchema>;
export type ManifestCorpus = z.infer<typeof manifestCorpusSchema>;
export type ManifestTool = z.infer<typeof manifestToolSchema>;
export type ManifestTarget = z.infer<typeof manifestTargetSchema>;
export type ManifestRequest = z.infer<typeof manifestRequestSchema>;
export type ManifestResult = z.infer<typeof manifestResultSchema>;
export type ManifestRecord = z.infer<typeof manifestRecordSchema>;

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [k: string]: JsonValue | undefined };

function canonicalizeValue(value: JsonValue | undefined): string {
  if (value === undefined) {
    throw new Error("canonicalize: undefined is not JSON-serializable");
  }
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`canonicalize: non-finite number ${String(value)}`);
    }
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      if (item === undefined) {
        throw new Error("canonicalize: undefined array element");
      }
      parts.push(canonicalizeValue(item));
    }
    return `[${parts.join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const inner = value[key];
    if (inner === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalizeValue(inner)}`);
  }
  return `{${parts.join(",")}}`;
}

export function canonicalize(record: ManifestRecord): string {
  return canonicalizeValue(record as unknown as JsonValue);
}

export function fingerprint(record: ManifestRecord): string {
  const keyed: JsonValue = {
    language: record.language,
    corpus: {
      name: record.corpus.name,
      commit: record.corpus.commit,
      path: record.corpus.path,
    },
    tool: {
      name: record.tool.name,
      version: record.tool.version,
      ...(record.tool.sha256 !== undefined ? { sha256: record.tool.sha256 } : {}),
    },
    request: {
      kind: record.request.kind,
      target: {
        symbolName: record.request.target.symbolName,
        file: record.request.target.file,
        line: record.request.target.line,
        column: record.request.target.column,
      },
    },
  };
  return createHash("sha256").update(canonicalizeValue(keyed), "utf-8").digest("hex");
}

export async function readManifest(path: string): Promise<ManifestRecord[]> {
  const raw = await readFile(path, "utf-8");
  const lines = raw.split("\n");
  const out: ManifestRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${path}:${i + 1}: invalid JSON: ${message}`);
    }
    const result = manifestRecordSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`${path}:${i + 1}: schema validation failed: ${result.error.message}`);
    }
    out.push(result.data);
  }
  return out;
}

export async function writeManifest(path: string, records: ManifestRecord[]): Promise<void> {
  const body = records.map((r) => canonicalize(r)).join("\n");
  const trailer = records.length > 0 ? "\n" : "";
  await writeFile(path, body + trailer, "utf-8");
}
