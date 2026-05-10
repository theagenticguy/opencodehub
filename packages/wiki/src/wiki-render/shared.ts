/**
 * Shared helpers for wiki renderers.
 *
 * Everything here is pure: no LLM calls, no network, no clock. The only
 * side effect is reading from the graph store via typed `IGraphStore`
 * finders. Each helper returns structured data the render modules turn
 * into Markdown.
 */

import type { IGraphStore } from "@opencodehub/storage";

/** Minimal Community row. */
export interface CommunityRow {
  readonly id: string;
  readonly name: string;
  readonly inferredLabel: string;
  readonly symbolCount: number;
  readonly cohesion: number;
  readonly truckFactor: number | undefined;
}

/** Member file of a community plus an aggregate symbol count. */
export interface CommunityMemberFile {
  readonly filePath: string;
  readonly memberCount: number;
}

/** Ranked contributor for a community (derived from OWNED_BY edges). */
export interface CommunityContributor {
  readonly contributorId: string;
  readonly name: string;
  readonly emailHash: string;
  readonly emailPlain: string;
  readonly lineShare: number;
}

export interface RouteRow {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly method: string;
  readonly handlerFilePath: string;
}

export interface OperationRow {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly method: string;
  readonly summary: string;
  readonly filePath: string;
}

export interface FetchesRow {
  readonly fromFilePath: string;
  readonly fromName: string;
  readonly toUrl: string;
}

export interface DependencyRow {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly ecosystem: string;
  readonly license: string;
  readonly lockfileSource: string;
  readonly usageCount: number;
}

export interface OwnershipEntry {
  readonly contributorId: string;
  readonly name: string;
  readonly emailHash: string;
  readonly emailPlain: string;
  readonly lineShare: number;
}

export interface DeadFunctionRow {
  readonly id: string;
  readonly name: string;
  readonly filePath: string;
  readonly startLine: number | undefined;
  readonly endLine: number | undefined;
  readonly deadness: string;
}

export interface OrphanFileRow {
  readonly id: string;
  readonly filePath: string;
  readonly orphanGrade: string;
}

export interface ProjectProfileSummary {
  readonly languages: readonly string[];
  readonly frameworks: readonly string[];
  readonly apiContracts: readonly string[];
  readonly iacTypes: readonly string[];
}

export async function loadCommunities(store: IGraphStore): Promise<readonly CommunityRow[]> {
  try {
    const nodes = await store.listNodesByKind("Community");
    return nodes.map((n) => ({
      id: n.id,
      name: n.name,
      inferredLabel: n.inferredLabel ?? "",
      symbolCount: typeof n.symbolCount === "number" ? n.symbolCount : 0,
      cohesion: typeof n.cohesion === "number" ? n.cohesion : 0,
      truckFactor: typeof n.truckFactor === "number" ? n.truckFactor : undefined,
    }));
  } catch {
    return [];
  }
}

/**
 * Top files in a community, ranked by the number of member symbols whose File
 * resolves to that path. Relies on the MEMBER_OF edge between a symbol and the
 * community node.
 *
 * Implementation: walk MEMBER_OF edges with the typed `listEdgesByType`
 * finder, lift every node via `listNodes()`, then aggregate `filePath`
 * counts in JS — the SQL `GROUP BY n.file_path` becomes a Map<filePath, count>.
 */
