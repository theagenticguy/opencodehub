// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures
/**
 * Shared MCP test fixtures.
 *
 * The production tools/resources call typed finders on `IGraphStore`
 * (`listNodes`, `listNodesByKind`, `listEdges`,
 * `listEdgesByType`, `listFindings`, `listRoutes`, `getRepoNode`,
 * `traverseAncestors`, `listEmbeddingHashes`, etc.) rather than raw
 * `query(<sql>)`. This file gives every mcp test a small, composable
 * in-memory backing store so each test only needs to seed the data it
 * cares about — nodes, edges, findings, routes — and supply
 * test-specific overrides as needed.
 *
 * The module is intentionally tolerant: every typed finder has a sane
 * default that filters the seeded arrays exactly the way the real
 * graph-backed adapter does. Tests can override a single finder via the
 * `overrides` parameter when they need bespoke behaviour (e.g. cochanges,
 * BM25 search, traversal).
 */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  CodeRelation,
  DependencyNode,
  FindingNode,
  GraphNode,
  KnowledgeGraph,
  NodeKind,
  RelationType,
  RepoNode,
  RouteNode,
} from "@opencodehub/core-types";
import type {
  AncestorTraversalOptions,
  BulkLoadStats,
  ConsumerProducerEdge,
  DescendantTraversalOptions,
  EmbeddingRow,
  IGraphStore,
  ITemporalStore,
  ListDependenciesOptions,
  ListEdgesByTypeOptions,
  ListEdgesOptions,
  ListFindingsOptions,
  ListNodesByKindOptions,
  ListNodesByNameOptions,
  ListNodesOptions,
  ListRoutesOptions,
  SearchQuery,
  SearchResult,
  Store,
  StoreMeta,
  TraverseQuery,
  TraverseResult,
  VectorQuery,
  VectorResult,
} from "@opencodehub/storage";
import { ConnectionPool } from "./connection-pool.js";

// ─────────────────────────────────────────────────────────────────────────────
// Store wrapper — composes the IGraphStore-shaped fake into the OpenStoreResult
// shape the connection pool returns.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wrap an in-memory IGraphStore-shaped fake as the composed `Store`
 * (`OpenStoreResult`) that the connection pool returns. The same fake
 * instance backs both `graph` and `temporal` views — which mirrors
 * production, where one `SqliteStore` serves both over a single
 * `store.sqlite` (ADR 0019).
 */
