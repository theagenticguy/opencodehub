/**
 * Wiki generation tests — confirm the deterministic-output + success-criteria
 * contract without spinning up DuckDB.
 *
 * `WikiFakeStore` implements `IGraphStore` finder methods directly
 * over in-memory `nodes` + `edges` arrays. Every helper in
 * `wiki/wiki-render/shared.ts` reaches the same fixture data via
 * typed finders.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type {
  CodeRelation,
  DependencyNode,
  FindingNode,
  GraphNode,
  NodeKind,
  NodeOfKind,
  RelationType,
  RepoNode,
  RouteNode,
} from "@opencodehub/core-types";
import type {
  BulkLoadStats,
  ConsumerProducerEdge,
  EmbeddingRow,
  GraphDialect,
  IGraphStore,
  ListEdgesByTypeOptions,
  ListNodesByKindOptions,
  ListNodesOptions,
  SearchQuery,
  SearchResult,
  StoreMeta,
  TraverseQuery,
  TraverseResult,
  VectorQuery,
  VectorResult,
} from "@opencodehub/storage";
import { generateWiki } from "./index.js";

interface WikiNode {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly filePath: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly inferredLabel?: string;
  readonly symbolCount?: number;
  readonly cohesion?: number;
  readonly truckFactor?: number;
  readonly url?: string;
  readonly method?: string;
  readonly summary?: string;
  readonly version?: string;
  readonly ecosystem?: string;
  readonly license?: string;
  readonly lockfileSource?: string;
  readonly httpMethod?: string;
  readonly httpPath?: string;
  readonly deadness?: string;
  readonly orphanGrade?: string;
  readonly topContributorLastSeenDays?: number;
  readonly emailHash?: string;
  readonly emailPlain?: string;
  /**
   * Test fixtures historically wrote ProjectProfile arrays as JSON strings.
   * The fake parses these into `string[]` on read so the typed
   * `ProjectProfileNode` shape lines up without churning every fixture.
   */
  readonly languagesJson?: string;
  readonly frameworksJson?: string;
  readonly apiContractsJson?: string;
  readonly iacTypesJson?: string;
}

interface WikiEdge {
  readonly fromId: string;
  readonly toId: string;
  readonly type: string;
  readonly confidence: number;
}

function parseJsonArray(raw: string | undefined): readonly string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

/**
 * Project the in-memory `WikiNode` row onto the typed `GraphNode` union the
 * production code expects. Each kind gets the minimal field set the helper
 * functions read; absent fields collapse to `undefined`.
 */
