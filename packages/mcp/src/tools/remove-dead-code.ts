/**
 * `remove_dead_code` — delete provably-dead symbols from disk.
 *
 * Pipeline:
 *   1. Call {@link classifyDeadness} to get the `dead` bucket (non-exported,
 *      no inbound referrers).
 *   2. Join against `nodes.end_line` via a batched id-IN lookup so the edit
 *      plan carries full `[startLine, endLine]` ranges. `DeadSymbol` only
 *      exposes `startLine`; we avoid touching the classifier surface.
 *   3. Group deletions per file, read each file via the injected
 *      {@link FsAbstraction}, snapshot the lines being removed, and emit an
 *      edit plan.
 *   4. Apply (only when `apply=true` is set explicitly — even with
 *      dryRun=false) by rewriting the file without the deleted line ranges
 *      and writing atomically through `fs.writeFileAtomic`.
 *
 * Defaults:
 *   - `dryRun=true`, `apply=false` — returns the plan, writes nothing.
 *
 * Destructive only when `apply=true`; otherwise read-only.
 */
// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures

import { isAbsolute, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  classifyDeadness,
  createNodeFs,
  type DeadSymbol,
  type FsAbstraction,
} from "@opencodehub/analysis";
import type { IGraphStore } from "@opencodehub/storage";
import { z } from "zod";
import { toolError, toolErrorFromUnknown } from "../error-envelope.js";
import { withNextSteps } from "../next-step-hints.js";
import { stalenessFromMeta } from "../staleness.js";
import { type ToolContext, withStore } from "./shared.js";

const RemoveDeadCodeInput = {
  repo: z
    .string()
    .optional()
    .describe(
      "Registered repo name. Required when ≥ 2 repos are registered; optional when exactly one is.",
    ),
  dryRun: z
    .boolean()
    .optional()
    .describe("Preview-only when true (DEFAULT). Set false AND pass apply=true to write."),
  filePathPattern: z
    .string()
    .optional()
    .describe("Substring filter — only dead symbols whose file path matches are considered."),
  apply: z
    .boolean()
    .optional()
    .describe("Must be explicitly true to write to disk. Ignored (and no-op) when dryRun is true."),
};

/** Edit plan entry — one contiguous line range to be removed from a file. */
export interface RemoveDeadCodeEdit {
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  /** The source lines being deleted, joined with `\n`, for audit logs. */
  readonly content: string;
}

interface EnrichedDead extends DeadSymbol {
  readonly endLine: number;
}

/** Factory override hook: tests inject an in-memory fs. */
export interface RemoveDeadCodeContext extends ToolContext {
  readonly fsFactory?: () => FsAbstraction;
}

export function registerRemoveDeadCodeTool(server: McpServer, ctx: RemoveDeadCodeContext): void {
  server.registerTool(
    "remove_dead_code",
    {
      title: "Remove dead symbols from disk",
      description:
        "Generate (and optionally apply) an edit plan that deletes every provably-dead symbol's source range. Safe by default: returns a plan without writing unless BOTH dryRun=false AND apply=true are passed.",
      inputSchema: RemoveDeadCodeInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      const dryRun = args.dryRun ?? true;
      const apply = args.apply === true;
      const pattern = args.filePathPattern;

      return withStore(ctx, args.repo, async (store, resolved) => {
        try {
          // Refuse an apply that skipped the explicit opt-in. Even when the
          // caller disables dryRun, we require `apply=true` as a second
          // confirmation — matches the design note in the wave plan.
          if (!dryRun && !apply) {
            return toolError(
              "INVALID_INPUT",
              "remove_dead_code refuses to write without an explicit apply=true flag.",
              "Pass both dryRun=false and apply=true to persist deletions, or leave dryRun=true for a plan.",
            );
          }

          const result = await classifyDeadness(store);
          const candidates = result.dead.filter(
            (s) => pattern === undefined || s.filePath.includes(pattern),
          );
          if (candidates.length === 0) {
            return withNextSteps(
              `No dead symbols matched${pattern ? ` filePath~${pattern}` : ""}. Nothing to remove.`,
              {
                filesAffected: 0,
                totalDeletions: 0,
                edits: [],
                applied: false,
              },
              ["call `list_dead_code` with includeUnreachableExports=true to inspect exports"],
              stalenessFromMeta(resolved.meta),
            );
          }

          const enriched = await enrichWithEndLines(store, candidates);
          const groupedByFile = groupByFile(enriched);

          const fsFactory = ctx.fsFactory ?? createNodeFs;
          const fs = fsFactory();

          const edits: RemoveDeadCodeEdit[] = [];
          const readFailures: string[] = [];
          for (const [filePath, syms] of groupedByFile) {
            const abs = resolveAbs(resolved.repoPath, filePath);
            let source: string;
            try {
              source = await fs.readFile(abs);
            } catch (err) {
              readFailures.push(`${filePath}: ${(err as Error).message}`);
              continue;
            }
            const lines = source.split("\n");
            for (const sym of syms) {
              const start = clampLine(sym.startLine, lines.length);
              const end = clampLine(sym.endLine, lines.length);
              if (start === 0 || end === 0 || end < start) continue;
              const snippet = lines.slice(start - 1, end).join("\n");
              edits.push({
                filePath,
                startLine: start,
                endLine: end,
                content: snippet,
              });
            }
          }

          const filesAffected = new Set(edits.map((e) => e.filePath)).size;
          const totalDeletions = edits.length;

          let applied = false;
          const writeFailures: string[] = [];
          if (!dryRun && apply) {
            const editsByFile = new Map<string, RemoveDeadCodeEdit[]>();
            for (const e of edits) {
              const bucket = editsByFile.get(e.filePath) ?? [];
              bucket.push(e);
              editsByFile.set(e.filePath, bucket);
            }
            for (const [filePath, fileEdits] of editsByFile) {
              const abs = resolveAbs(resolved.repoPath, filePath);
              let source: string;
              try {
                source = await fs.readFile(abs);
              } catch (err) {
                writeFailures.push(`${filePath}: read failed — ${(err as Error).message}`);
                continue;
              }
              const rewritten = applyDeletions(source, fileEdits);
              try {
                await fs.writeFileAtomic(abs, rewritten);
              } catch (err) {
                writeFailures.push(`${filePath}: write failed — ${(err as Error).message}`);
              }
            }
            applied = writeFailures.length === 0;
          }

          const header = `remove_dead_code (${applied ? "applied" : dryRun ? "dry-run" : "refused"}): ${filesAffected} file(s), ${totalDeletions} deletion(s).`;
          const lines: string[] = [header];
          for (const e of edits.slice(0, 50)) {
            lines.push(`  - ${e.filePath}:${e.startLine}-${e.endLine}`);
          }
          if (edits.length > 50) lines.push(`  … ${edits.length - 50} more`);
          if (readFailures.length > 0) {
            lines.push(`Read failures (${readFailures.length}):`);
            for (const f of readFailures.slice(0, 20)) lines.push(`  ⚠ ${f}`);
          }
          if (writeFailures.length > 0) {
            lines.push(`Write failures (${writeFailures.length}):`);
            for (const f of writeFailures.slice(0, 20)) lines.push(`  ⚠ ${f}`);
          }

          const next: string[] = [];
          if (dryRun && totalDeletions > 0) {
            next.push("if the plan looks right, re-call with dryRun=false AND apply=true");
          }
          if (applied) {
            next.push(
              "re-index the repo with `codehub analyze` so the graph reflects the removals",
            );
          }
          if (totalDeletions === 0) {
            next.push("no deletions staged — confirm dead symbols exist via `list_dead_code`");
          }

          return withNextSteps(
            lines.join("\n"),
            {
              filesAffected,
              totalDeletions,
              edits,
              applied,
              ...(readFailures.length > 0 ? { readFailures } : {}),
              ...(writeFailures.length > 0 ? { writeFailures } : {}),
            },
            next,
            stalenessFromMeta(resolved.meta),
          );
        } catch (err) {
          return toolErrorFromUnknown(err);
        }
      });
    },
  );
}