export function wrapAsStore(fake: unknown): Store {
  return {
    graph: fake as IGraphStore,
    temporal: fake as ITemporalStore,
    graphFile: "/in-memory/store.sqlite",
    temporalFile: "/in-memory/store.sqlite",
    close: async () => {
      const closer = (fake as { close?: () => Promise<void> }).close;
      if (typeof closer === "function") await closer.call(fake);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FakeData — the seed bag every test populates to whatever extent it needs.
// All arrays are optional. Typed finders default to filtering these arrays.
// ─────────────────────────────────────────────────────────────────────────────

export interface FakeNodeLike {
  readonly id: string;
  readonly kind: string;
  readonly name?: string;
  readonly filePath?: string;
  readonly file_path?: string;
  // Permissive — tests pass arbitrary extra fields (start_line, end_line,
  // content, response_keys, etc.).
  readonly [extra: string]: unknown;
}

export interface FakeEdgeLike {
  readonly type: string;
  readonly from?: string;
  readonly to?: string;
  readonly fromId?: string;
  readonly toId?: string;
  readonly from_id?: string;
  readonly to_id?: string;
  readonly confidence?: number;
  readonly step?: number | null;
  readonly reason?: string;
  readonly [extra: string]: unknown;
}

/**
 * Findings/routes/dependencies/repos are typed loosely on input — tests
 * pass plain records and the helper coerces to the typed `*Node` shape on
 * the way out of each finder. This sidesteps `NodeId`-branded ids while
 * keeping the keys discoverable.
 */
export type FakeFinding = {
  readonly id: string;
  readonly kind?: "Finding" | undefined;
  readonly name?: string | undefined;
  readonly filePath?: string | undefined;
  readonly scannerId?: string | undefined;
  readonly ruleId?: string | undefined;
  readonly severity?: "note" | "warning" | "error" | "none" | undefined;
  readonly message?: string | undefined;
  readonly propertiesBag?: Record<string, unknown> | undefined;
  readonly startLine?: number | undefined;
  readonly endLine?: number | undefined;
  readonly partialFingerprint?: string | undefined;
  readonly baselineState?: "new" | "unchanged" | "updated" | "absent" | undefined;
  readonly suppressedJson?: string | undefined;
};

export type FakeRoute = {
  readonly id: string;
  readonly kind?: "Route" | undefined;
  readonly name?: string | undefined;
  readonly filePath?: string | undefined;
  readonly url?: string | undefined;
  readonly method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | string | undefined;
  readonly responseKeys?: readonly string[] | undefined;
  readonly httpMethod?: string | undefined;
  readonly httpPath?: string | undefined;
  readonly path?: string | undefined;
};

export type FakeDependency = {
  readonly id: string;
  readonly kind?: "Dependency" | undefined;
  readonly name?: string | undefined;
  readonly filePath?: string | undefined;
  readonly ecosystem?: string | undefined;
  readonly version?: string | undefined;
  readonly license?: string | undefined;
  readonly licenseTier?:
    | "permissive"
    | "weak-copyleft"
    | "strong-copyleft"
    | "proprietary"
    | "unknown"
    | undefined;
};

export type FakeRepo = {
  readonly id: string;
  readonly kind?: "Repo" | undefined;
  readonly name?: string | undefined;
  readonly filePath?: string | undefined;
  readonly originUrl?: string | null | undefined;
  readonly defaultBranch?: string | null | undefined;
  readonly group?: string | null | undefined;
  readonly repoUri?: string | undefined;
};

export interface FakeData {
  readonly nodes?: readonly FakeNodeLike[];
  readonly edges?: readonly FakeEdgeLike[];
  readonly findings?: readonly FakeFinding[];
  readonly routes?: readonly FakeRoute[];
  readonly dependencies?: readonly FakeDependency[];
  readonly repoNodes?: readonly FakeRepo[];
  readonly embeddingHashes?: ReadonlyMap<string, string>;
}

/**
 * Per-finder override map. Any finder a test sets on this object replaces
 * the default seed-filter implementation. Useful when a test needs custom
 * BM25 results, cochange rows, or traversal output.
 */
export type StoreOverrides = Partial<{
  [K in keyof IGraphStore]: IGraphStore[K];
}> &
  Partial<{
    // ITemporalStore surfaces tests sometimes use directly via `store.temporal`.
    lookupCochangesForFile: ITemporalStore["lookupCochangesForFile"];
    lookupCochangesBetween: ITemporalStore["lookupCochangesBetween"];
    lookupSymbolSummary: ITemporalStore["lookupSymbolSummary"];
    lookupSymbolSummariesByNode: ITemporalStore["lookupSymbolSummariesByNode"];
    bulkLoadCochanges: ITemporalStore["bulkLoadCochanges"];
    bulkLoadSymbolSummaries: ITemporalStore["bulkLoadSymbolSummaries"];
    exec: ITemporalStore["exec"];
    // Optional escape hatch — reserved for a community graph adapter.
    execCypher: NonNullable<IGraphStore["execCypher"]>;
    // Legacy raw-SQL escape — only sql.test.ts calls this, but we keep
    // the override slot so the test can plug in a custom dispatcher.
    query: (
      sql: string,
      params?: readonly unknown[],
      opts?: { readonly timeoutMs?: number },
    ) => Promise<readonly Record<string, unknown>[]>;
  }>;

// ─────────────────────────────────────────────────────────────────────────────
// Node / edge field readers — be permissive about which casing the seed uses.
// ─────────────────────────────────────────────────────────────────────────────

function nodeFilePath(n: FakeNodeLike): string {
  if (typeof n.filePath === "string") return n.filePath;
  if (typeof n.file_path === "string") return n.file_path as string;
  return "";
}

function nodeName(n: FakeNodeLike): string {
  if (typeof n.name === "string") return n.name;
  return "";
}

function edgeFromId(e: FakeEdgeLike): string {
  return String(e.from ?? e.fromId ?? e.from_id ?? "");
}

function edgeToId(e: FakeEdgeLike): string {
  return String(e.to ?? e.toId ?? e.to_id ?? "");
}

/**
 * Project a fake node into the GraphNode shape the production code expects.
 * The fake seeds carry both casings (`filePath` / `file_path`,
 * `start_line` / `startLine`); production reads the camelCase fields, so
 * we map snake_case → camelCase here.
 */
function projectNode(n: FakeNodeLike): GraphNode {
  const out: Record<string, unknown> = { ...n };
  if (out["filePath"] === undefined && typeof n["file_path"] === "string") {
    out["filePath"] = n["file_path"];
  }
  if (out["startLine"] === undefined && n["start_line"] !== undefined) {
    out["startLine"] = n["start_line"];
  }
  if (out["endLine"] === undefined && n["end_line"] !== undefined) {
    out["endLine"] = n["end_line"];
  }
  if (out["isExported"] === undefined && n["is_exported"] !== undefined) {
    out["isExported"] = n["is_exported"];
  }
  if (out["responseKeys"] === undefined && n["response_keys"] !== undefined) {
    out["responseKeys"] = n["response_keys"];
  }
  if (out["httpMethod"] === undefined && n["http_method"] !== undefined) {
    out["httpMethod"] = n["http_method"];
  }
  if (out["httpPath"] === undefined && n["http_path"] !== undefined) {
    out["httpPath"] = n["http_path"];
  }
  if (out["entryPointId"] === undefined && n["entry_point_id"] !== undefined) {
    out["entryPointId"] = n["entry_point_id"];
  }
  if (out["repoUri"] === undefined && n["repo_uri"] !== undefined) {
    out["repoUri"] = n["repo_uri"];
  }
  if (out["inferredLabel"] === undefined && n["inferred_label"] !== undefined) {
    out["inferredLabel"] = n["inferred_label"];
  }
  if (out["parameterCount"] === undefined && n["parameter_count"] !== undefined) {
    out["parameterCount"] = n["parameter_count"];
  }
  if (out["returnType"] === undefined && n["return_type"] !== undefined) {
    out["returnType"] = n["return_type"];
  }
  if (out["stepCount"] === undefined && n["step_count"] !== undefined) {
    out["stepCount"] = n["step_count"];
  }
  if (out["symbolCount"] === undefined && n["symbol_count"] !== undefined) {
    out["symbolCount"] = n["symbol_count"];
  }
  if (out["emailHash"] === undefined && n["email_hash"] !== undefined) {
    out["emailHash"] = n["email_hash"];
  }
  if (out["emailPlain"] === undefined && n["email_plain"] !== undefined) {
    out["emailPlain"] = n["email_plain"];
  }
  if (out["operationId"] === undefined && n["operation_id"] !== undefined) {
    out["operationId"] = n["operation_id"];
  }
  return out as unknown as GraphNode;
}

function projectEdge(e: FakeEdgeLike): CodeRelation {
  const fromId = edgeFromId(e);
  const toId = edgeToId(e);
  return {
    id: typeof e["id"] === "string" ? e["id"] : `${fromId}->${e.type}->${toId}`,
    from: fromId,
    to: toId,
    type: e.type as RelationType,
    confidence: typeof e.confidence === "number" ? e.confidence : 1,
    ...(typeof e.reason === "string" ? { reason: e.reason } : {}),
    ...(typeof e.step === "number" ? { step: e.step } : {}),
  } as unknown as CodeRelation;
}

function applyLikeFilter(value: string, pattern: string): boolean {
  // Storage adapters wrap LIKE queries with `%x%`; here we just check
  // substring containment after stripping the wildcard markers.
  const trimmed = pattern.replace(/^%+|%+$/g, "");
  if (trimmed.length === 0) return true;
  return value.includes(trimmed);
}

// ─────────────────────────────────────────────────────────────────────────────
// makeFakeGraphStore — the typed-finder-shaped IGraphStore fake.
// ─────────────────────────────────────────────────────────────────────────────

export function makeFakeGraphStore(
  data: FakeData = {},
  overrides: StoreOverrides = {},
): IGraphStore {
  const nodes = data.nodes ?? [];
  const edges = data.edges ?? [];
  const findings = data.findings ?? [];
  const routes = data.routes ?? [];
  const dependencies = data.dependencies ?? [];
  const repoNodes = data.repoNodes ?? [];

  const filterNodes = (opts: ListNodesOptions = {}): readonly GraphNode[] => {
    if (opts.kinds !== undefined && opts.kinds.length === 0) return [];
    if (opts.ids !== undefined && opts.ids.length === 0) return [];
    const kindSet = opts.kinds !== undefined ? new Set<string>(opts.kinds) : undefined;
    const idSet = opts.ids !== undefined ? new Set(opts.ids) : undefined;
    let out = nodes.filter((n) => {
      if (kindSet !== undefined && !kindSet.has(n.kind)) return false;
      if (idSet !== undefined && !idSet.has(n.id)) return false;
      if (opts.filePath !== undefined && nodeFilePath(n) !== opts.filePath) return false;
      return true;
    });
    out = [...out].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (opts.offset !== undefined && Number.isFinite(opts.offset) && opts.offset > 0) {
      out = out.slice(Math.trunc(opts.offset));
    }
    if (opts.limit !== undefined && Number.isFinite(opts.limit) && opts.limit > 0) {
      out = out.slice(0, Math.trunc(opts.limit));
    }
    return out.map(projectNode);
  };

  const filterEdges = (opts: ListEdgesOptions = {}): readonly CodeRelation[] => {
    const types = opts.types !== undefined ? new Set<string>(opts.types) : undefined;
    const fromIds = opts.fromIds !== undefined ? new Set(opts.fromIds) : undefined;
    const toIds = opts.toIds !== undefined ? new Set(opts.toIds) : undefined;
    let out = edges.filter((e) => {
      if (types !== undefined && !types.has(e.type)) return false;
      if (fromIds !== undefined && !fromIds.has(edgeFromId(e))) return false;
      if (toIds !== undefined && !toIds.has(edgeToId(e))) return false;
      if (
        opts.minConfidence !== undefined &&
        Number.isFinite(opts.minConfidence) &&
        typeof e.confidence === "number" &&
        e.confidence < opts.minConfidence
      ) {
        return false;
      }
      return true;
    });
    out = [...out].sort((a, b) => {
      const af = edgeFromId(a);
      const bf = edgeFromId(b);
      if (af !== bf) return af < bf ? -1 : 1;
      const at = edgeToId(a);
      const bt = edgeToId(b);
      if (at !== bt) return at < bt ? -1 : 1;
      if (a.type !== b.type) return a.type < b.type ? -1 : 1;
      return 0;
    });
    if (opts.offset !== undefined && Number.isFinite(opts.offset) && opts.offset > 0) {
      out = out.slice(Math.trunc(opts.offset));
    }
    if (opts.limit !== undefined && Number.isFinite(opts.limit) && opts.limit > 0) {
      out = out.slice(0, Math.trunc(opts.limit));
    }
    return out.map(projectEdge);
  };

  const filterEdgesByType = (
    type: RelationType,
    opts: ListEdgesByTypeOptions = {},
  ): readonly CodeRelation[] => {
    const merged: ListEdgesOptions = { types: [type] };
    if (opts.fromIds !== undefined) {
      Object.assign(merged, { fromIds: opts.fromIds });
    }
    if (opts.toIds !== undefined) {
      Object.assign(merged, { toIds: opts.toIds });
    }
    if (opts.minConfidence !== undefined) {
      Object.assign(merged, { minConfidence: opts.minConfidence });
    }
    if (opts.limit !== undefined) {
      Object.assign(merged, { limit: opts.limit });
    }
    return filterEdges(merged);
  };

  const filterFindings = (opts: ListFindingsOptions = {}): readonly FindingNode[] => {
    const sevSet = opts.severity !== undefined ? new Set(opts.severity) : undefined;
    const baselineSet = opts.baselineState !== undefined ? new Set(opts.baselineState) : undefined;
    let out = findings.filter((f) => {
      if (sevSet !== undefined && !sevSet.has(f.severity as "note" | "warning" | "error"))
        return false;
      if (opts.ruleId !== undefined && f.ruleId !== opts.ruleId) return false;
      if (baselineSet !== undefined) {
        const b = f.baselineState;
        if (b === undefined || !baselineSet.has(b)) return false;
      }
      if (opts.suppressed !== undefined) {
        const isSuppressed = typeof f.suppressedJson === "string" && f.suppressedJson.length > 0;
        if (opts.suppressed !== isSuppressed) return false;
      }
      return true;
    });
    if (opts.limit !== undefined && Number.isFinite(opts.limit) && opts.limit > 0) {
      out = out.slice(0, Math.trunc(opts.limit));
    }
    return out.map((f) => f as unknown as FindingNode);
  };

  const filterRoutes = (opts: ListRoutesOptions = {}): readonly RouteNode[] => {
    const methodSet = opts.methods !== undefined ? new Set(opts.methods) : undefined;
    let out = routes.filter((r) => {
      if (methodSet !== undefined) {
        const m = (r as { httpMethod?: string }).httpMethod ?? (r as { method?: string }).method;
        if (m === undefined || !methodSet.has(m as "GET" | "POST" | "PUT" | "DELETE" | "PATCH"))
          return false;
      }
      if (opts.pathLike !== undefined) {
        const url =
          (r as { url?: string }).url ??
          (r as { httpPath?: string }).httpPath ??
          (r as { path?: string }).path ??
          "";
        if (!applyLikeFilter(url, opts.pathLike)) return false;
      }
      return true;
    });
    if (opts.limit !== undefined && Number.isFinite(opts.limit) && opts.limit > 0) {
      out = out.slice(0, Math.trunc(opts.limit));
    }
    return out.map((r) => r as unknown as RouteNode);
  };

  const filterDependencies = (opts: ListDependenciesOptions = {}): readonly DependencyNode[] => {
    const ecoMatch = opts.ecosystem;
    const tierSet = opts.licenseTier !== undefined ? new Set(opts.licenseTier) : undefined;
    let out = dependencies.filter((d) => {
      if (ecoMatch !== undefined && (d as { ecosystem?: string }).ecosystem !== ecoMatch)
        return false;
      if (tierSet !== undefined) {
        const tier = (d as { licenseTier?: string }).licenseTier;
        if (tier === undefined || !tierSet.has(tier as never)) return false;
      }
      return true;
    });
    if (opts.limit !== undefined && Number.isFinite(opts.limit) && opts.limit > 0) {
      out = out.slice(0, Math.trunc(opts.limit));
    }
    return out.map((d) => d as unknown as DependencyNode);
  };

  const defaults: Record<string, unknown> = {
    dialect: "none",
    open: async () => {},
    close: async () => {},
    createSchema: async () => {},
    bulkLoad: async (_g: KnowledgeGraph): Promise<BulkLoadStats> => ({
      nodeCount: 0,
      edgeCount: 0,
      durationMs: 0,
    }),
    upsertEmbeddings: async (_r: readonly EmbeddingRow[]): Promise<void> => {},
    listEmbeddingHashes: async (): Promise<Map<string, string>> =>
      new Map(data.embeddingHashes ?? []),
    listEmbeddings: async function* (): AsyncIterable<EmbeddingRow> {
      // No-op default. Tests that need this must override.
    },

    listNodes: async (opts: ListNodesOptions = {}) => filterNodes(opts),
    listNodesByKind: async <K extends NodeKind>(
      kind: K,
      opts: ListNodesByKindOptions = {},
    ): Promise<readonly GraphNode[]> => {
      let out = nodes.filter((n) => n.kind === kind);
      if (opts.filePath !== undefined) {
        out = out.filter((n) => nodeFilePath(n) === opts.filePath);
      }
      if (opts.filePathLike !== undefined) {
        out = out.filter((n) => applyLikeFilter(nodeFilePath(n), opts.filePathLike ?? ""));
      }
      out = [...out].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (opts.offset !== undefined && Number.isFinite(opts.offset) && opts.offset > 0) {
        out = out.slice(Math.trunc(opts.offset));
      }
      if (opts.limit !== undefined && Number.isFinite(opts.limit) && opts.limit > 0) {
        out = out.slice(0, Math.trunc(opts.limit));
      }
      return out.map(projectNode);
    },
    listEdges: async (opts: ListEdgesOptions = {}) => filterEdges(opts),
    listEdgesByType: async (type: RelationType, opts: ListEdgesByTypeOptions = {}) =>
      filterEdgesByType(type, opts),
    listFindings: async (opts: ListFindingsOptions = {}) => filterFindings(opts),
    listDependencies: async (opts: ListDependenciesOptions = {}) => filterDependencies(opts),
    listRoutes: async (opts: ListRoutesOptions = {}) => filterRoutes(opts),
    getRepoNode: async (id: string): Promise<RepoNode | undefined> => {
      const hit = repoNodes.find((r) => (r as { id?: string }).id === id);
      return hit ? (hit as unknown as RepoNode) : undefined;
    },
    listNodesByEntryPoint: async (entryPointId: string): Promise<readonly GraphNode[]> => {
      const hits = nodes.filter(
        (n) =>
          (n as { entryPointId?: string }).entryPointId === entryPointId ||
          (n as { entry_point_id?: string }).entry_point_id === entryPointId,
      );
      return [...hits].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(projectNode);
    },
    listNodesByName: async (
      name: string,
      opts: ListNodesByNameOptions = {},
    ): Promise<readonly GraphNode[]> => {
      const kindSet = opts.kinds !== undefined ? new Set<string>(opts.kinds) : undefined;
      let out = nodes.filter((n) => {
        if (nodeName(n) !== name) return false;
        if (kindSet !== undefined && !kindSet.has(n.kind)) return false;
        if (opts.filePath !== undefined && nodeFilePath(n) !== opts.filePath) return false;
        return true;
      });
      out = [...out].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (opts.limit !== undefined && Number.isFinite(opts.limit) && opts.limit > 0) {
        out = out.slice(0, Math.trunc(opts.limit));
      }
      return out.map(projectNode);
    },
    countNodesByKind: async (kinds?: readonly NodeKind[]): Promise<Map<NodeKind, number>> => {
      const out = new Map<NodeKind, number>();
      const allow = kinds !== undefined ? new Set<string>(kinds) : undefined;
      for (const n of nodes) {
        if (allow !== undefined && !allow.has(n.kind)) continue;
        const k = n.kind as NodeKind;
        out.set(k, (out.get(k) ?? 0) + 1);
      }
      return out;
    },
    countEdgesByType: async (
      types?: readonly RelationType[],
    ): Promise<Map<RelationType, number>> => {
      const out = new Map<RelationType, number>();
      const allow = types !== undefined ? new Set<string>(types) : undefined;
      for (const e of edges) {
        if (allow !== undefined && !allow.has(e.type)) continue;
        const t = e.type as RelationType;
        out.set(t, (out.get(t) ?? 0) + 1);
      }
      return out;
    },
    search: async (_q: SearchQuery): Promise<readonly SearchResult[]> => [],
    vectorSearch: async (_q: VectorQuery): Promise<readonly VectorResult[]> => [],
    traverse: async (_q: TraverseQuery): Promise<readonly TraverseResult[]> => [],
    traverseAncestors: async (
      _opts: AncestorTraversalOptions,
    ): Promise<readonly TraverseResult[]> => [],
    traverseDescendants: async (
      _opts: DescendantTraversalOptions,
    ): Promise<readonly TraverseResult[]> => [],
    listConsumerProducerEdges: async (): Promise<readonly ConsumerProducerEdge[]> => [],
    getMeta: async (): Promise<StoreMeta | undefined> => undefined,
    setMeta: async (_m: StoreMeta): Promise<void> => {},
    healthCheck: async () => ({ ok: true }),

    // ITemporalStore surfaces commonly stubbed.
    bulkLoadCochanges: async (_rows: readonly unknown[]): Promise<void> => {},
    lookupCochangesForFile: async () => [],
    lookupCochangesBetween: async () => undefined,
    bulkLoadSymbolSummaries: async (_rows: readonly unknown[]): Promise<void> => {},
    lookupSymbolSummary: async () => undefined,
    lookupSymbolSummariesByNode: async () => [],
    exec: async () => [],
  };

  // Apply test-supplied overrides verbatim — they win over defaults.
  const overrideEntries = Object.entries(overrides).filter(([, v]) => v !== undefined);
  for (const [key, value] of overrideEntries) {
    defaults[key] = value;
  }

  return defaults as unknown as IGraphStore;
}

// ─────────────────────────────────────────────────────────────────────────────
// Harness — registry + ConnectionPool + McpServer scaffolding.
// ─────────────────────────────────────────────────────────────────────────────

export interface FakeRegistryEntry {
  readonly name: string;
  readonly path?: string;
  readonly indexedAt?: string;
  readonly nodeCount?: number;
  readonly edgeCount?: number;
  readonly lastCommit?: string;
}

export interface McpHarness {
  readonly home: string;
  readonly pool: ConnectionPool;
  readonly server: McpServer;
  readonly repoPath: string;
  readonly repoName: string;
}

export interface MakeHarnessOptions {
  readonly repoName?: string;
  readonly registry?: Readonly<Record<string, FakeRegistryEntry>>;
  readonly storeFactory: () => IGraphStore | Promise<IGraphStore>;
  readonly serverCapabilities?: { tools?: object; resources?: object };
  readonly tmpPrefix?: string;
}

/**
 * Spin up a temp `home/.codehub/registry.json`, a `ConnectionPool` whose
 * factory returns the supplied fake store, and a fresh `McpServer`. Hands
 * everything back to the caller's `fn` and tears down on exit.
 */
export async function withMcpHarness(
  opts: MakeHarnessOptions,
  fn: (h: McpHarness) => Promise<void>,
): Promise<void> {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const home = await mkdtemp(resolve(tmpdir(), opts.tmpPrefix ?? "codehub-mcp-test-"));
  try {
    const repoName = opts.repoName ?? "fakerepo";
    const repoPath = resolve(home, repoName);
    await mkdir(repoPath, { recursive: true });
    const regDir = resolve(home, ".codehub");
    await mkdir(regDir, { recursive: true });
    const defaultRegistry: Record<string, FakeRegistryEntry> = {
      [repoName]: {
        name: repoName,
        path: repoPath,
        indexedAt: "2026-04-18T00:00:00Z",
        nodeCount: 0,
        edgeCount: 0,
        lastCommit: "abc123",
      },
    };
    const registry = opts.registry ?? defaultRegistry;
    await writeFile(resolve(regDir, "registry.json"), JSON.stringify(registry));
    const pool = new ConnectionPool({ max: 4, ttlMs: 60_000 }, async () =>
      wrapAsStore(await opts.storeFactory()),
    );
    const server = new McpServer(
      { name: "test", version: "0.0.0" },
      { capabilities: opts.serverCapabilities ?? { tools: {} } },
    );
    try {
      await fn({ home, pool, server, repoPath, repoName });
    } finally {
      await pool.shutdown();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler accessors — the SDK's _registeredTools / _registeredResourceTemplates
// fields aren't exported, so every test pokes at them. Centralize the cast.
// ─────────────────────────────────────────────────────────────────────────────

export type ToolHandler = (args: unknown, extra: unknown) => Promise<CallToolResult>;

export function getToolHandler(server: McpServer, name: string): ToolHandler {
  // biome-ignore lint/suspicious/noExplicitAny: SDK internal field for test-only access
  const map = (server as any)._registeredTools as Record<string, { handler: ToolHandler }>;
  const entry = map[name];
  assert.ok(entry, `tool not registered: ${name}`);
  return entry.handler.bind(entry);
}

export type ResourceReadHandler = (
  uri: URL,
  vars: Record<string, string | string[]>,
  extra: unknown,
) => Promise<ReadResourceResult>;

export function getResourceHandler(server: McpServer, name: string): ResourceReadHandler {
  // biome-ignore lint/suspicious/noExplicitAny: SDK internal field for test-only access
  const map = (server as any)._registeredResourceTemplates as Record<
    string,
    { readCallback: ResourceReadHandler }
  >;
  const entry = map[name];
  assert.ok(entry, `resource template not registered: ${name}`);
  return entry.readCallback.bind(entry);
}