function projectNode(n: WikiNode): GraphNode {
  const base = { id: n.id as GraphNode["id"], name: n.name, filePath: n.filePath } as const;
  const located = {
    ...(n.startLine !== undefined ? { startLine: n.startLine } : {}),
    ...(n.endLine !== undefined ? { endLine: n.endLine } : {}),
  };
  switch (n.kind) {
    case "Community":
      return {
        ...base,
        kind: "Community",
        ...(n.inferredLabel !== undefined ? { inferredLabel: n.inferredLabel } : {}),
        ...(n.symbolCount !== undefined ? { symbolCount: n.symbolCount } : {}),
        ...(n.cohesion !== undefined ? { cohesion: n.cohesion } : {}),
        ...(n.truckFactor !== undefined ? { truckFactor: n.truckFactor } : {}),
      };
    case "ProjectProfile":
      return {
        ...base,
        kind: "ProjectProfile",
        languages: parseJsonArray(n.languagesJson),
        frameworks: parseJsonArray(n.frameworksJson),
        apiContracts: parseJsonArray(n.apiContractsJson),
        iacTypes: parseJsonArray(n.iacTypesJson),
        manifests: [],
        srcDirs: [],
      };
    case "File":
      return {
        ...base,
        kind: "File",
        ...(n.orphanGrade !== undefined
          ? { orphanGrade: n.orphanGrade as "active" | "orphaned" | "abandoned" | "fossilized" }
          : {}),
        ...(n.topContributorLastSeenDays !== undefined
          ? { topContributorLastSeenDays: n.topContributorLastSeenDays }
          : {}),
      };
    case "Route":
      return {
        ...base,
        kind: "Route",
        url: n.url ?? "",
        ...(n.method !== undefined ? { method: n.method } : {}),
      };
    case "Operation":
      return {
        ...base,
        kind: "Operation",
        method: (n.httpMethod ?? "GET") as RouteNode["method"] extends infer _ ? "GET" : never,
        path: n.httpPath ?? "",
        ...(n.summary !== undefined ? { summary: n.summary } : {}),
      } as GraphNode;
    case "Dependency":
      return {
        ...base,
        kind: "Dependency",
        version: n.version ?? "",
        ecosystem: (n.ecosystem ?? "npm") as DependencyNode["ecosystem"],
        lockfileSource: n.lockfileSource ?? "",
        ...(n.license !== undefined ? { license: n.license } : {}),
      };
    case "Contributor":
      return {
        ...base,
        kind: "Contributor",
        emailHash: n.emailHash ?? "",
        ...(n.emailPlain !== undefined ? { emailPlain: n.emailPlain } : {}),
      };
    case "Function":
      return {
        ...base,
        kind: "Function",
        ...located,
        ...(n.deadness !== undefined ? { deadness: n.deadness as "dead" } : {}),
      };
    case "Method":
      return {
        ...base,
        kind: "Method",
        ...located,
        owner: "",
        ...(n.deadness !== undefined ? { deadness: n.deadness as "dead" } : {}),
      } as GraphNode;
    case "Class":
      return {
        ...base,
        kind: "Class",
        ...located,
      };
    default:
      // Fall back to the raw shape; the production code paths for unknown
      // kinds never read past `id`/`name`/`filePath`.
      return { ...base, kind: n.kind as NodeKind } as GraphNode;
  }
}

function projectEdge(e: WikiEdge): CodeRelation {
  return {
    id: `${e.type}:${e.fromId}->${e.toId}` as CodeRelation["id"],
    from: e.fromId as CodeRelation["from"],
    to: e.toId as CodeRelation["to"],
    type: e.type as RelationType,
    confidence: e.confidence,
  };
}

class WikiFakeStore implements IGraphStore {
  readonly dialect: GraphDialect = "cypher";
  readonly nodes: WikiNode[] = [];
  readonly edges: WikiEdge[] = [];

  addNode(n: WikiNode): void {
    this.nodes.push(n);
  }
  addEdge(e: WikiEdge): void {
    this.edges.push(e);
  }

  async open(): Promise<void> {}
  async close(): Promise<void> {}
  async createSchema(): Promise<void> {}
  async bulkLoad(): Promise<BulkLoadStats> {
    return { nodeCount: 0, edgeCount: 0, durationMs: 0 };
  }
  async upsertEmbeddings(_rows: readonly EmbeddingRow[]): Promise<void> {}
  async listEmbeddingHashes(): Promise<Map<string, string>> {
    return new Map();
  }
  async *listEmbeddings(): AsyncIterable<EmbeddingRow> {}

  async listNodesByEntryPoint(_entryPointId: string): Promise<readonly GraphNode[]> {
    return [];
  }
  async listNodesByName(_name: string): Promise<readonly GraphNode[]> {
    return [];
  }

  async listNodes(opts: ListNodesOptions = {}): Promise<readonly GraphNode[]> {
    const kinds = opts.kinds;
    if (kinds !== undefined && kinds.length === 0) return [];
    const filtered =
      kinds && kinds.length > 0
        ? this.nodes.filter((n) => kinds.includes(n.kind))
        : [...this.nodes];
    const sorted = filtered.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const offset = typeof opts.offset === "number" && opts.offset > 0 ? Math.floor(opts.offset) : 0;
    const limit =
      typeof opts.limit === "number" && opts.limit >= 0 ? Math.floor(opts.limit) : undefined;
    const sliced =
      limit === undefined ? sorted.slice(offset) : sorted.slice(offset, offset + limit);
    return sliced.map(projectNode);
  }

