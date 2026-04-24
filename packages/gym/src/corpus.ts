import { readFile } from "node:fs/promises";
import { parse as parseYaml, YAMLParseError } from "yaml";
import { z } from "zod";
import {
  manifestCorpusSchema,
  manifestLanguageSchema,
  manifestRequestKindSchema,
  manifestResultSchema,
  manifestTargetSchema,
  manifestToolSchema,
} from "./manifest.js";

export const corpusCaseSchema = z.object({
  id: z.string().min(1),
  kind: manifestRequestKindSchema,
  target: manifestTargetSchema,
  expected: z.array(manifestResultSchema),
  labeler: z.string().min(1).optional(),
  labeler_note: z.string().optional(),
  waived: z.literal(true).optional(),
});

export const corpusFileSchema = z.object({
  language: manifestLanguageSchema,
  corpus: manifestCorpusSchema,
  tool: manifestToolSchema,
  cases: z.array(corpusCaseSchema).min(1),
});

export type CorpusCase = z.infer<typeof corpusCaseSchema>;
export type CorpusFile = z.infer<typeof corpusFileSchema>;

export async function loadCorpus(path: string): Promise<CorpusFile> {
  const raw = await readFile(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    if (err instanceof YAMLParseError) {
      throw new Error(`${path}: YAML parse error: ${err.message}`);
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${path}: YAML parse error: ${message}`);
  }
  const result = corpusFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${path}: corpus schema validation failed: ${result.error.message}`);
  }
  const file = result.data;
  const seen = new Set<string>();
  for (const c of file.cases) {
    if (seen.has(c.id)) {
      throw new Error(`${path}: duplicate case id ${c.id}`);
    }
    seen.add(c.id);
  }
  return file;
}
