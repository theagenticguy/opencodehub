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
 *   - `coverage` (optional) — line-level test coverage for the target,
 *     read from the `coverage` overlay phase. Present only when a coverage
 *     report was ingested for the target (or its enclosing file); ABSENT
 *     coverage is treated as UNKNOWN and the field is omitted entirely so a
 *     caller never mistakes "not ingested" for "0% covered".
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
import type { GraphNode } from "@opencodehub/core-types";
import type { IGraphStore, Store } from "@opencodehub/storage";
import { z } from "zod";
import { toolErrorFromUnknown } from "../error-envelope.js";
import { withNextSteps } from "../next-step-hints.js";
import { stalenessFromMeta } from "../staleness.js";
import { computeConfidenceBreakdown, type EdgeConfidenceSource } from "./confidence.js";
import {
  fromToolResult,
  repoArgShape,
  type ToolContext,
  type ToolResult,
  toToolResult,
  withStore,
} from "./shared.js";

/** Upper bound on the `content` field size when `include_content` is true. */
const CONTENT_CHAR_CAP = 2000;

/**
 * Coverage ratio below which a symbol is flagged as thinly tested. Matches the
 * `verdict` tool's `complex_and_untested` escalation threshold so the two
 * surfaces agree on what "untested" means.
 */
const COVERAGE_THIN_THRESHOLD = 0.5;

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
  ...repoArgShape,
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

/**
 * Coverage block attached to a resolved target when the `coverage` overlay
 * phase ingested a report for it. `percent` is the line-level ratio in
 * [0, 1]; `covered` is the human-friendly verdict against
 * {@link COVERAGE_THIN_THRESHOLD}; `source` records whether the ratio came
 * from the target symbol itself or was inherited from its enclosing file.
 * When coverage was never ingested the whole block is omitted — absent
 * coverage is UNKNOWN, never 0%.
 */
interface TargetCoverage {
  readonly percent: number;
  readonly covered: boolean;
  readonly source: "symbol" | "file";
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
  readonly repo_uri?: string | undefined;
  readonly kind?: string | undefined;
  readonly file_path?: string | undefined;
  readonly filePath?: string | undefined;
  readonly include_content?: boolean | undefined;
}