  async listNodesByKind<K extends NodeKind>(
    kind: K,
    opts: ListNodesByKindOptions = {},
  ): Promise<readonly NodeOfKind<K>[]> {
    let filtered = this.nodes.filter((n) => n.kind === kind);
    if (typeof opts.filePath === "string") {
      filtered = filtered.filter((n) => n.filePath === opts.filePath);
    }
    if (typeof opts.filePathLike === "string") {
      const needle = opts.filePathLike;
      filtered = filtered.filter((n) => n.filePath.includes(needle));
    }
    filtered.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const offset = typeof opts.offset === "number" && opts.offset > 0 ? Math.floor(opts.offset) : 0;
    const limit =
      typeof opts.limit === "number" && opts.limit >= 0 ? Math.floor(opts.limit) : undefined;
    const sliced =
      limit === undefined ? filtered.slice(offset) : filtered.slice(offset, offset + limit);
    return sliced.map(projectNode) as unknown as readonly NodeOfKind<K>[];
  }

  async listEdges(): Promise<readonly CodeRelation[]> {
    const sorted = [...this.edges].sort((a, b) => {
      if (a.fromId !== b.fromId) return a.fromId.localeCompare(b.fromId);
      if (a.toId !== b.toId) return a.toId.localeCompare(b.toId);
      return a.type.localeCompare(b.type);
    });
    return sorted.map(projectEdge);
  }

  async listEdgesByType(
    type: RelationType,
    opts: ListEdgesByTypeOptions = {},
  ): Promise<readonly CodeRelation[]> {
    let filtered = this.edges.filter((e) => e.type === type);
    if (opts.fromIds !== undefined) {
      const ids = new Set(opts.fromIds);
      filtered = filtered.filter((e) => ids.has(e.fromId));
    }
    if (opts.toIds !== undefined) {
      const ids = new Set(opts.toIds);
      filtered = filtered.filter((e) => ids.has(e.toId));
    }
    if (typeof opts.minConfidence === "number") {
      const floor = opts.minConfidence;
      filtered = filtered.filter((e) => e.confidence >= floor);
    }
    filtered.sort((a, b) => {
      if (a.fromId !== b.fromId) return a.fromId.localeCompare(b.fromId);
      if (a.toId !== b.toId) return a.toId.localeCompare(b.toId);
      return a.type.localeCompare(b.type);
    });
    if (typeof opts.limit === "number" && opts.limit >= 0) {
      filtered = filtered.slice(0, Math.floor(opts.limit));
    }
    return filtered.map(projectEdge);
  }

  async listFindings(): Promise<readonly FindingNode[]> {
    return [];
  }
  async listDependencies(): Promise<readonly DependencyNode[]> {
    const deps = this.nodes.filter((n) => n.kind === "Dependency");
    deps.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return deps.map((n) => projectNode(n) as DependencyNode);
  }
  async listRoutes(): Promise<readonly RouteNode[]> {
    const routes = this.nodes.filter((n) => n.kind === "Route");
    routes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return routes.map((n) => projectNode(n) as RouteNode);
  }
  async getRepoNode(): Promise<RepoNode | undefined> {
    return undefined;
  }
  async countNodesByKind(): Promise<Map<NodeKind, number>> {
    const out = new Map<NodeKind, number>();
    for (const n of this.nodes) {
      out.set(n.kind as NodeKind, (out.get(n.kind as NodeKind) ?? 0) + 1);
    }
    return out;
  }
  async countEdgesByType(): Promise<Map<RelationType, number>> {
    const out = new Map<RelationType, number>();
    for (const e of this.edges) {
      out.set(e.type as RelationType, (out.get(e.type as RelationType) ?? 0) + 1);
    }
    return out;
  }
  async search(_q: SearchQuery): Promise<readonly SearchResult[]> {
    return [];
  }
  async vectorSearch(_q: VectorQuery): Promise<readonly VectorResult[]> {
    return [];
  }
  async traverse(_q: TraverseQuery): Promise<readonly TraverseResult[]> {
    return [];
  }
  async traverseAncestors(): Promise<readonly TraverseResult[]> {
    return [];
  }
  async traverseDescendants(): Promise<readonly TraverseResult[]> {
    return [];
  }
  async listConsumerProducerEdges(): Promise<readonly ConsumerProducerEdge[]> {
    return [];
  }
  async getMeta(): Promise<StoreMeta | undefined> {
    return undefined;
  }
  async setMeta(_meta: StoreMeta): Promise<void> {}
  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    return { ok: true };
  }
}

