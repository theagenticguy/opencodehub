/**
 * `findingsCapability` — the shared reader/filter/projection behind the MCP
 * `list_findings` tool and the CLI `codehub findings` command.
 *
 * Lifted verbatim from the byte-identical bodies of
 * `mcp/src/tools/list-findings.ts` and `cli/src/commands/findings.ts` (audit
 * findings D4/D7): the `listFindings` push-down (severity + ruleId narrowed at
 * the storage tier), the TS post-finder (`severity==="none"`, `scanner`, and
 * `filePath` substring), and the row projection through the one canonical
 * `stringOr`. Each surface now maps `FindingsOutput` into its own transport.
 */

import type { Capability, CapabilityContext } from "../capability.js";
import { stringOr } from "../string-or.js";

/**
 * The validated, plain input `findingsCapability.execute` consumes. Each
 * surface validates its own transport shape into this: the MCP tool via its
 * SDK zod `inputSchema`, the CLI via coerced commander flags. `repo`/`repo_uri`
 * are resolved to a concrete store by the surface BEFORE `execute` runs, so
 * they are not read here — they live on the input only so a surface can pass
 * its parsed args object through unchanged.
 */
export interface FindingsInput {
  readonly repo?: string;
  readonly repo_uri?: string;
  readonly severity?: "error" | "warning" | "note" | "none";
  readonly scanner?: string;
  readonly ruleId?: string;
  readonly filePath?: string;
  readonly limit?: number;
}

/** One projected finding row — the plain shape both surfaces render. */
export interface FindingRow {
  readonly id: string;
  readonly scanner: string;
  readonly ruleId: string;
  readonly severity: string;
  readonly message: string;
  readonly filePath: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly properties: Record<string, unknown>;
}

/** The applied filters, echoed back so presenters can label the output. */
export interface FindingsFilters {
  readonly severity?: string;
  readonly scanner?: string;
  readonly ruleId?: string;
  readonly filePath?: string;
}

export interface FindingsOutput {
  readonly repoName: string;
  readonly findings: readonly FindingRow[];
  readonly total: number;
  readonly filters: FindingsFilters;
}

export const findingsCapability: Capability<FindingsInput, FindingsOutput> = {
  id: "findings",
  async execute(input: FindingsInput, ctx: CapabilityContext): Promise<FindingsOutput> {
    const limit = input.limit ?? 500;

    // Push severity + ruleId into the storage tier; scanner + filePath
    // substring + the `severity==="none"` case are applied in the TS
    // post-finder below (we never pass `none` to listFindings).
    const findingsOpts: {
      severity?: readonly ("note" | "warning" | "error")[];
      ruleId?: string;
      limit?: number;
    } = { limit };
    if (
      input.severity !== undefined &&
      (input.severity === "note" || input.severity === "warning" || input.severity === "error")
    ) {
      findingsOpts.severity = [input.severity];
    }
    if (input.ruleId !== undefined) findingsOpts.ruleId = input.ruleId;
    const all = await ctx.store.graph.listFindings(findingsOpts);

    const filtered = all.filter((f) => {
      if (input.severity === "none" && f.severity !== "none") return false;
      if (input.scanner !== undefined && f.scannerId !== input.scanner) return false;
      if (input.filePath !== undefined && !f.filePath.includes(input.filePath)) return false;
      return true;
    });

    const findings: FindingRow[] = filtered.map((f) => ({
      id: f.id,
      scanner: stringOr(f.scannerId, "unknown"),
      ruleId: stringOr(f.ruleId, ""),
      severity: stringOr(f.severity, "note"),
      message: stringOr(f.message, ""),
      filePath: stringOr(f.filePath, ""),
      properties: f.propertiesBag,
      ...(typeof f.startLine === "number" && Number.isFinite(f.startLine)
        ? { startLine: f.startLine }
        : {}),
      ...(typeof f.endLine === "number" && Number.isFinite(f.endLine)
        ? { endLine: f.endLine }
        : {}),
    }));

    const filters: FindingsFilters = {
      ...(input.severity !== undefined ? { severity: input.severity } : {}),
      ...(input.scanner !== undefined ? { scanner: input.scanner } : {}),
      ...(input.ruleId !== undefined ? { ruleId: input.ruleId } : {}),
      ...(input.filePath !== undefined ? { filePath: input.filePath } : {}),
    };

    return { repoName: ctx.repoName, findings, total: findings.length, filters };
  },
};