async function enrichWithEndLines(
  store: IGraphStore,
  dead: readonly DeadSymbol[],
): Promise<EnrichedDead[]> {
  if (dead.length === 0) return [];
  const ids = dead.map((d) => d.id);
  const placeholders = ids.map(() => "?").join(",");
  const rows = await store.query(
    `SELECT id, end_line FROM nodes WHERE id IN (${placeholders})`,
    ids,
  );
  const endById = new Map<string, number>();
  for (const row of rows) {
    const id = String(row["id"] ?? "");
    const raw = row["end_line"];
    const end = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
    if (id.length > 0) endById.set(id, end);
  }
  const out: EnrichedDead[] = [];
  for (const d of dead) {
    const endLine = endById.get(d.id) ?? d.startLine;
    out.push({ ...d, endLine });
  }
  return out;
}

function groupByFile(syms: readonly EnrichedDead[]): Map<string, EnrichedDead[]> {
  const out = new Map<string, EnrichedDead[]>();
  for (const s of syms) {
    const bucket = out.get(s.filePath) ?? [];
    bucket.push(s);
    out.set(s.filePath, bucket);
  }
  // Sort each bucket by startLine so downstream line-slicing is predictable.
  for (const [, bucket] of out) {
    bucket.sort((a, b) => a.startLine - b.startLine);
  }
  return out;
}

function resolveAbs(repoRoot: string, relPath: string): string {
  return isAbsolute(relPath) ? relPath : join(repoRoot, relPath);
}

function clampLine(line: number, total: number): number {
  if (!Number.isFinite(line) || line <= 0) return 0;
  if (line > total) return total;
  return Math.floor(line);
}

/**
 * Drop each edit's `[startLine, endLine]` range from the source, processing
 * ranges in descending order so earlier line numbers stay valid. Overlapping
 * ranges are collapsed — we keep the union.
 */
function applyDeletions(source: string, edits: readonly RemoveDeadCodeEdit[]): string {
  if (edits.length === 0) return source;
  const lines = source.split("\n");
  // Merge overlapping / adjacent ranges, then delete right-to-left.
  const sorted = [...edits].sort((a, b) => a.startLine - b.startLine);
  const merged: { start: number; end: number }[] = [];
  for (const e of sorted) {
    const last = merged[merged.length - 1];
    if (last && e.startLine <= last.end + 1) {
      last.end = Math.max(last.end, e.endLine);
    } else {
      merged.push({ start: e.startLine, end: e.endLine });
    }
  }
  for (let i = merged.length - 1; i >= 0; i -= 1) {
    const range = merged[i];
    if (range === undefined) continue;
    const startIdx = range.start - 1;
    const count = range.end - range.start + 1;
    if (startIdx < 0 || startIdx >= lines.length) continue;
    lines.splice(startIdx, count);
  }
  return lines.join("\n");
}