export async function loadCommunityTopFiles(
  store: IGraphStore,
  communityId: string,
  limit: number,
): Promise<readonly CommunityMemberFile[]> {
  try {
    const memberEdges = await store.listEdgesByType("MEMBER_OF", { toIds: [communityId] });
    if (memberEdges.length === 0) return [];
    const memberFromIds = new Set(memberEdges.map((e) => e.from));
    const allNodes = await store.listNodes();
    const byFile = new Map<string, number>();
    for (const n of allNodes) {
      if (!memberFromIds.has(n.id)) continue;
      if (typeof n.filePath !== "string" || n.filePath.length === 0) continue;
      byFile.set(n.filePath, (byFile.get(n.filePath) ?? 0) + 1);
    }
    const rows: CommunityMemberFile[] = [];
    for (const [filePath, memberCount] of byFile) {
      rows.push({ filePath, memberCount });
    }
    rows.sort((a, b) => {
      if (b.memberCount !== a.memberCount) return b.memberCount - a.memberCount;
      return a.filePath.localeCompare(b.filePath);
    });
    return rows.slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Top contributors for a community, ranked by summed OWNED_BY edge weight
 * across the community's File members.
 *
 * Implementation: replace the four-way SQL JOIN with three typed finders —
 * MEMBER_OF edges (community → members), File node set, OWNED_BY edges
 * (file → contributor), Contributor node set — and accumulate
 * line-share by contributor in JS.
 */
export async function loadCommunityTopContributors(
  store: IGraphStore,
  communityId: string,
  limit: number,
): Promise<readonly CommunityContributor[]> {
  try {
    const memberEdges = await store.listEdgesByType("MEMBER_OF", { toIds: [communityId] });
    if (memberEdges.length === 0) return [];
    const memberFromIds = new Set(memberEdges.map((e) => e.from));
    const fileNodes = await store.listNodesByKind("File");
    const fileIdsInCommunity: string[] = [];
    for (const f of fileNodes) {
      if (memberFromIds.has(f.id)) fileIdsInCommunity.push(f.id);
    }
    if (fileIdsInCommunity.length === 0) return [];
    const ownedByEdges = await store.listEdgesByType("OWNED_BY", { fromIds: fileIdsInCommunity });
    if (ownedByEdges.length === 0) return [];
    const contributors = await store.listNodesByKind("Contributor");
    const contributorById = new Map(contributors.map((c) => [c.id, c]));
    const shares = new Map<
      string,
      { id: string; name: string; emailHash: string; emailPlain: string; share: number }
    >();
    for (const e of ownedByEdges) {
      const contributor = contributorById.get(e.to);
      if (contributor === undefined) continue;
      const prior = shares.get(contributor.id);
      const inc = Number.isFinite(e.confidence) ? e.confidence : 0;
      if (prior === undefined) {
        shares.set(contributor.id, {
          id: contributor.id,
          name: contributor.name,
          emailHash: contributor.emailHash,
          emailPlain: contributor.emailPlain ?? "",
          share: inc,
        });
      } else {
        prior.share += inc;
      }
    }
    const rows = [...shares.values()];
    rows.sort((a, b) => {
      if (b.share !== a.share) return b.share - a.share;
      return a.id.localeCompare(b.id);
    });
    return rows.slice(0, limit).map((r) => ({
      contributorId: r.id,
      name: r.name,
      emailHash: r.emailHash,
      emailPlain: r.emailPlain,
      lineShare: r.share,
    }));
  } catch {
    return [];
  }
}

export async function loadProjectProfile(
  store: IGraphStore,
): Promise<ProjectProfileSummary | undefined> {
  try {
    const nodes = await store.listNodesByKind("ProjectProfile", { limit: 1 });
    const node = nodes[0];
    if (node === undefined) return undefined;
    // The typed ProjectProfileNode already exposes the four arrays as
    // `readonly string[]`; no JSON re-parse needed.
    return {
      languages: node.languages ?? [],
      frameworks: node.frameworks ?? [],
      apiContracts: node.apiContracts ?? [],
      iacTypes: node.iacTypes ?? [],
    };
  } catch {
    return undefined;
  }
}

export async function loadRoutes(store: IGraphStore): Promise<readonly RouteRow[]> {
  try {
    const [routes, handlerEdges, allNodes] = await Promise.all([
      store.listRoutes(),
      store.listEdgesByType("HANDLES_ROUTE"),
      store.listNodes(),
    ]);
    const handlersByRouteId = new Map<string, string[]>();
    const nodeById = new Map(allNodes.map((n) => [n.id, n]));
    for (const e of handlerEdges) {
      const handler = nodeById.get(e.from);
      if (handler === undefined) continue;
      if (typeof handler.filePath !== "string" || handler.filePath.length === 0) continue;
      const list = handlersByRouteId.get(e.to);
      if (list === undefined) {
        handlersByRouteId.set(e.to, [handler.filePath]);
      } else {
        list.push(handler.filePath);
      }
    }
    const rows: RouteRow[] = routes.map((r) => {
      const paths = handlersByRouteId.get(r.id) ?? [];
      // SQL `MIN(handler.file_path)` collation = lex ASC.
      const minPath =
        paths.length === 0 ? "" : (paths.slice().sort((a, b) => a.localeCompare(b))[0] ?? "");
      return {
        id: r.id,
        name: r.name,
        url: r.url,
        method: r.method ?? "",
        handlerFilePath: minPath,
      };
    });
    rows.sort((a, b) => {
      if (a.url !== b.url) return a.url.localeCompare(b.url);
      if (a.method !== b.method) return a.method.localeCompare(b.method);
      return a.id.localeCompare(b.id);
    });
    return rows;
  } catch {
    return [];
  }
}

export async function loadOperations(store: IGraphStore): Promise<readonly OperationRow[]> {
  try {
    const ops = await store.listNodesByKind("Operation");
    const rows: OperationRow[] = ops.map((op) => ({
      id: op.id,
      name: op.name,
      path: op.path,
      method: op.method,
      summary: op.summary ?? "",
      filePath: op.filePath,
    }));
    rows.sort((a, b) => {
      if (a.path !== b.path) return a.path.localeCompare(b.path);
      if (a.method !== b.method) return a.method.localeCompare(b.method);
      return a.id.localeCompare(b.id);
    });
    return rows;
  } catch {
    return [];
  }
}

export async function loadFetches(store: IGraphStore): Promise<readonly FetchesRow[]> {
  try {
    const [fetchEdges, allNodes, routes] = await Promise.all([
      store.listEdgesByType("FETCHES"),
      store.listNodes(),
      store.listRoutes(),
    ]);
    const nodeById = new Map(allNodes.map((n) => [n.id, n]));
    const routeById = new Map(routes.map((r) => [r.id, r]));
    const rows: FetchesRow[] = [];
    for (const e of fetchEdges) {
      const from = nodeById.get(e.from);
      if (from === undefined) continue;
      const route = routeById.get(e.to);
      // FETCHES targets are typed as Route nodes carrying `url`; skip if the
      // edge points at something else (defence in depth — old graphs may
      // have leaked non-Route targets through the SQL JOIN).
      const toUrl = route?.url ?? "";
      rows.push({
        fromFilePath: from.filePath,
        fromName: from.name,
        toUrl,
      });
    }
    rows.sort((a, b) => {
      if (a.toUrl !== b.toUrl) return a.toUrl.localeCompare(b.toUrl);
      if (a.fromFilePath !== b.fromFilePath) return a.fromFilePath.localeCompare(b.fromFilePath);
      return a.fromName.localeCompare(b.fromName);
    });
    return rows;
  } catch {
    return [];
  }
}

export async function loadDependencies(store: IGraphStore): Promise<readonly DependencyRow[]> {
  try {
    const [deps, dependsOnEdges] = await Promise.all([
      store.listDependencies(),
      store.listEdgesByType("DEPENDS_ON"),
    ]);
    const usageByDepId = new Map<string, number>();
    for (const e of dependsOnEdges) {
      usageByDepId.set(e.to, (usageByDepId.get(e.to) ?? 0) + 1);
    }
    const rows: DependencyRow[] = deps.map((d) => ({
      id: d.id,
      name: d.name,
      version: d.version,
      ecosystem: d.ecosystem,
      license: d.license ?? "",
      lockfileSource: d.lockfileSource,
      usageCount: usageByDepId.get(d.id) ?? 0,
    }));
    rows.sort((a, b) => {
      if (a.name !== b.name) return a.name.localeCompare(b.name);
      if (a.version !== b.version) return a.version.localeCompare(b.version);
      return a.id.localeCompare(b.id);
    });
    return rows;
  } catch {
    return [];
  }
}

export async function loadDeadFunctions(store: IGraphStore): Promise<readonly DeadFunctionRow[]> {
  try {
    // `deadness` only ever decorates callable nodes — Function, Method,
    // Constructor (CallableShape in core-types/src/nodes.ts). Pull each
    // callable kind via the typed finder and filter on the JS side. Both
    // the typed enum spelling (`unreachable_export`) and the legacy
    // hyphenated form (`unreachable-export`, written by older dead-code
    // phases before the underscore normalization landed) are accepted.
    const [functions, methods, constructors] = await Promise.all([
      store.listNodesByKind("Function"),
      store.listNodesByKind("Method"),
      store.listNodesByKind("Constructor"),
    ]);
    const rows: DeadFunctionRow[] = [];
    for (const n of [...functions, ...methods, ...constructors]) {
      const d = n.deadness as string | undefined;
      if (d !== "dead" && d !== "unreachable_export" && d !== "unreachable-export") continue;
      rows.push({
        id: n.id,
        name: n.name,
        filePath: n.filePath,
        startLine: typeof n.startLine === "number" ? n.startLine : undefined,
        endLine: typeof n.endLine === "number" ? n.endLine : undefined,
        deadness: d,
      });
    }
    rows.sort((a, b) => {
      if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
      const al = a.startLine ?? 0;
      const bl = b.startLine ?? 0;
      if (al !== bl) return al - bl;
      return a.id.localeCompare(b.id);
    });
    return rows;
  } catch {
    return [];
  }
}

export async function loadOrphanFiles(store: IGraphStore): Promise<readonly OrphanFileRow[]> {
  try {
    const files = await store.listNodesByKind("File");
    const rows: OrphanFileRow[] = [];
    for (const f of files) {
      const grade = f.orphanGrade;
      if (grade === undefined || grade === "active") continue;
      rows.push({ id: f.id, filePath: f.filePath, orphanGrade: grade });
    }
    rows.sort((a, b) => {
      if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
      return a.id.localeCompare(b.id);
    });
    return rows;
  } catch {
    return [];
  }
}

/**
 * Build a URL-safe slug for a filename. Collapses non-alphanumeric runs into
 * single dashes, lower-cases, trims. A colliding slug is disambiguated by the
 * caller using a short hash suffix.
 */
export function slugify(raw: string): string {
  const lower = raw.toLowerCase();
  const replaced = lower.replace(/[^a-z0-9]+/g, "-");
  const trimmed = replaced.replace(/^-+|-+$/g, "");
  return trimmed.length > 0 ? trimmed : "untitled";
}

/**
 * Stable short hash for disambiguating slug collisions. Not cryptographic — we
 * just want two different ids to land in two different 6-char buckets.
 */
export function shortHash(input: string): string {
  // djb2
  let h = 5381;
  for (let i = 0; i < input.length; i += 1) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  // Unsigned 32-bit hex.
  const unsigned = h >>> 0;
  return unsigned.toString(16).padStart(8, "0").slice(0, 6);
}

export function escapePipe(raw: string): string {
  // Escape `\` first so a literal `\` in the cell text cannot combine
  // with the appended `\|` to produce `\\|` (which renders as `\` +
  // literal pipe and breaks the markdown table — js/incomplete-
  // sanitization).
  return raw.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

export function contributorDisplay(c: {
  readonly name: string;
  readonly emailPlain: string;
  readonly emailHash: string;
}): string {
  const name = c.name.length > 0 ? c.name : "unknown";
  const handle = c.emailPlain.length > 0 ? c.emailPlain : `sha256:${c.emailHash.slice(0, 10)}`;
  return `${name} <${handle}>`;
}
