/**
 * `api_impact` — score the blast radius of changing a Route's contract.
 *
 * For every Route matching the filter (`route` substring, or `file`
 * substring against Route.filePath) we compute:
 *   - consumers           = files with outgoing FETCHES → this Route.
 *   - middleware          = handlers reached via HANDLES_ROUTE (typically
 *                           File ids; Operation ids when the OpenAPI
 *                           phase linked a spec).
 *   - mismatches          = consumer files whose accessed keys are not a
 *                           subset of Route.responseKeys (delegated to
 *                           `classifyShape` from shape-check).
 *   - affectedProcesses   = Process nodes whose PROCESS_STEP edges walk
 *                           through any of the consumer symbols.
 *
 * Risk banding (deterministic):
 *   LOW      — 0 consumers and 0 mismatches.
 *   MEDIUM   — 1-4 consumers, 0 mismatches.
 *   HIGH     — 5-19 consumers OR any mismatch.
 *   CRITICAL — ≥ 20 consumers.
 */
// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDbStore } from "@opencodehub/storage";
import { z } from "zod";
import { toolErrorFromUnknown } from "../error-envelope.js";
import { withNextSteps } from "../next-step-hints.js";
import { stalenessFromMeta } from "../staleness.js";
import { classifyShape } from "./shape-check.js";
import {
  fromToolResult,
  type ToolContext,
  type ToolResult,
  toToolResult,
  withStore,
} from "./shared.js";

const ApiImpactInput = {
  repo: z.string().optional().describe("Registered repo name."),
  route: z.string().optional().describe("Substring match against Route.url."),
  file: z.string().optional().describe("Substring match against Route.filePath."),
};

export type Risk = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface ApiImpactRow {
  readonly route: {
    readonly id: string;
    readonly url: string;
    readonly method: string;
    readonly filePath: string;
  };
  readonly risk: Risk;
  readonly consumers: readonly string[];
  readonly middleware: readonly string[];
  readonly mismatches: readonly string[];
  readonly affectedProcesses: readonly string[];
}

interface ApiImpactArgs {
  readonly repo?: string | undefined;
  readonly route?: string | undefined;
  readonly file?: string | undefined;
}

export async function runApiImpact(ctx: ToolContext, args: ApiImpactArgs): Promise<ToolResult> {
  const call = await withStore(ctx, args.repo, async (store, resolved) => {
    try {
      const rows = await analyzeApiImpact(store, args.route, args.file);

      const header = `api_impact — ${rows.length} route(s) for ${resolved.name}${
        args.route ? ` · url~${args.route}` : ""
      }${args.file ? ` · filePath~${args.file}` : ""}:`;
      const body =
        rows.length === 0
          ? "(no routes matched — check the filter or re-index with `codehub analyze`)"
          : rows
              .map(
                (r) =>
                  `- [${r.risk}] ${r.route.method} ${r.route.url} consumers=${r.consumers.length} mismatches=${r.mismatches.length} processes=${r.affectedProcesses.length}`,
              )
              .join("\n");

      const highest = rows.reduce<Risk>((acc, r) => worseRisk(acc, r.risk), "LOW");
      const next =
        rows.length === 0
          ? ["call `route_map` to list available routes"]
          : highest === "CRITICAL" || highest === "HIGH"
            ? [
                `call \`shape_check\` with route="${rows[0]?.route.url ?? ""}" to see per-consumer mismatches`,
                `call \`context\` on a consumer file to plan migration`,
              ]
            : [
                "low blast radius — route change should be safe",
                "still verify with `shape_check` before merging",
              ];

      return withNextSteps(
        `${header}\n${body}`,
        { routes: rows, highestRisk: highest },
        next,
        stalenessFromMeta(resolved.meta),
      );
    } catch (err) {
      return toolErrorFromUnknown(err);
    }
  });
  return toToolResult(call);
}

export function registerApiImpactTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "api_impact",
    {
      title: "Route change blast radius",
      description:
        "Score the blast radius of changing a Route's contract. Returns risk (LOW/MEDIUM/HIGH/CRITICAL) plus the consumer files, middleware handlers, shape mismatches, and affected Process flows for every matching Route. Read-only.",
      inputSchema: ApiImpactInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => fromToolResult(await runApiImpact(ctx, args)),
  );
}