function seededStore(): WikiFakeStore {
  const store = new WikiFakeStore();

  store.addNode({
    id: "ProjectProfile:repo:repo",
    kind: "ProjectProfile",
    name: "repo",
    filePath: ".",
    languagesJson: JSON.stringify(["typescript", "python"]),
    frameworksJson: JSON.stringify(["express", "fastapi"]),
    apiContractsJson: JSON.stringify(["openapi"]),
    iacTypesJson: JSON.stringify([]),
  });

  // Two communities.
  store.addNode({
    id: "Community:repo:auth",
    kind: "Community",
    name: "auth",
    filePath: ".",
    inferredLabel: "Auth Subsystem",
    symbolCount: 12,
    cohesion: 0.72,
    truckFactor: 2,
  });
  store.addNode({
    id: "Community:repo:billing",
    kind: "Community",
    name: "billing",
    filePath: ".",
    inferredLabel: "Billing Subsystem",
    symbolCount: 8,
    cohesion: 0.55,
    truckFactor: 1,
  });

  // Two File members per community + cross-member symbols.
  const files = [
    {
      id: "File:src/auth/login.ts:src/auth/login.ts",
      path: "src/auth/login.ts",
      community: "Community:repo:auth",
      lastSeen: 12,
    },
    {
      id: "File:src/auth/session.ts:src/auth/session.ts",
      path: "src/auth/session.ts",
      community: "Community:repo:auth",
      lastSeen: 30,
    },
    {
      id: "File:src/billing/invoice.ts:src/billing/invoice.ts",
      path: "src/billing/invoice.ts",
      community: "Community:repo:billing",
      lastSeen: 90,
    },
    {
      id: "File:src/billing/charge.ts:src/billing/charge.ts",
      path: "src/billing/charge.ts",
      community: "Community:repo:billing",
      lastSeen: 5,
    },
  ];
  for (const f of files) {
    store.addNode({
      id: f.id,
      kind: "File",
      name: path.basename(f.path),
      filePath: f.path,
      topContributorLastSeenDays: f.lastSeen,
      orphanGrade: f.lastSeen > 60 ? "orphaned" : "active",
    });
    store.addEdge({ fromId: f.id, toId: f.community, type: "MEMBER_OF", confidence: 1 });
  }

  // Contributors + OWNED_BY edges.
  const contributors = [
    { id: "Contributor:repo:alice", name: "Alice", hash: "aaaaaa", plain: "alice@example.com" },
    { id: "Contributor:repo:bob", name: "Bob", hash: "bbbbbb", plain: "bob@example.com" },
    { id: "Contributor:repo:carol", name: "Carol", hash: "cccccc", plain: "" },
  ];
  for (const c of contributors) {
    store.addNode({
      id: c.id,
      kind: "Contributor",
      name: c.name,
      filePath: ".",
      emailHash: c.hash,
      emailPlain: c.plain,
    });
  }
  // Alice owns most of auth; Bob billing; Carol has a small share everywhere.
  store.addEdge({
    fromId: "File:src/auth/login.ts:src/auth/login.ts",
    toId: "Contributor:repo:alice",
    type: "OWNED_BY",
    confidence: 0.7,
  });
  store.addEdge({
    fromId: "File:src/auth/login.ts:src/auth/login.ts",
    toId: "Contributor:repo:carol",
    type: "OWNED_BY",
    confidence: 0.1,
  });
  store.addEdge({
    fromId: "File:src/auth/session.ts:src/auth/session.ts",
    toId: "Contributor:repo:alice",
    type: "OWNED_BY",
    confidence: 0.6,
  });
  store.addEdge({
    fromId: "File:src/billing/invoice.ts:src/billing/invoice.ts",
    toId: "Contributor:repo:bob",
    type: "OWNED_BY",
    confidence: 0.8,
  });
  store.addEdge({
    fromId: "File:src/billing/charge.ts:src/billing/charge.ts",
    toId: "Contributor:repo:bob",
    type: "OWNED_BY",
    confidence: 0.55,
  });
  store.addEdge({
    fromId: "File:src/billing/charge.ts:src/billing/charge.ts",
    toId: "Contributor:repo:carol",
    type: "OWNED_BY",
    confidence: 0.05,
  });

  // Routes + OpenAPI operations + FETCHES.
  store.addNode({
    id: "Route:repo:login",
    kind: "Route",
    name: "login",
    filePath: "src/auth/login.ts",
    url: "/login",
    method: "POST",
  });
  store.addNode({
    id: "Route:repo:invoice",
    kind: "Route",
    name: "invoice",
    filePath: "src/billing/invoice.ts",
    url: "/invoice/:id",
    method: "GET",
  });
  store.addNode({
    id: "Function:src/auth/login.ts:loginHandler#0",
    kind: "Function",
    name: "loginHandler",
    filePath: "src/auth/login.ts",
    startLine: 10,
    endLine: 40,
  });
  store.addEdge({
    fromId: "Function:src/auth/login.ts:loginHandler#0",
    toId: "Route:repo:login",
    type: "HANDLES_ROUTE",
    confidence: 1,
  });
  store.addNode({
    id: "Operation:repo:getInvoice",
    kind: "Operation",
    name: "getInvoice",
    filePath: "api/openapi.yaml",
    httpPath: "/invoice/:id",
    httpMethod: "GET",
    summary: "Fetch an invoice by id.",
  });
  store.addEdge({
    fromId: "Function:src/auth/login.ts:loginHandler#0",
    toId: "Route:repo:invoice",
    type: "FETCHES",
    confidence: 1,
  });

  // Dependencies.
  store.addNode({
    id: "Dependency:repo:express",
    kind: "Dependency",
    name: "express",
    filePath: "package.json",
    version: "4.19.0",
    ecosystem: "npm",
    license: "MIT",
    lockfileSource: "pnpm-lock.yaml",
  });
  store.addNode({
    id: "Dependency:repo:lodash",
    kind: "Dependency",
    name: "lodash",
    filePath: "package.json",
    version: "4.17.21",
    ecosystem: "npm",
    license: "MIT",
    lockfileSource: "pnpm-lock.yaml",
  });
  store.addEdge({
    fromId: "File:src/auth/login.ts:src/auth/login.ts",
    toId: "Dependency:repo:express",
    type: "DEPENDS_ON",
    confidence: 1,
  });
  store.addEdge({
    fromId: "File:src/billing/invoice.ts:src/billing/invoice.ts",
    toId: "Dependency:repo:express",
    type: "DEPENDS_ON",
    confidence: 1,
  });
  store.addEdge({
    fromId: "File:src/auth/session.ts:src/auth/session.ts",
    toId: "Dependency:repo:lodash",
    type: "DEPENDS_ON",
    confidence: 1,
  });

  // Dead code + orphan file.
  store.addNode({
    id: "Function:src/auth/session.ts:unusedHelper#0",
    kind: "Function",
    name: "unusedHelper",
    filePath: "src/auth/session.ts",
    startLine: 55,
    endLine: 60,
    deadness: "dead",
  });

  return store;
}

