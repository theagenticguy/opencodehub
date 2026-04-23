/**
 * `context` — 360-degree view of a single symbol.
 *
 * Given a symbol name we first resolve it to one or more graph nodes. If
 * the name matches more than one node, we stop and return candidates so
 * the caller can pick via file_path or kind (EC-04 in the PRD). If the
 * name matches exactly one node, we collect:
 *   - incoming CALLS (callers)
 *   - outgoing CALLS (callees)
 *   - HAS_METHOD children (methods/properties) if the target is a type
 *   - containing MEMBER_OF / CONTAINS owner
 *   - PROCESS_STEP edges that mention the target (processes)
 *
 * When the resolved target is a `Route`, we also surface any linked
 * `Operation` nodes — the cross-stack trace produced by the OpenAPI
 * phase. Operations arrive via incoming `HANDLES_ROUTE` edges from the
 * OpenAPI spec, so the shape is:
 *   Operation(openapi-spec) --HANDLES_ROUTE--> Route(framework handler)
 */
// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolErrorFromUnknown } from "../error-envelope.js";
import { withNextSteps } from "../next-step-hints.js";
import { stalenessFromMeta } from "../staleness.js";
import { type ToolContext, withStore } from "./shared.js";

const ContextInput = {
  symbol: z.string().min(1).describe("The symbol name to inspect (function, class, method, etc.)."),
  repo: z.string().optional().describe("Registered repo name; defaults to the only indexed repo."),
  kind: z
    .string()
    .optional()
    .describe("Optional NodeKind to disambiguate (e.g. 'Function' vs 'Method')."),
  filePath: z
    .string()
    .optional()
    .describe("Optional file path suffix to disambiguate same-named symbols."),
};

interface NodeRow {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly filePath: string;
}

interface CochangePartner {
  readonly fileId: string;
  readonly filePath: string;
  readonly score: number;
  readonly hops: 1 | 2;
}

/** OpenAPI-side operation metadata linked to a Route target. */
interface LinkedOperation {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly filePath: string;
  readonly summary?: string;
  readonly operationId?: string;
}

