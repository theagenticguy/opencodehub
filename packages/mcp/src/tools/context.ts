/**
 * `context` — 360-degree view of a single symbol.
 *
 * Resolution order:
 *   1. `uid` — direct node-id lookup; no disambiguation, no name match.
 *   2. `symbol` (or `name` alias) — filtered by optional `kind` and
 *      `file_path` (snake_case, with `filePath` camelCase alias preserved
 *      for backward compat). Ambiguous names surface a ranked candidate
 *      list instead of silently picking one (EC-04 in the PRD).
 *
 * Once a single target is resolved we collect:
 *   - `incoming` — every edge where the target is the `to_id`, bucketed
 *     by edge type (calls, imports, accesses, has_method, has_property,
 *     extends, implements, method_overrides, method_implements).
 *   - `outgoing` — the same bucketing for edges where the target is
 *     the `from_id`.
 *   - `processes` — PROCESS_STEP participation (Process-kind partners).
 *   - `cochanges` — git-history partners for the target's enclosing file.
 *   - `operations` — OpenAPI `Operation` nodes linked to a Route target via
 *     `HANDLES_ROUTE` (cross-stack trace from the OpenAPI phase).
 *   - `confidenceBreakdown` — provenance tally over every edge surfaced.
 *   - `content` (optional) — the target's indexed source, capped at
 *     {@link CONTENT_CHAR_CAP} characters. Only returned when
 *     `include_content` is true.
 *   - `location` — `{ filePath, startLine, endLine }` for quick jump-to.
 *
 * The flat `callers`, `callees`, `members`, and `owner` fields are kept on
 * the response for backward compat with pre-parity consumers; new callers
 * should prefer the `incoming` / `outgoing` category buckets.
 */
// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolErrorFromUnknown } from "../error-envelope.js";
import { withNextSteps } from "../next-step-hints.js";
import { stalenessFromMeta } from "../staleness.js";
import { computeConfidenceBreakdown, type EdgeConfidenceSource } from "./confidence.js";
import {
  fromToolResult,
  type ToolContext,
  type ToolResult,
  toToolResult,
  withStore,
} from "./shared.js";

/** Upper bound on the `content` field size when `include_content` is true. */
const CONTENT_CHAR_CAP = 2000;

/**
 * Relation types surfaced in the categorised `incoming` / `outgoing`
 * buckets. PROCESS_STEP / HANDLES_ROUTE / CONTAINS live in their own
 * dedicated fields and are excluded here.
 */
const CATEGORY_EDGE_TYPES = [
  "CALLS",
  "IMPORTS",
  "ACCESSES",
  "HAS_METHOD",
  "HAS_PROPERTY",
  "EXTENDS",
  "IMPLEMENTS",
  "METHOD_OVERRIDES",
  "METHOD_IMPLEMENTS",
] as const;

/** Edge types aggregated into the `confidenceBreakdown` tally. */
const CONFIDENCE_EDGE_TYPES = [
  ...CATEGORY_EDGE_TYPES,
  "CONTAINS",
  "PROCESS_STEP",
  "HANDLES_ROUTE",
] as const;

const ContextInput = {
  symbol: z
    .string()
    .min(1)
    .optional()
    .describe("The symbol name to inspect (function, class, method, etc.). Alias of `name`."),
  name: z.string().min(1).optional().describe("Alias for `symbol`."),
  uid: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Direct node id from prior tool results. When supplied, skips name-based disambiguation.",
    ),
  repo: z.string().optional().describe("Registered repo name; defaults to the only indexed repo."),
  kind: z
    .string()
    .optional()
    .describe("Optional NodeKind to disambiguate (e.g. 'Function' vs 'Method')."),
  file_path: z
    .string()
    .optional()
    .describe(
      "Optional file path substring to disambiguate same-named symbols. Matched via LIKE '%<file_path>%'.",
    ),
  filePath: z.string().optional().describe("camelCase alias of `file_path` for backward compat."),
  include_content: z
    .boolean()
    .optional()
    .describe(
      `When true, attach the target's indexed source under \`content\` (capped at ${CONTENT_CHAR_CAP} chars). Default false.`,
    ),
};

interface NodeRow {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly filePath: string;
}

interface CategorizedNodeRow extends NodeRow {
  readonly relType: string;
}

