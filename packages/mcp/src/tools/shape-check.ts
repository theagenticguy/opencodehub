/**
 * `shape_check` — compare a Route's static responseKeys against the
 * property names each consumer file actually reads off the response.
 *
 * For every Route matching `route` (URL substring) we:
 *   1. Find FETCHES edges pointing AT the route. Each `from_id` is a
 *      symbol (Function / Method / Constructor) that issued the call.
 *   2. Group those consumer symbols by file.
 *   3. Walk outgoing ACCESSES from every symbol in each consumer file to
 *      its Property target; collect Property.name as the accessed key.
 *   4. Compare that set against Route.responseKeys (populated by the
 *      `routes` phase when the response literal was statically known).
 *
 * Per-consumer status:
 *   - MATCH    — every accessed key is in responseKeys.
 *   - MISMATCH — at least one accessed key is NOT in responseKeys.
 *   - PARTIAL  — no accessed keys found (can't check).
 *
 * `classifyShape` is exported so `api_impact` can reuse it for its
 * `mismatches` count without re-walking the graph.
 */
// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDbStore } from "@opencodehub/storage";
import { z } from "zod";
import { toolErrorFromUnknown } from "../error-envelope.js";
import { withNextSteps } from "../next-step-hints.js";
import { stalenessFromMeta } from "../staleness.js";
import {
  fromToolResult,
  type ToolContext,
  type ToolResult,
  toToolResult,
  withStore,
} from "./shared.js";

const ShapeCheckInput = {
  repo: z.string().optional().describe("Registered repo name."),
  route: z.string().optional().describe("Substring match against Route.url."),
};

export type ShapeStatus = "MATCH" | "MISMATCH" | "PARTIAL";

export interface ConsumerShape {
  readonly file: string;
  readonly accessedKeys: readonly string[];
  readonly status: ShapeStatus;
  readonly missing: readonly string[];
}

export interface RouteShape {
  readonly url: string;
  readonly method: string;
  readonly responseKeys: readonly string[];
  readonly consumers: readonly ConsumerShape[];
}

interface ShapeCheckArgs {
  readonly repo?: string | undefined;
  readonly route?: string | undefined;
}

export async function runShapeCheck(ctx: ToolContext, args: ShapeCheckArgs): Promise<ToolResult> {
  const call = await withStore(ctx, args.repo, async (store, resolved) => {
    try {
      const routes = await loadRouteShapes(store, args.route);

      const header = `shape_check — ${routes.length} route(s) for ${resolved.name}${
        args.route ? ` · url~${args.route}` : ""
      }:`;
      const lines: string[] = [header];
      let mismatchTotal = 0;
      for (const r of routes) {
        lines.push(`${r.method} ${r.url} keys=${r.responseKeys.length}`);
        for (const c of r.consumers) {
          if (c.status === "MISMATCH") mismatchTotal += 1;
          const miss = c.missing.length > 0 ? ` missing=[${c.missing.join(",")}]` : "";
          lines.push(`  [${c.status}] ${c.file} accessed=${c.accessedKeys.length}${miss}`);
        }
      }
      if (routes.length === 0) {
        lines.push("(no routes matched — check the url filter)");
      }

      const next =
        routes.length === 0
          ? ["call `route_map` with the same filter to list available routes"]
          : mismatchTotal > 0
            ? [
                "investigate each MISMATCH — consumer reads a key not in responseKeys",
                "call `context` on the consumer file for upstream callers",
              ]
            : ["no mismatches — consumer shape matches Route.responseKeys"];

      return withNextSteps(lines.join("\n"), { routes }, next, stalenessFromMeta(resolved.meta));
    } catch (err) {
      return toolErrorFromUnknown(err);
    }
  });
  return toToolResult(call);
}

export function registerShapeCheckTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "shape_check",
    {
      title: "Route response-shape mismatch check",
      description:
        "For each Route matching the filter, walk ACCESSES edges from the consumer files that FETCH this route and compare accessed property names against Route.responseKeys. Returns MATCH / MISMATCH / PARTIAL per consumer. Read-only.",
      inputSchema: ShapeCheckInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => fromToolResult(await runShapeCheck(ctx, args)),
  );
}