async function hashDir(root: string): Promise<string> {
  const hash = createHash("md5");
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        const rel = path.relative(root, full);
        hash.update(rel);
        hash.update("\0");
        const contents = await readFile(full, "utf8");
        hash.update(contents);
        hash.update("\0");
      }
    }
  }
  await walk(root);
  return hash.digest("hex");
}

test("generateWiki: renders all 5 page families on a populated graph", async () => {
  const store = seededStore();
  const dir = await mkdtemp(path.join(tmpdir(), "codehub-wiki-"));
  try {
    const result = await generateWiki(store, { outputDir: dir });
    assert.ok(
      result.filesWritten.length >= 5,
      `expected >=5 files, got ${result.filesWritten.length}`,
    );
    assert.ok(result.totalBytes > 0, "totalBytes should be non-zero");

    const rels = result.filesWritten.map((f) => path.relative(dir, f)).sort();
    // Stable anchor files we rely on.
    assert.ok(rels.includes("index.md"), "root index.md missing");
    assert.ok(rels.includes("architecture/index.md"), "architecture/index.md missing");
    assert.ok(rels.includes("api-surface/index.md"), "api-surface/index.md missing");
    assert.ok(rels.includes("dependency-map/index.md"), "dependency-map/index.md missing");
    assert.ok(rels.includes("ownership-map/index.md"), "ownership-map/index.md missing");
    assert.ok(rels.includes("risk-atlas/index.md"), "risk-atlas/index.md missing");

    const deps = await readFile(path.join(dir, "dependency-map/index.md"), "utf8");
    assert.ok(deps.includes("express"), "dependency-map should list express");
    assert.ok(deps.includes("lodash"), "dependency-map should list lodash");

    const archAuth = await readFile(path.join(dir, "architecture/auth-subsystem.md"), "utf8");
    assert.ok(archAuth.includes("Auth Subsystem"));
    assert.ok(archAuth.includes("src/auth/login.ts"));

    const risk = await readFile(path.join(dir, "risk-atlas/index.md"), "utf8");
    assert.ok(risk.includes("unusedHelper"), "risk-atlas should list dead code");
    assert.ok(risk.includes("src/billing/invoice.ts"), "risk-atlas should list orphan file");

    const apis = await readFile(path.join(dir, "api-surface/index.md"), "utf8");
    assert.ok(apis.includes("express"));
    assert.ok(apis.includes("fastapi"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("generateWiki: two runs produce byte-identical output (determinism)", async () => {
  const storeA = seededStore();
  const storeB = seededStore();
  const dirA = await mkdtemp(path.join(tmpdir(), "codehub-wiki-a-"));
  const dirB = await mkdtemp(path.join(tmpdir(), "codehub-wiki-b-"));
  try {
    await generateWiki(storeA, { outputDir: dirA });
    await generateWiki(storeB, { outputDir: dirB });
    const hashA = await hashDir(dirA);
    const hashB = await hashDir(dirB);
    assert.equal(hashA, hashB, "two runs should produce byte-identical output");
  } finally {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

test("generateWiki: empty graph still emits the 5 family index pages", async () => {
  const store = new WikiFakeStore();
  const dir = await mkdtemp(path.join(tmpdir(), "codehub-wiki-empty-"));
  try {
    const result = await generateWiki(store, { outputDir: dir });
    const rels = result.filesWritten.map((f) => path.relative(dir, f)).sort();
    assert.ok(rels.includes("index.md"));
    assert.ok(rels.includes("architecture/index.md"));
    assert.ok(rels.includes("api-surface/index.md"));
    assert.ok(rels.includes("dependency-map/index.md"));
    assert.ok(rels.includes("ownership-map/index.md"));
    assert.ok(rels.includes("risk-atlas/index.md"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("generateWiki: --llm absent produces byte-identical output to deterministic run", async () => {
  // Regression guard: enabling and disabling --llm must yield bit-for-bit
  // identical output in the default (no-llm) case.
  const storeA = seededStore();
  const storeB = seededStore();
  const dirA = await mkdtemp(path.join(tmpdir(), "codehub-wiki-baseline-"));
  const dirB = await mkdtemp(path.join(tmpdir(), "codehub-wiki-explicit-off-"));
  try {
    await generateWiki(storeA, { outputDir: dirA });
    await generateWiki(storeB, {
      outputDir: dirB,
      // Even with llm option present but disabled, output must match.
      llm: { enabled: false, maxCalls: 0 },
    });
    const hashA = await hashDir(dirA);
    const hashB = await hashDir(dirB);
    assert.equal(hashA, hashB, "llm.enabled=false must produce identical output to no llm option");
  } finally {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

test("generateWiki: --llm with maxCalls=0 writes dry-run overview page; no Bedrock", async () => {
  const store = seededStore();
  const dir = await mkdtemp(path.join(tmpdir(), "codehub-wiki-llm-dry-"));
  let summarizeCalled = false;
  try {
    const result = await generateWiki(store, {
      outputDir: dir,
      llm: {
        enabled: true,
        maxCalls: 0,
        summarize: async () => {
          summarizeCalled = true;
          throw new Error("should not be called in dry-run");
        },
      },
    });
    assert.equal(summarizeCalled, false);
    const rels = result.filesWritten.map((f) => path.relative(dir, f)).sort();
    assert.ok(
      rels.includes("architecture/llm-overview.md"),
      "dry-run should still emit the llm-overview page",
    );
    const content = await readFile(path.join(dir, "architecture/llm-overview.md"), "utf8");
    assert.match(content, /# Module narratives/);
    assert.match(content, /dry-run/);
    assert.match(content, /Auth Subsystem/);
    // Root index gains the llm link when llm is enabled.
    const rootIndex = await readFile(path.join(dir, "index.md"), "utf8");
    assert.match(rootIndex, /llm-overview\.md/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("generateWiki: --llm happy path calls summarizer and writes narrative", async () => {
  const store = seededStore();
  const dir = await mkdtemp(path.join(tmpdir(), "codehub-wiki-llm-happy-"));
  const callSites: string[] = [];
  try {
    await generateWiki(store, {
      outputDir: dir,
      llm: {
        enabled: true,
        maxCalls: 5,
        summarize: async (input) => {
          callSites.push(input.filePath);
          return {
            summary: {
              purpose: `Module narrative for ${input.filePath} — drives request handling and state.`,
              inputs: [],
              returns: {
                type: "module",
                type_summary: "aggregated surface",
                details:
                  "A cohesive bundle of handlers that share state across the request lifecycle.",
              },
              side_effects: ["writes shared module state during request dispatch"],
              invariants: null,
              citations: [{ field_name: "purpose", line_start: 1, line_end: 5 }],
            },
            attempts: 1,
            usageByAttempt: [{ inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 }],
            wallClockMs: 1,
            validationFailures: [],
          };
        },
      },
    });
    assert.equal(callSites.length, 2, "should summarize two seeded communities");
    const content = await readFile(path.join(dir, "architecture/llm-overview.md"), "utf8");
    assert.match(content, /Auth Subsystem/);
    assert.match(content, /Billing Subsystem/);
    assert.match(content, /Module narrative for <synthetic>\/module\/Community:repo:auth/);
    assert.match(content, /writes shared module state/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("generateWiki: --llm with per-module summarizer failure falls back but keeps others", async () => {
  const store = seededStore();
  const dir = await mkdtemp(path.join(tmpdir(), "codehub-wiki-llm-fallback-"));
  try {
    await generateWiki(store, {
      outputDir: dir,
      llm: {
        enabled: true,
        maxCalls: 5,
        summarize: async (input) => {
          if (input.filePath.includes("billing")) {
            throw new Error("synthetic bedrock 429");
          }
          return {
            summary: {
              purpose:
                "Aggregate authentication flows and session bookkeeping for the request lifecycle.",
              inputs: [],
              returns: {
                type: "module",
                type_summary: "aggregated surface",
                details:
                  "A cohesive bundle of handlers that share state across the request lifecycle.",
              },
              side_effects: [],
              invariants: null,
              citations: [{ field_name: "purpose", line_start: 1, line_end: 5 }],
            },
            attempts: 1,
            usageByAttempt: [{ inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 }],
            wallClockMs: 1,
            validationFailures: [],
          };
        },
      },
    });
    const content = await readFile(path.join(dir, "architecture/llm-overview.md"), "utf8");
    // Auth still gets the narrative; Billing gets the fallback stamp.
    assert.match(content, /Aggregate authentication flows/);
    assert.match(content, /summarizer failed/);
    assert.match(content, /synthetic bedrock 429/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