export function registerContextTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "context",
    {
      title: "360-degree symbol view",
      description:
        "Resolve a symbol to its graph node and return callers, callees, owner/members, and containing processes. When a name matches more than one node, returns a candidate list for disambiguation instead of silently picking one.",
      inputSchema: ContextInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      return withStore(ctx, args.repo, async (store, resolved) => {
        try {
          const params: (string | number)[] = [args.symbol];
          let sql = "SELECT id, name, kind, file_path FROM nodes WHERE name = ?";
          if (args.kind) {
            sql += " AND kind = ?";
            params.push(args.kind);
          }
          if (args.filePath) {
            sql += " AND file_path LIKE ?";
            params.push(`%${args.filePath}%`);
          }
          sql += " ORDER BY file_path LIMIT 25";
          const matches = (await store.query(sql, params)) as ReadonlyArray<
            Record<string, unknown>
          >;

          if (matches.length === 0) {
            return withNextSteps(
              `No symbol named "${args.symbol}" in ${resolved.name}.`,
              { target: null, candidates: [] },
              ["call `query` with a broader phrase to locate similar symbols"],
              stalenessFromMeta(resolved.meta),
            );
          }

          if (matches.length > 1) {
            const candidates: NodeRow[] = matches.map((r) => ({
              id: String(r["id"]),
              name: String(r["name"]),
              kind: String(r["kind"]),
              filePath: String(r["file_path"]),
            }));
            const list = candidates
              .map((c, i) => `${i + 1}. [${c.kind}] ${c.filePath}  (${c.id})`)
              .join("\n");
            return withNextSteps(
              `"${args.symbol}" is ambiguous (${candidates.length} matches):\n${list}`,
              { target: null, candidates },
              ["re-call `context` with `kind` or `filePath` to pick a specific match"],
              stalenessFromMeta(resolved.meta),
            );
          }

          const hit = matches[0];
          if (!hit) {
            return withNextSteps(
              `No symbol named "${args.symbol}" in ${resolved.name}.`,
              { target: null, candidates: [] },
              ["call `query` with a broader phrase to locate similar symbols"],
              stalenessFromMeta(resolved.meta),
            );
          }
          const targetId = String(hit["id"]);
          const target: NodeRow = {
            id: targetId,
            name: String(hit["name"]),
            kind: String(hit["kind"]),
            filePath: String(hit["file_path"]),
          };

          const [callers, callees, members, owner, processes, cochangeTop10, operations] =
            await Promise.all([
              fetchNodes(
                store,
                "SELECT n.id, n.name, n.kind, n.file_path FROM relations r JOIN nodes n ON n.id = r.from_id WHERE r.to_id = ? AND r.type = 'CALLS' LIMIT 50",
                [targetId],
              ),
              fetchNodes(
                store,
                "SELECT n.id, n.name, n.kind, n.file_path FROM relations r JOIN nodes n ON n.id = r.to_id WHERE r.from_id = ? AND r.type = 'CALLS' LIMIT 50",
                [targetId],
              ),
              fetchNodes(
                store,
                "SELECT n.id, n.name, n.kind, n.file_path FROM relations r JOIN nodes n ON n.id = r.to_id WHERE r.from_id = ? AND r.type IN ('HAS_METHOD','HAS_PROPERTY') LIMIT 100",
                [targetId],
              ),
              fetchNodes(
                store,
                "SELECT n.id, n.name, n.kind, n.file_path FROM relations r JOIN nodes n ON n.id = r.from_id WHERE r.to_id = ? AND r.type IN ('HAS_METHOD','HAS_PROPERTY','CONTAINS') LIMIT 5",
                [targetId],
              ),
              fetchNodes(
                store,
                "SELECT DISTINCT p.id, p.name, p.kind, p.file_path FROM relations r JOIN nodes p ON p.id = r.from_id WHERE r.to_id = ? AND r.type = 'PROCESS_STEP' AND p.kind = 'Process' LIMIT 20",
                [targetId],
              ),
              fetchCochangePartners(store, target),
              fetchLinkedOperations(store, target),
            ]);

          const lines: string[] = [];
          lines.push(`Symbol: ${target.name} [${target.kind}] — ${target.filePath}`);
          lines.push(`Callers (${callers.length}):`);
          for (const c of callers) lines.push(`  ← ${c.name} [${c.kind}] — ${c.filePath}`);
          lines.push(`Callees (${callees.length}):`);
          for (const c of callees) lines.push(`  → ${c.name} [${c.kind}] — ${c.filePath}`);
          if (members.length > 0) {
            lines.push(`Members (${members.length}):`);
            for (const m of members) lines.push(`  • ${m.name} [${m.kind}]`);
          }
          if (owner.length > 0) {
            lines.push(`Owner:`);
            for (const o of owner) lines.push(`  ⊃ ${o.name} [${o.kind}] — ${o.filePath}`);
          }
          if (processes.length > 0) {
            lines.push(`Processes (${processes.length}):`);
            for (const p of processes) lines.push(`  ⊿ ${p.name}`);
          }
          if (cochangeTop10.length > 0) {
            lines.push(`Co-change partners (${cochangeTop10.length}):`);
            for (const p of cochangeTop10) {
              lines.push(`  ⇌ ${p.filePath} [${p.hops}-hop, score=${p.score.toFixed(4)}]`);
            }
          }
          if (operations.length > 0) {
            lines.push(`OpenAPI operations (${operations.length}):`);
            for (const op of operations) {
              const opSuffix = op.operationId ? ` (${op.operationId})` : "";
              const sumSuffix = op.summary ? ` — ${op.summary}` : "";
              lines.push(`  ⇢ ${op.method} ${op.path}${opSuffix}${sumSuffix}`);
              lines.push(`    spec: ${op.filePath}`);
            }
          }

          const next = [
            `call \`impact\` with target="${target.id}" to see downstream blast radius`,
          ];
          if (callers.length === 0) {
            next.push("no callers found — this may be an entry point or dead code");
          }
          if (cochangeTop10.length > 0) {
            next.push(
              "review co-change partners: files that have historically been modified together",
            );
          }
          if (operations.length > 0) {
            next.push(
              "route is documented by an OpenAPI operation — consult the spec file(s) listed above",
            );
          }

          return withNextSteps(
            lines.join("\n"),
            {
              target,
              callers,
              callees,
              members,
              owner,
              processes,
              cochangeTop10,
              operations,
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

async function fetchNodes(
  store: import("@opencodehub/storage").IGraphStore,
  sql: string,
  params: readonly (string | number)[],
): Promise<NodeRow[]> {
  const rows = (await store.query(sql, params)) as ReadonlyArray<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r["id"]),
    name: String(r["name"]),
    kind: String(r["kind"]),
    filePath: String(r["file_path"]),
  }));
}

/**
 * Resolve the target's containing File node and fetch up to 10 highest-
 * confidence COCHANGES partners. For File-kind targets we use the node id
 * directly; for any other kind (Function, Method, etc.) we walk to the
 * File via the node's `file_path` so the caller always gets file-level
 * co-change even when they asked about a symbol inside the file.
 *
 * COCHANGES edges are canonicalised with lex-smaller id as `from`, so we
 * must union the two directions in SQL. The `reason` column carries a
 * JSON blob `{hops, coCommitCount}` emitted by the cochange phase — we
 * parse it defensively and fall back to `1` when absent.
 */
async function fetchCochangePartners(
  store: import("@opencodehub/storage").IGraphStore,
  target: NodeRow,
): Promise<CochangePartner[]> {
  // Resolve the File node id. If the target is already a File, use its
  // id; otherwise derive by file_path.
  let fileId: string | undefined;
  if (target.kind === "File") {
    fileId = target.id;
  } else if (target.filePath.length > 0) {
    const rows = (await store.query(
      "SELECT id FROM nodes WHERE kind = 'File' AND file_path = ? LIMIT 1",
      [target.filePath],
    )) as ReadonlyArray<Record<string, unknown>>;
    const first = rows[0];
    if (first !== undefined) fileId = String(first["id"]);
  }
  if (fileId === undefined) return [];

  // Fetch both directions and merge — canonical emission guarantees no
  // self-duplication between the two halves.
  const rows = (await store.query(
    "SELECT r.from_id, r.to_id, r.confidence, r.reason, n.id AS partner_id, n.file_path AS partner_path FROM relations r JOIN nodes n ON n.id = CASE WHEN r.from_id = ? THEN r.to_id ELSE r.from_id END WHERE r.type = 'COCHANGES' AND (r.from_id = ? OR r.to_id = ?) ORDER BY r.confidence DESC LIMIT 10",
    [fileId, fileId, fileId],
  )) as ReadonlyArray<Record<string, unknown>>;

  const out: CochangePartner[] = [];
  for (const r of rows) {
    const partnerId = String(r["partner_id"] ?? "");
    const partnerPath = String(r["partner_path"] ?? "");
    const confidence = Number(r["confidence"] ?? 0);
    const hops = parseHopsFromReason(r["reason"]);
    out.push({
      fileId: partnerId,
      filePath: partnerPath,
      score: Number.isFinite(confidence) ? confidence : 0,
      hops,
    });
  }
  return out;
}

/**
 * For `Route` targets, fetch all `Operation` nodes connected via
 * `HANDLES_ROUTE` (Operation → Route direction — emitted by the OpenAPI
 * phase). Returns an empty array for any non-Route target so the main
 * handler can call unconditionally.
 *
 * Operation metadata lives in the `http_method`, `http_path`, `summary`,
 * and `operation_id` columns (the node-to-row mapper intentionally
 * reroutes `method`/`path` to `http_method`/`http_path` so Route and
 * Operation rows share the `nodes` table without column collision).
 */
async function fetchLinkedOperations(
  store: import("@opencodehub/storage").IGraphStore,
  target: NodeRow,
): Promise<LinkedOperation[]> {
  if (target.kind !== "Route") return [];

  const rows = (await store.query(
    "SELECT n.id, n.file_path, n.http_method, n.http_path, n.summary, n.operation_id FROM relations r JOIN nodes n ON n.id = r.from_id WHERE r.to_id = ? AND r.type = 'HANDLES_ROUTE' AND n.kind = 'Operation' ORDER BY n.http_method, n.http_path LIMIT 20",
    [target.id],
  )) as ReadonlyArray<Record<string, unknown>>;

  const out: LinkedOperation[] = [];
  for (const r of rows) {
    const summary = r["summary"];
    const operationId = r["operation_id"];
    out.push({
      id: String(r["id"]),
      method: String(r["http_method"] ?? ""),
      path: String(r["http_path"] ?? ""),
      filePath: String(r["file_path"] ?? ""),
      ...(typeof summary === "string" && summary.length > 0 ? { summary } : {}),
      ...(typeof operationId === "string" && operationId.length > 0 ? { operationId } : {}),
    });
  }
  return out;
}

function parseHopsFromReason(reason: unknown): 1 | 2 {
  if (typeof reason !== "string" || reason.length === 0) return 1;
  try {
    const parsed = JSON.parse(reason) as unknown;
    if (parsed && typeof parsed === "object" && "hops" in parsed) {
      const h = (parsed as { hops?: unknown }).hops;
      if (h === 2) return 2;
    }
  } catch {
    // Malformed reason — treat as 1-hop.
  }
  return 1;
}