/** Load every Route matching the filter and classify each consumer file. */
export async function loadRouteShapes(
  store: DuckDbStore,
  routeFilter: string | undefined,
): Promise<readonly RouteShape[]> {
  const clauses: string[] = ["kind = 'Route'"];
  const params: (string | number)[] = [];
  if (routeFilter !== undefined && routeFilter.length > 0) {
    clauses.push("url LIKE ?");
    params.push(`%${routeFilter}%`);
  }
  const raw = (await store.query(
    `SELECT id, method, url, response_keys FROM nodes WHERE ${clauses.join(" AND ")} ORDER BY url, method LIMIT 500`,
    params,
  )) as ReadonlyArray<Record<string, unknown>>;

  const routes: RouteShape[] = [];
  for (const r of raw) {
    const routeId = String(r["id"]);
    const url = stringOr(r["url"], "");
    const method = stringOr(r["method"], "");
    const responseKeys = stringArray(r["response_keys"]);
    const consumers = await collectConsumerShapes(store, routeId, responseKeys);
    routes.push({ url, method, responseKeys, consumers });
  }
  return routes;
}

/** Classify a set of accessed keys against responseKeys. */
export function classifyShape(
  accessedKeys: readonly string[],
  responseKeys: readonly string[],
): { status: ShapeStatus; missing: readonly string[] } {
  if (accessedKeys.length === 0) return { status: "PARTIAL", missing: [] };
  const known = new Set(responseKeys);
  const missing = accessedKeys.filter((k) => !known.has(k));
  if (missing.length === 0) return { status: "MATCH", missing: [] };
  return { status: "MISMATCH", missing };
}

async function collectConsumerShapes(
  store: DuckDbStore,
  routeId: string,
  responseKeys: readonly string[],
): Promise<readonly ConsumerShape[]> {
  // 1. Consumer symbols: the from_id side of every FETCHES → routeId.
  const consumerRows = (await store.query(
    "SELECT from_id FROM relations WHERE type = 'FETCHES' AND to_id = ? ORDER BY from_id",
    [routeId],
  )) as ReadonlyArray<Record<string, unknown>>;
  const consumerSymbolIds = consumerRows
    .map((r) => String(r["from_id"] ?? ""))
    .filter((s) => s.length > 0);
  if (consumerSymbolIds.length === 0) return [];

  // 2. Map each consumer symbol to its file_path. Nodes also carry their
  //    containing file so we don't need a CONTAINS join.
  const placeholders = consumerSymbolIds.map(() => "?").join(",");
  const fileRows = (await store.query(
    `SELECT id, file_path FROM nodes WHERE id IN (${placeholders})`,
    consumerSymbolIds,
  )) as ReadonlyArray<Record<string, unknown>>;
  const symbolFile = new Map<string, string>();
  for (const r of fileRows) {
    const id = String(r["id"] ?? "");
    const fp = String(r["file_path"] ?? "");
    if (id.length > 0 && fp.length > 0) symbolFile.set(id, fp);
  }

  // 3. Group unique files with their seed consumer symbol ids.
  const filesToSymbols = new Map<string, string[]>();
  for (const sid of consumerSymbolIds) {
    const fp = symbolFile.get(sid);
    if (fp === undefined) continue;
    const bucket = filesToSymbols.get(fp) ?? [];
    bucket.push(sid);
    filesToSymbols.set(fp, bucket);
  }

  // 4. For every consumer file, gather the set of accessed property names.
  //    We look at ACCESSES from ANY symbol defined in the same file, then
  //    resolve the target node's `name` column (which holds the Property
  //    name). This catches helper functions in the same module that parse
  //    the response after the fetch.
  const out: ConsumerShape[] = [];
  const sortedFiles = [...filesToSymbols.keys()].sort();
  for (const file of sortedFiles) {
    const rows = (await store.query(
      "SELECT DISTINCT p.name AS name FROM relations r JOIN nodes src ON src.id = r.from_id JOIN nodes p ON p.id = r.to_id WHERE r.type = 'ACCESSES' AND src.file_path = ? AND p.kind = 'Property' ORDER BY p.name",
      [file],
    )) as ReadonlyArray<Record<string, unknown>>;
    const accessedKeys = rows.map((r) => String(r["name"] ?? "")).filter((s) => s.length > 0);
    const { status, missing } = classifyShape(accessedKeys, responseKeys);
    out.push({ file, accessedKeys, status, missing });
  }
  return out;
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