async function analyzeApiImpact(
  store: DuckDbStore,
  routeFilter: string | undefined,
  fileFilter: string | undefined,
): Promise<readonly ApiImpactRow[]> {
  const clauses: string[] = ["kind = 'Route'"];
  const params: (string | number)[] = [];
  if (routeFilter !== undefined && routeFilter.length > 0) {
    clauses.push("url LIKE ?");
    params.push(`%${routeFilter}%`);
  }
  if (fileFilter !== undefined && fileFilter.length > 0) {
    clauses.push("file_path LIKE ?");
    params.push(`%${fileFilter}%`);
  }
  const raw = (await store.query(
    `SELECT id, method, url, file_path, response_keys FROM nodes WHERE ${clauses.join(" AND ")} ORDER BY url, method LIMIT 500`,
    params,
  )) as ReadonlyArray<Record<string, unknown>>;

  const out: ApiImpactRow[] = [];
  for (const r of raw) {
    const routeId = String(r["id"]);
    const url = stringOr(r["url"], "");
    const method = stringOr(r["method"], "");
    const filePath = stringOr(r["file_path"], "");
    const responseKeys = stringArray(r["response_keys"]);

    const [consumerSymbolIds, handlers] = await Promise.all([
      fetchFromIds(store, routeId, "FETCHES"),
      fetchFromIds(store, routeId, "HANDLES_ROUTE"),
    ]);

    // Map consumer symbols to distinct files for counting + mismatch
    // classification.
    const consumerFiles = await resolveFiles(store, consumerSymbolIds);

    // Mismatches: run the same ACCESSES walk shape_check uses, per file.
    const mismatches: string[] = [];
    for (const file of consumerFiles) {
      const accessedKeys = await collectAccessedKeys(store, file);
      const { status } = classifyShape(accessedKeys, responseKeys);
      if (status === "MISMATCH") mismatches.push(file);
    }

    const affectedProcesses = await fetchAffectedProcesses(store, consumerSymbolIds);

    const risk = scoreRisk(consumerFiles.length, mismatches.length);
    out.push({
      route: { id: routeId, url, method, filePath },
      risk,
      consumers: consumerFiles,
      middleware: handlers,
      mismatches,
      affectedProcesses,
    });
  }
  return out;
}

function scoreRisk(consumers: number, mismatches: number): Risk {
  if (consumers >= 20) return "CRITICAL";
  if (consumers >= 5 || mismatches > 0) return "HIGH";
  if (consumers >= 1) return "MEDIUM";
  return "LOW";
}

function worseRisk(a: Risk, b: Risk): Risk {
  const order: Record<Risk, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
  return order[a] >= order[b] ? a : b;
}

async function fetchFromIds(
  store: DuckDbStore,
  targetId: string,
  type: string,
): Promise<readonly string[]> {
  const rows = (await store.query(
    "SELECT from_id FROM relations WHERE to_id = ? AND type = ? ORDER BY from_id",
    [targetId, type],
  )) as ReadonlyArray<Record<string, unknown>>;
  return rows.map((r) => String(r["from_id"] ?? "")).filter((s) => s.length > 0);
}

async function resolveFiles(
  store: DuckDbStore,
  nodeIds: readonly string[],
): Promise<readonly string[]> {
  if (nodeIds.length === 0) return [];
  const placeholders = nodeIds.map(() => "?").join(",");
  const rows = (await store.query(
    `SELECT DISTINCT file_path FROM nodes WHERE id IN (${placeholders}) AND file_path IS NOT NULL ORDER BY file_path`,
    [...nodeIds],
  )) as ReadonlyArray<Record<string, unknown>>;
  return rows.map((r) => String(r["file_path"] ?? "")).filter((s) => s.length > 0);
}

async function collectAccessedKeys(store: DuckDbStore, file: string): Promise<readonly string[]> {
  const rows = (await store.query(
    "SELECT DISTINCT p.name AS name FROM relations r JOIN nodes src ON src.id = r.from_id JOIN nodes p ON p.id = r.to_id WHERE r.type = 'ACCESSES' AND src.file_path = ? AND p.kind = 'Property' ORDER BY p.name",
    [file],
  )) as ReadonlyArray<Record<string, unknown>>;
  return rows.map((r) => String(r["name"] ?? "")).filter((s) => s.length > 0);
}

async function fetchAffectedProcesses(
  store: DuckDbStore,
  consumerSymbolIds: readonly string[],
): Promise<readonly string[]> {
  if (consumerSymbolIds.length === 0) return [];
  const placeholders = consumerSymbolIds.map(() => "?").join(",");
  const rows = (await store.query(
    `SELECT DISTINCT p.id FROM relations r JOIN nodes p ON p.id = r.from_id WHERE r.type = 'PROCESS_STEP' AND p.kind = 'Process' AND r.to_id IN (${placeholders}) ORDER BY p.id`,
    [...consumerSymbolIds],
  )) as ReadonlyArray<Record<string, unknown>>;
  return rows.map((r) => String(r["id"] ?? "")).filter((s) => s.length > 0);
}

function stringOr(v: unknown, fallback: string): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}

function stringArray(v: unknown): readonly string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string") out.push(item);
  }
  return out;
}