interface CochangePartner {
  readonly file: string;
  readonly cocommitCount: number;
  readonly lift: number;
  readonly lastCocommitAt: string;
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

/** Location block attached to every resolved target. */
interface TargetLocation {
  readonly filePath: string;
  readonly startLine: number | null;
  readonly endLine: number | null;
}

/** The seven canonical category buckets plus the two override-kind buckets. */
type CategoryBuckets = {
  calls: NodeRow[];
  imports: NodeRow[];
  accesses: NodeRow[];
  has_method: NodeRow[];
  has_property: NodeRow[];
  extends: NodeRow[];
  implements: NodeRow[];
  method_overrides: NodeRow[];
  method_implements: NodeRow[];
};

function makeBuckets(): CategoryBuckets {
  return {
    calls: [],
    imports: [],
    accesses: [],
    has_method: [],
    has_property: [],
    extends: [],
    implements: [],
    method_overrides: [],
    method_implements: [],
  };
}

interface ContextArgs {
  readonly symbol?: string | undefined;
  readonly name?: string | undefined;
  readonly uid?: string | undefined;
  readonly repo?: string | undefined;
  readonly kind?: string | undefined;
  readonly file_path?: string | undefined;
  readonly filePath?: string | undefined;
  readonly include_content?: boolean | undefined;
}

export async function runContext(ctx: ToolContext, args: ContextArgs): Promise<ToolResult> {
  const call = await withStore(ctx, args.repo, async (store, resolved) => {
    try {
      const nameInput = args.symbol ?? args.name;
      const uid = args.uid;
      if (!nameInput && !uid) {
        return withNextSteps(
          `Either "symbol" (or "name") or "uid" is required.`,
          { target: null, candidates: [] },
          ["call `query` to locate a symbol and re-try `context` with its uid"],
          stalenessFromMeta(resolved.meta),
        );
      }

      const filePathHint = args.file_path ?? args.filePath;
      const resolveArgs: {
        uid?: string;
        name?: string;
        kind?: string;
        filePath?: string;
      } = {};
      if (uid !== undefined) resolveArgs.uid = uid;
      if (nameInput !== undefined) resolveArgs.name = nameInput;
      if (args.kind !== undefined) resolveArgs.kind = args.kind;
      if (filePathHint !== undefined) resolveArgs.filePath = filePathHint;
      const resolution = await resolveTarget(store, resolveArgs);

      if (resolution.kind === "not_found") {
        const label = nameInput ?? uid ?? "(unknown)";
        return withNextSteps(
          `No symbol named "${label}" in ${resolved.name}.`,
          { target: null, candidates: [] },
          ["call `query` with a broader phrase to locate similar symbols"],
          stalenessFromMeta(resolved.meta),
        );
      }

      if (resolution.kind === "ambiguous") {
        const list = resolution.candidates
          .map((c, i) => `${i + 1}. [${c.kind}] ${c.filePath}  (${c.id})`)
          .join("\n");
        return withNextSteps(
          `"${nameInput ?? uid}" is ambiguous (${resolution.candidates.length} matches):\n${list}`,
          { target: null, candidates: resolution.candidates },
          ["re-call `context` with `uid` (from the list above) or narrow via `kind` / `file_path`"],
          stalenessFromMeta(resolved.meta),
        );
      }

      const target = resolution.target;
      const location: TargetLocation = {
        filePath: target.filePath,
        startLine: resolution.startLine,
        endLine: resolution.endLine,
      };
      const content = args.include_content === true ? capContent(resolution.content) : undefined;

      const [
        incomingRows,
        outgoingRows,
        processRows,
        cochanges,
        operations,
        breakdownEdges,
        owner,
      ] = await Promise.all([
        fetchCategorizedEdges(store, target.id, "incoming"),
        fetchCategorizedEdges(store, target.id, "outgoing"),
        fetchProcessParticipation(store, target.id),
        fetchCochangePartners(store, target),
        fetchLinkedOperations(store, target),
        fetchConfidenceBreakdownEdges(store, target.id),
        fetchOwner(store, target.id),
      ]);
      const confidenceBreakdown = computeConfidenceBreakdown(breakdownEdges);

      const incoming = bucketize(incomingRows);
      const outgoing = bucketize(outgoingRows);

      const callers = incoming.calls;
      const callees = outgoing.calls;
      const members = [...outgoing.has_method, ...outgoing.has_property];

      const lines: string[] = [];
      lines.push(`Symbol: ${target.name} [${target.kind}] — ${target.filePath}`);
      if (location.startLine !== null && location.endLine !== null) {
        lines.push(`Location: lines ${location.startLine}-${location.endLine}`);
      }
      lines.push(
        `Confidence: ${confidenceBreakdown.confirmed} confirmed, ` +
          `${confidenceBreakdown.heuristic} heuristic, ` +
          `${confidenceBreakdown.unknown} unknown`,
      );
      appendCategorySection(lines, "Incoming", incoming);
      appendCategorySection(lines, "Outgoing", outgoing);
      if (owner.length > 0) {
        lines.push(`Owner:`);
        for (const o of owner) lines.push(`  ⊃ ${o.name} [${o.kind}] — ${o.filePath}`);
      }
      if (processRows.length > 0) {
        lines.push(`Processes (${processRows.length}):`);
        for (const p of processRows) {
          const stepSuffix = p.step !== null ? ` (step ${p.step})` : "";
          lines.push(`  ⊿ ${p.label}${stepSuffix}`);
        }
      }
      if (cochanges.length > 0) {
        lines.push(
          `Files often edited together with this one (by lift) — git history, NOT call dependencies (${cochanges.length}):`,
        );
        for (const p of cochanges) {
          lines.push(
            `  ⇌ ${p.file} [lift=${p.lift.toFixed(2)}, co-commits=${p.cocommitCount}, last=${p.lastCocommitAt}]`,
          );
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
      if (content !== undefined) {
        lines.push(`Content (first ${CONTENT_CHAR_CAP} chars):`);
        lines.push(content);
      }

      const next: string[] = [
        `call \`impact\` with target="${target.id}" to see downstream blast radius`,
      ];
      if (callers.length === 0) {
        next.push("no callers found — this may be an entry point or dead code");
      }
      if (cochanges.length > 0) {
        next.push(
          "review cochanges: files historically edited together with this one (git-history signal, not call dependencies)",
        );
      }
      if (operations.length > 0) {
        next.push(
          "route is documented by an OpenAPI operation — consult the spec file(s) listed above",
        );
      }

      const structured: Record<string, unknown> = {
        target,
        location,
        candidates: [],
        incoming,
        outgoing,
        processes: processRows,
        // Flat legacy fields preserved for pre-parity consumers.
        callers,
        callees,
        members,
        owner,
        cochanges,
        operations,
        confidenceBreakdown,
      };
      if (content !== undefined) structured["content"] = content;

      return withNextSteps(lines.join("\n"), structured, next, stalenessFromMeta(resolved.meta));
    } catch (err) {
      return toolErrorFromUnknown(err);
    }
  });
  return toToolResult(call);
}

export function registerContextTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "context",
    {
      title: "360-degree symbol view",
      description:
        "Resolve a symbol to its graph node and return categorised incoming/outgoing edges (calls, imports, accesses, has_method, has_property, extends, implements, method_overrides, method_implements), process participation, OpenAPI operation links for Route targets, and file location. Use `uid` for zero-ambiguity lookup, or narrow a common name with `file_path` and/or `kind`; when a name still matches more than one node the response is a candidate list for you to pick from. Set `include_content: true` to attach the indexed source (capped at 2000 characters). The response also carries a `confidenceBreakdown` (confirmed / heuristic / unknown) tallying the provenance tier of every edge surfaced — so callers can tell whether the neighbourhood is backed by an LSP oracle or by heuristics. Finally, a top-level `cochanges` field lists files often edited together with the target's enclosing file, ranked by lift. These come from the dedicated `cochanges` table (git history), are strictly a statistical signal, and MUST NOT be treated as static code dependencies.",
      inputSchema: ContextInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => fromToolResult(await runContext(ctx, args)),
  );
}

type ResolveOutcome =
  | { kind: "not_found" }
  | { kind: "ambiguous"; candidates: NodeRow[] }
  | {
      kind: "resolved";
      target: NodeRow;
      startLine: number | null;
      endLine: number | null;
      content: string | null;
    };

/**
 * Resolve a symbol to a single graph node.
 *
 * `uid` short-circuits the resolver — we ignore name/kind/filePath hints
 * and return the matching node if present. For name-based lookup we apply
 * `kind` and `filePath` as filters and return every match up to 25 rows.
 */
async function resolveTarget(
  store: import("@opencodehub/storage").IGraphStore,
  args: { uid?: string; name?: string; kind?: string; filePath?: string },
): Promise<ResolveOutcome> {
  if (args.uid) {
    const rows = (await store.query(
      "SELECT id, name, kind, file_path, start_line, end_line, content FROM nodes WHERE id = ? LIMIT 1",
      [args.uid],
    )) as ReadonlyArray<Record<string, unknown>>;
    const row = rows[0];
    if (!row) return { kind: "not_found" };
    return {
      kind: "resolved",
      target: rowToNode(row),
      startLine: toLineOrNull(row["start_line"]),
      endLine: toLineOrNull(row["end_line"]),
      content: stringOrNull(row["content"]),
    };
  }

  if (!args.name) return { kind: "not_found" };

  const params: (string | number)[] = [args.name];
  let sql =
    "SELECT id, name, kind, file_path, start_line, end_line, content FROM nodes WHERE name = ?";
  if (args.kind) {
    sql += " AND kind = ?";
    params.push(args.kind);
  }
  if (args.filePath) {
    sql += " AND file_path LIKE ?";
    params.push(`%${args.filePath}%`);
  }
  sql += " ORDER BY file_path LIMIT 25";
  const rows = (await store.query(sql, params)) as ReadonlyArray<Record<string, unknown>>;

  if (rows.length === 0) return { kind: "not_found" };
  if (rows.length > 1) {
    return {
      kind: "ambiguous",
      candidates: rows.map(rowToNode),
    };
  }
  const row = rows[0];
  if (!row) return { kind: "not_found" };
  return {
    kind: "resolved",
    target: rowToNode(row),
    startLine: toLineOrNull(row["start_line"]),
    endLine: toLineOrNull(row["end_line"]),
    content: stringOrNull(row["content"]),
  };
}

function rowToNode(r: Record<string, unknown>): NodeRow {
  return {
    id: String(r["id"]),
    name: String(r["name"]),
    kind: String(r["kind"]),
    filePath: String(r["file_path"] ?? ""),
  };
}

function toLineOrNull(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

function stringOrNull(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  return raw;
}

function capContent(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  if (raw.length <= CONTENT_CHAR_CAP) return raw;
  return `${raw.slice(0, CONTENT_CHAR_CAP - 1)}…`;
}

/**
 * Fetch every edge connected to the target in a single round-trip,
 * projecting both the relation type and the partner node's metadata. The
 * `direction` selects whether the target sits on the `to_id` (incoming)
 * or `from_id` (outgoing) side of the join.
 */
async function fetchCategorizedEdges(
  store: import("@opencodehub/storage").IGraphStore,
  targetId: string,
  direction: "incoming" | "outgoing",
): Promise<readonly CategorizedNodeRow[]> {
  const placeholders = CATEGORY_EDGE_TYPES.map(() => "?").join(",");
  const whereKey = direction === "incoming" ? "r.to_id" : "r.from_id";
  const joinKey = direction === "incoming" ? "r.from_id" : "r.to_id";
  const sql = `SELECT r.type AS rel_type, n.id, n.name, n.kind, n.file_path FROM relations r JOIN nodes n ON n.id = ${joinKey} WHERE ${whereKey} = ? AND r.type IN (${placeholders}) LIMIT 200`;
  const rows = (await store.query(sql, [targetId, ...CATEGORY_EDGE_TYPES])) as ReadonlyArray<
    Record<string, unknown>
  >;
  return rows.map((r) => ({
    relType: String(r["rel_type"] ?? ""),
    id: String(r["id"]),
    name: String(r["name"]),
    kind: String(r["kind"]),
    filePath: String(r["file_path"] ?? ""),
  }));
}

function bucketize(rows: readonly CategorizedNodeRow[]): CategoryBuckets {
  const buckets = makeBuckets();
  for (const r of rows) {
    const key = r.relType.toLowerCase() as keyof CategoryBuckets;
    const node: NodeRow = { id: r.id, name: r.name, kind: r.kind, filePath: r.filePath };
    const bucket = buckets[key];
    if (Array.isArray(bucket)) bucket.push(node);
  }
  return buckets;
}

function appendCategorySection(lines: string[], header: string, buckets: CategoryBuckets): void {
  const entries: Array<[string, readonly NodeRow[]]> = [
    ["calls", buckets.calls],
    ["imports", buckets.imports],
    ["accesses", buckets.accesses],
    ["has_method", buckets.has_method],
    ["has_property", buckets.has_property],
    ["extends", buckets.extends],
    ["implements", buckets.implements],
    ["method_overrides", buckets.method_overrides],
    ["method_implements", buckets.method_implements],
  ];
  const total = entries.reduce((acc, [, list]) => acc + list.length, 0);
  lines.push(`${header} (${total}):`);
  const arrow = header === "Incoming" ? "←" : "→";
  for (const [label, list] of entries) {
    if (list.length === 0) continue;
    lines.push(`  ${label} (${list.length}):`);
    for (const n of list) {
      lines.push(`    ${arrow} ${n.name} [${n.kind}] — ${n.filePath}`);
    }
  }
}

interface ProcessParticipation {
  readonly id: string;
  readonly label: string;
  readonly step: number | null;
}

/**
 * Find Process-kind partners reachable from the target via `PROCESS_STEP`
 * edges. The processes phase emits symbol-to-symbol step edges under a
 * Process node, so we accept either direction on the join and filter on
 * `kind = 'Process'`.
 */
async function fetchProcessParticipation(
  store: import("@opencodehub/storage").IGraphStore,
  targetId: string,
): Promise<readonly ProcessParticipation[]> {
  const rows = (await store.query(
    "SELECT DISTINCT p.id AS id, p.name AS name, p.inferred_label AS label, r.step AS step FROM relations r JOIN nodes p ON (p.id = r.from_id OR p.id = r.to_id) WHERE (r.from_id = ? OR r.to_id = ?) AND r.type = 'PROCESS_STEP' AND p.kind = 'Process' ORDER BY r.step LIMIT 20",
    [targetId, targetId],
  )) as ReadonlyArray<Record<string, unknown>>;
  return rows.map((r) => {
    const rawLabel = r["label"];
    const rawName = r["name"];
    const label =
      typeof rawLabel === "string" && rawLabel.length > 0 ? rawLabel : String(rawName ?? "");
    return {
      id: String(r["id"]),
      label,
      step: toLineOrNull(r["step"]),
    };
  });
}

/**
 * Fetch the target's enclosing owner (class/module/file). Mirrors the
 * previous tool's behaviour: any of HAS_METHOD / HAS_PROPERTY / CONTAINS
 * pointing at the target counts as an owner edge.
 */
async function fetchOwner(
  store: import("@opencodehub/storage").IGraphStore,
  targetId: string,
): Promise<readonly NodeRow[]> {
  const rows = (await store.query(
    "SELECT n.id, n.name, n.kind, n.file_path FROM relations r JOIN nodes n ON n.id = r.from_id WHERE r.to_id = ? AND r.type IN ('HAS_METHOD','HAS_PROPERTY','CONTAINS') LIMIT 5",
    [targetId],
  )) as ReadonlyArray<Record<string, unknown>>;
  return rows.map(rowToNode);
}

/**
 * Fetch up to 10 strongest cochange partners for the target's enclosing
 * file from the dedicated `cochanges` table. For File-kind targets we use
 * the node's own `file_path`; for any other kind we use `target.filePath`
 * so the caller always gets file-level cochange even when they asked about
 * a symbol inside the file.
 *
 * Ranked by `lift` DESC; rows below the default lift floor (1.0 — i.e.
 * weaker than chance) are dropped. This is a statistical (git-history)
 * signal, not a call-graph dependency.
 */
async function fetchCochangePartners(
  store: import("@opencodehub/storage").IGraphStore,
  target: NodeRow,
): Promise<CochangePartner[]> {
  const file = target.filePath;
  if (file.length === 0) return [];
  const rows = await store.lookupCochangesForFile(file, { limit: 10 });
  const out: CochangePartner[] = [];
  for (const r of rows) {
    const partner = r.sourceFile === file ? r.targetFile : r.sourceFile;
    out.push({
      file: partner,
      cocommitCount: r.cocommitCount,
      lift: r.lift,
      lastCocommitAt: r.lastCocommitAt,
    });
  }
  return out;
}

/**
 * For `Route` targets, fetch all `Operation` nodes connected via
 * `HANDLES_ROUTE` (Operation → Route direction — emitted by the OpenAPI
 * phase). Returns an empty array for any non-Route target so the main
 * handler can call unconditionally.
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

/**
 * Fetch `confidence` + `reason` for every incoming and outgoing edge that
 * the `context` response surfaces. The filter list mirrors the relation
 * types queried above. Cochange rows live in their own table with different
 * semantics (lift, not confidence) and never enter the confidence-breakdown
 * tally.
 */
async function fetchConfidenceBreakdownEdges(
  store: import("@opencodehub/storage").IGraphStore,
  targetId: string,
): Promise<readonly EdgeConfidenceSource[]> {
  const placeholders = CONFIDENCE_EDGE_TYPES.map(() => "?").join(",");
  const rows = (await store.query(
    `SELECT confidence, reason FROM relations WHERE (from_id = ? OR to_id = ?) AND type IN (${placeholders})`,
    [targetId, targetId, ...CONFIDENCE_EDGE_TYPES],
  )) as ReadonlyArray<Record<string, unknown>>;

  const out: EdgeConfidenceSource[] = [];
  for (const r of rows) {
    const confidenceRaw = Number(r["confidence"] ?? 0);
    const reasonRaw = r["reason"];
    out.push({
      confidence: Number.isFinite(confidenceRaw) ? confidenceRaw : 0,
      ...(typeof reasonRaw === "string" && reasonRaw.length > 0 ? { reason: reasonRaw } : {}),
    });
  }
  return out;
}
