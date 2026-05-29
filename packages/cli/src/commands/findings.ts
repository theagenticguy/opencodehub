/**
 * `codehub findings` — enumerate SARIF Finding nodes for an indexed repo.
 *
 * CLI sibling of the MCP `list_findings` tool. Reuses the same storage
 * reader (`store.graph.listFindings`) plus the identical TS post-finder for
 * `scanner` / `filePath` substring narrowing and the `severity==="none"`
 * filter. Only `note|warning|error` are pushed into `listFindings`; the
 * `none` severity is handled entirely in the TS post-finder (both halves —
 * we never pass it to the storage tier and we drop rows whose severity is
 * not `none` when the caller asked for `none`).
 *
 * Mirrors `packages/mcp/src/tools/list-findings.ts:runListFindings`. Does NOT
 * emit the MCP next_steps / staleness envelope — that is MCP-only.
 */

import type { Store } from "@opencodehub/storage";
import { openStoreForCommand } from "./open-store.js";

export interface FindingsOptions {
  readonly repo?: string;
  readonly home?: string;
  readonly json?: boolean;
  readonly severity?: "error" | "warning" | "note" | "none";
  readonly scanner?: string;
  readonly ruleId?: string;
  readonly filePath?: string;
  readonly limit?: number;
  /** Test seam — inject a fake store. Production leaves this unset. */
  readonly storeFactory?: () => Promise<{ store: Store; repoPath: string }>;
}

interface FindingRow {
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

export async function runFindings(opts: FindingsOptions = {}): Promise<void> {
  const limit = opts.limit ?? 500;
  const factory = opts.storeFactory ?? (() => openStoreForCommand({ ...opts, readOnly: true }));
  const { store } = await factory();
  try {
    const findingsOpts: {
      severity?: readonly ("note" | "warning" | "error")[];
      ruleId?: string;
      limit?: number;
    } = { limit };
    if (
      opts.severity !== undefined &&
      (opts.severity === "note" || opts.severity === "warning" || opts.severity === "error")
    ) {
      findingsOpts.severity = [opts.severity];
    }
    if (opts.ruleId !== undefined) findingsOpts.ruleId = opts.ruleId;
    const all = await store.graph.listFindings(findingsOpts);

    const filtered = all.filter((f) => {
      if (opts.severity === "none" && f.severity !== "none") return false;
      if (opts.scanner !== undefined && f.scannerId !== opts.scanner) return false;
      if (opts.filePath !== undefined && !f.filePath.includes(opts.filePath)) return false;
      return true;
    });

    const rows: FindingRow[] = filtered.map((f) => ({
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

    if (opts.json) {
      console.log(JSON.stringify({ findings: rows, total: rows.length }, null, 2));
      return;
    }

    if (rows.length === 0) {
      console.warn(
        "findings: no findings matched — run `codehub scan` or `codehub ingest-sarif <log>` to populate Finding nodes",
      );
      return;
    }
    for (const f of rows) {
      const loc = f.startLine !== undefined ? `:${f.startLine}` : "";
      const msg = f.message ? ` — ${f.message}` : "";
      console.log(`[${f.severity}] ${f.scanner}:${f.ruleId} at ${f.filePath}${loc}${msg}`);
    }
  } finally {
    await store.close();
  }
}

function stringOr(v: unknown, fallback: string): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}