export async function runContext(ctx: ToolContext, args: ContextArgs): Promise<ToolResult> {
  const call = await withStore(ctx, args, async (store, resolved) => {
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
      const resolution = await resolveTarget(store.graph, resolveArgs);

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
        coverage,
      ] = await Promise.all([
        fetchCategorizedEdges(store.graph, target.id, "incoming"),
        fetchCategorizedEdges(store.graph, target.id, "outgoing"),
        fetchProcessParticipation(store.graph, target.id),
        fetchCochangePartners(store, target),
        fetchLinkedOperations(store.graph, target),
        fetchConfidenceBreakdownEdges(store.graph, target.id),
        fetchOwner(store.graph, target.id),
        fetchTargetCoverage(store.graph, target, resolution.coveragePercent),
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
      if (coverage !== undefined) {
        const pct = (coverage.percent * 100).toFixed(1);
        const verdict = coverage.covered ? "covered" : "thinly tested";
        lines.push(`Coverage: ${pct}% (${verdict}, from ${coverage.source})`);
      } else {
        lines.push("Coverage: unknown (no coverage report ingested for this target)");
      }
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
      // Coverage is OPTIONAL: only attached when a report was ingested for the
      // target (or its enclosing file). Omitting the field when unknown is the
      // contract — a caller must never read absence as "0% covered".
      if (coverage !== undefined) structured["coverage"] = coverage;
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
        "Resolve a symbol to its graph node and return categorised incoming/outgoing edges (calls, imports, accesses, has_method, has_property, extends, implements, method_overrides, method_implements), process participation, OpenAPI operation links for Route targets, and file location. Use `uid` for zero-ambiguity lookup, or narrow a common name with `file_path` and/or `kind`; when a name still matches more than one node the response is a candidate list for you to pick from. Set `include_content: true` to attach the indexed source (capped at 2000 characters). The response also carries a `confidenceBreakdown` (confirmed / heuristic / unknown) tallying the provenance tier of every edge surfaced — so callers can tell whether the neighbourhood is backed by an LSP oracle or by heuristics. When the `coverage` overlay phase ingested a report, an optional `coverage` field reports `{ percent (0–1), covered, source }` for the target (per-symbol when available, else inherited from its enclosing file). The field is OMITTED when no coverage was ingested — absent coverage is UNKNOWN, never 0%, so do not treat a missing `coverage` field as untested. Finally, a top-level `cochanges` field lists files often edited together with the target's enclosing file, ranked by lift. These come from the dedicated `cochanges` table (git history), are strictly a statistical signal, and MUST NOT be treated as static code dependencies.",
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
      /**
       * Line-level coverage ratio carried on the resolved node itself
       * (callables get one from the coverage phase). `null` when the node
       * has no ingested coverage — distinct from a real 0.
       */
      coveragePercent: number | null;
    };

/**
 * Resolve a symbol to a single graph node.
 *
 * `uid` short-circuits the resolver — we ignore name/kind/filePath hints
 * and return the matching node if present. For name-based lookup we apply
 * `kind` and `filePath` as filters and return every match up to 25 rows.
 */
async function resolveTarget(
  graph: IGraphStore,
  args: { uid?: string; name?: string; kind?: string; filePath?: string },
): Promise<ResolveOutcome> {
  if (args.uid) {
    const list = await graph.listNodes({ ids: [args.uid], limit: 1 });
    const node = list[0];
    if (!node) return { kind: "not_found" };
    return {
      kind: "resolved",
      target: nodeToRow(node),
      startLine: toLineOrNull(getProp(node, "startLine")),
      endLine: toLineOrNull(getProp(node, "endLine")),
      content: stringOrNull(getProp(node, "content")),
      coveragePercent: coverageOrNull(getProp(node, "coveragePercent")),
    };
  }

  if (!args.name) return { kind: "not_found" };

  // listNodesByName narrows by name + optional kinds. The filePath
  // substring filter is applied in TS post-finder because the typed
  // option only supports exact-match.
  type NodeKindUnion = Parameters<IGraphStore["listNodesByKind"]>[0];
  const listOpts = args.kind !== undefined ? { kinds: [args.kind as NodeKindUnion] } : {};
  let candidates = await graph.listNodesByName(args.name, listOpts);
  if (args.filePath !== undefined) {
    const sub = args.filePath;
    candidates = candidates.filter((n) => n.filePath.includes(sub));
  }
  // Match prior ORDER BY file_path LIMIT 25.
  const sorted = [...candidates].sort((a, b) =>
    a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0,
  );
  const sliced = sorted.slice(0, 25);

  if (sliced.length === 0) return { kind: "not_found" };
  if (sliced.length > 1) {
    return {
      kind: "ambiguous",
      candidates: sliced.map(nodeToRow),
    };
  }
  const node = sliced[0];
  if (!node) return { kind: "not_found" };
  return {
    kind: "resolved",
    target: nodeToRow(node),
    startLine: toLineOrNull(getProp(node, "startLine")),
    endLine: toLineOrNull(getProp(node, "endLine")),
    content: stringOrNull(getProp(node, "content")),
    coveragePercent: coverageOrNull(getProp(node, "coveragePercent")),
  };
}

function nodeToRow(n: GraphNode): NodeRow {
  return {
    id: n.id,
    name: n.name,
    kind: n.kind,
    filePath: n.filePath,
  };
}

function getProp(n: GraphNode, key: string): unknown {
  return (n as unknown as Record<string, unknown>)[key];
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

/**
 * Coerce a raw `coveragePercent` value to a finite ratio in [0, 1], or
 * `null` when the field is absent/non-numeric. Returning `null` (not 0) is
 * load-bearing: a missing coverage column means "never ingested" (UNKNOWN),
 * which must not be rendered as "0% covered".
 */
function coverageOrNull(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw < 0 || raw > 1) return null;
  return raw;
}

/**
 * Resolve the coverage block for a target. Prefers the ratio carried on the
 * resolved node itself (callables get a per-symbol ratio from the coverage
 * phase); for File targets that ratio already IS the file ratio. Otherwise
 * falls back to the enclosing File node's `coveragePercent` so a symbol
 * inside a covered file still reports coverage. Returns `undefined` when no
 * coverage was ingested anywhere on the path — the caller omits the field.
 */
async function fetchTargetCoverage(
  graph: IGraphStore,
  target: NodeRow,
  ownCoverage: number | null,
): Promise<TargetCoverage | undefined> {
  if (ownCoverage !== null) {
    return {
      percent: ownCoverage,
      covered: ownCoverage >= COVERAGE_THIN_THRESHOLD,
      source: target.kind === "File" ? "file" : "symbol",
    };
  }
  // Symbol carried no coverage — inherit from its enclosing File node when one
  // exists with an ingested ratio. File targets with no own ratio fall through
  // to UNKNOWN (we don't re-query the same node).
  if (target.kind === "File" || target.filePath.length === 0) return undefined;
  const fileNodes = await graph.listNodesByKind("File", { filePath: target.filePath });
  for (const node of fileNodes) {
    const fileCov = coverageOrNull(getProp(node, "coveragePercent"));
    if (fileCov !== null) {
      return {
        percent: fileCov,
        covered: fileCov >= COVERAGE_THIN_THRESHOLD,
        source: "file",
      };
    }
  }
  return undefined;
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
  graph: IGraphStore,
  targetId: string,
  direction: "incoming" | "outgoing",
): Promise<readonly CategorizedNodeRow[]> {
  const filter = direction === "incoming" ? { toIds: [targetId] } : { fromIds: [targetId] };
  const edges = await graph.listEdges({
    types: CATEGORY_EDGE_TYPES,
    ...filter,
    limit: 200,
  });
  if (edges.length === 0) return [];
  const partnerIds = Array.from(
    new Set(edges.map((e) => (direction === "incoming" ? e.from : e.to))),
  );
  const partners = await graph.listNodes({ ids: partnerIds });
  const byId = new Map<string, GraphNode>();
  for (const n of partners) byId.set(n.id, n);
  const out: CategorizedNodeRow[] = [];
  for (const e of edges) {
    const partnerId = direction === "incoming" ? e.from : e.to;
    const partner = byId.get(partnerId);
    if (!partner) continue;
    out.push({
      relType: e.type,
      id: partner.id,
      name: partner.name,
      kind: partner.kind,
      filePath: partner.filePath,
    });
  }
  return out;
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
  graph: IGraphStore,
  targetId: string,
): Promise<readonly ProcessParticipation[]> {
  const [outEdges, inEdges] = await Promise.all([
    graph.listEdgesByType("PROCESS_STEP", { fromIds: [targetId] }),
    graph.listEdgesByType("PROCESS_STEP", { toIds: [targetId] }),
  ]);
  const partnerIds = new Set<string>();
  for (const e of [...outEdges, ...inEdges]) {
    const id = e.from === targetId ? e.to : e.from;
    partnerIds.add(id);
  }
  if (partnerIds.size === 0) return [];
  const partners = await graph.listNodes({ ids: [...partnerIds] });
  const partnerById = new Map<string, GraphNode>();
  for (const p of partners) partnerById.set(p.id, p);
  const dedup = new Map<string, { label: string; step: number | null }>();
  for (const e of [...outEdges, ...inEdges]) {
    const partnerId = e.from === targetId ? e.to : e.from;
    const partner = partnerById.get(partnerId);
    if (partner?.kind !== "Process") continue;
    if (dedup.has(partner.id)) continue;
    const inferredLabel = (partner as unknown as { inferredLabel?: string }).inferredLabel;
    const label =
      typeof inferredLabel === "string" && inferredLabel.length > 0 ? inferredLabel : partner.name;
    dedup.set(partner.id, { label, step: toLineOrNull(e.step) });
  }
  const items = Array.from(dedup.entries()).map(([id, v]) => ({
    id,
    label: v.label,
    step: v.step,
  }));
  items.sort((a, b) => {
    const as = a.step ?? Number.POSITIVE_INFINITY;
    const bs = b.step ?? Number.POSITIVE_INFINITY;
    if (as !== bs) return as - bs;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return items.slice(0, 20);
}

/**
 * Fetch the target's enclosing owner (class/module/file). Mirrors the
 * previous tool's behaviour: any of HAS_METHOD / HAS_PROPERTY / CONTAINS
 * pointing at the target counts as an owner edge.
 */
async function fetchOwner(graph: IGraphStore, targetId: string): Promise<readonly NodeRow[]> {
  const edges = await graph.listEdges({
    types: ["HAS_METHOD", "HAS_PROPERTY", "CONTAINS"],
    toIds: [targetId],
    limit: 5,
  });
  if (edges.length === 0) return [];
  const fromIds = Array.from(new Set(edges.map((e) => e.from)));
  const partners = await graph.listNodes({ ids: fromIds });
  const byId = new Map<string, GraphNode>();
  for (const n of partners) byId.set(n.id, n);
  const out: NodeRow[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (seen.has(e.from)) continue;
    seen.add(e.from);
    const node = byId.get(e.from);
    if (!node) continue;
    out.push(nodeToRow(node));
  }
  return out;
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
async function fetchCochangePartners(store: Store, target: NodeRow): Promise<CochangePartner[]> {
  const file = target.filePath;
  if (file.length === 0) return [];
  const rows = await store.temporal.lookupCochangesForFile(file, { limit: 10 });
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
  graph: IGraphStore,
  target: NodeRow,
): Promise<LinkedOperation[]> {
  if (target.kind !== "Route") return [];

  const edges = await graph.listEdgesByType("HANDLES_ROUTE", { toIds: [target.id], limit: 20 });
  if (edges.length === 0) return [];
  const fromIds = Array.from(new Set(edges.map((e) => e.from)));
  const partners = await graph.listNodes({ ids: fromIds });
  const byId = new Map<string, GraphNode>();
  for (const p of partners) byId.set(p.id, p);

  const out: LinkedOperation[] = [];
  for (const e of edges) {
    const partner = byId.get(e.from);
    if (partner?.kind !== "Operation") continue;
    const opAny = partner as unknown as Record<string, unknown>;
    const httpMethod =
      typeof opAny["httpMethod"] === "string" ? (opAny["httpMethod"] as string) : "";
    const httpPath = typeof opAny["httpPath"] === "string" ? (opAny["httpPath"] as string) : "";
    const summary = typeof opAny["summary"] === "string" ? (opAny["summary"] as string) : undefined;
    const operationId =
      typeof opAny["operationId"] === "string" ? (opAny["operationId"] as string) : undefined;
    out.push({
      id: partner.id,
      method: httpMethod,
      path: httpPath,
      filePath: partner.filePath,
      ...(typeof summary === "string" && summary.length > 0 ? { summary } : {}),
      ...(typeof operationId === "string" && operationId.length > 0 ? { operationId } : {}),
    });
  }
  out.sort((a, b) => {
    if (a.method !== b.method) return a.method < b.method ? -1 : 1;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
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
  graph: IGraphStore,
  targetId: string,
): Promise<readonly EdgeConfidenceSource[]> {
  const [fromEdges, toEdges] = await Promise.all([
    graph.listEdges({ types: CONFIDENCE_EDGE_TYPES, fromIds: [targetId] }),
    graph.listEdges({ types: CONFIDENCE_EDGE_TYPES, toIds: [targetId] }),
  ]);
  const out: EdgeConfidenceSource[] = [];
  const seen = new Set<string>();
  for (const e of [...fromEdges, ...toEdges]) {
    const key = `${e.from}|${e.to}|${e.type}|${e.step ?? 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const confidenceRaw = Number(e.confidence ?? 0);
    const reasonRaw = e.reason;
    out.push({
      confidence: Number.isFinite(confidenceRaw) ? confidenceRaw : 0,
      ...(typeof reasonRaw === "string" && reasonRaw.length > 0 ? { reason: reasonRaw } : {}),
    });
  }
  return out;
}
