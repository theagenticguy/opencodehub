/**
 * Wiki generation tests — confirm the deterministic-output + success-criteria
 * contract without spinning up DuckDB.
 *
 * A small in-memory `WikiFakeStore` models the SQL shapes the wiki renderers
 * issue. Every query the code paths emit is captured; unmatched SQL throws
 * loudly so the test surface stays honest with production.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type {
  BulkLoadStats,
  CochangeRow,
  EmbeddingRow,
  IGraphStore,
  SearchQuery,
  SearchResult,
  SqlParam,
  StoreMeta,
  SymbolSummaryRow,
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

class WikiFakeStore implements IGraphStore {
  readonly nodes: WikiNode[] = [];
  readonly edges: WikiEdge[] = [];

  addNode(n: WikiNode): void {
    this.nodes.push(n);
  }
  addEdge(e: WikiEdge): void {
    this.edges.push(e);
  }

  open(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  createSchema(): Promise<void> {
    return Promise.resolve();
  }
  bulkLoad(): Promise<BulkLoadStats> {
    return Promise.resolve({ nodeCount: 0, edgeCount: 0, durationMs: 0 });
  }
  upsertEmbeddings(_rows: readonly EmbeddingRow[]): Promise<void> {
    return Promise.resolve();
  }
  listEmbeddingHashes(): Promise<Map<string, string>> {
    return Promise.resolve(new Map());
  }
  search(_q: SearchQuery): Promise<readonly SearchResult[]> {
    return Promise.resolve([]);
  }
  vectorSearch(_q: VectorQuery): Promise<readonly VectorResult[]> {
    return Promise.resolve([]);
  }
  traverse(_q: TraverseQuery): Promise<readonly TraverseResult[]> {
    return Promise.resolve([]);
  }
  getMeta(): Promise<StoreMeta | undefined> {
    return Promise.resolve(undefined);
  }
  setMeta(_meta: StoreMeta): Promise<void> {
    return Promise.resolve();
  }
  healthCheck(): Promise<{ ok: boolean; message?: string }> {
    return Promise.resolve({ ok: true });
  }
  bulkLoadCochanges(): Promise<void> {
    return Promise.resolve();
  }
  lookupCochangesForFile(): Promise<readonly CochangeRow[]> {
    return Promise.resolve([]);
  }
  lookupCochangesBetween(): Promise<CochangeRow | undefined> {
    return Promise.resolve(undefined);
  }
  bulkLoadSymbolSummaries(_rows: readonly SymbolSummaryRow[]): Promise<void> {
    return Promise.resolve();
  }
  lookupSymbolSummary(): Promise<SymbolSummaryRow | undefined> {
    return Promise.resolve(undefined);
  }
  lookupSymbolSummariesByNode(): Promise<readonly SymbolSummaryRow[]> {
    return Promise.resolve([]);
  }

  query(
    sql: string,
    params: readonly SqlParam[] = [],
  ): Promise<readonly Record<string, unknown>[]> {
    const trimmed = sql.replace(/\s+/g, " ").trim();
    return Promise.resolve(this.dispatch(trimmed, params));
  }

  private dispatch(sql: string, params: readonly SqlParam[]): readonly Record<string, unknown>[] {
    if (
      sql.startsWith(
        "SELECT id, name, inferred_label, symbol_count, cohesion, truck_factor FROM nodes WHERE kind = 'Community'",
      )
    ) {
      return this.nodes
        .filter((n) => n.kind === "Community")
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((n) => ({
          id: n.id,
          name: n.name,
          inferred_label: n.inferredLabel ?? "",
          symbol_count: n.symbolCount ?? 0,
          cohesion: n.cohesion ?? 0,
          truck_factor: n.truckFactor ?? null,
        }));
    }
    if (
      sql.startsWith(
        "SELECT n.file_path AS file_path, COUNT(*) AS member_count FROM relations r JOIN nodes n ON n.id = r.from_id WHERE r.type = 'MEMBER_OF' AND r.to_id = ?",
      )
    ) {
      const communityId = String(params[0]);
      const limit = Number(params[1] ?? 10);
      const byFile = new Map<string, number>();
      for (const e of this.edges) {
        if (e.type !== "MEMBER_OF" || e.toId !== communityId) continue;
        const from = this.nodes.find((n) => n.id === e.fromId);
        if (from === undefined) continue;
        byFile.set(from.filePath, (byFile.get(from.filePath) ?? 0) + 1);
      }
      const rows = [...byFile.entries()]
        .map(([filePath, memberCount]) => ({ file_path: filePath, member_count: memberCount }))
        .sort((a, b) =>
          b.member_count === a.member_count
            ? a.file_path.localeCompare(b.file_path)
            : b.member_count - a.member_count,
        )
        .slice(0, limit);
      return rows;
    }
    if (
      sql.startsWith(
        "SELECT c.id AS id, c.name AS name, c.email_hash AS email_hash, c.email_plain AS email_plain, SUM(o.confidence) AS line_share FROM relations m JOIN nodes f ON f.id = m.from_id AND f.kind = 'File' JOIN relations o ON o.from_id = f.id AND o.type = 'OWNED_BY' JOIN nodes c ON c.id = o.to_id AND c.kind = 'Contributor' WHERE m.type = 'MEMBER_OF' AND m.to_id = ?",
      )
    ) {
      const communityId = String(params[0]);
      const limit = Number(params[1] ?? 10);
      const contributorShares = new Map<string, { node: WikiNode; share: number }>();
      for (const memberEdge of this.edges) {
        if (memberEdge.type !== "MEMBER_OF" || memberEdge.toId !== communityId) continue;
        const file = this.nodes.find((n) => n.id === memberEdge.fromId && n.kind === "File");
        if (file === undefined) continue;
        for (const ownEdge of this.edges) {
          if (ownEdge.type !== "OWNED_BY" || ownEdge.fromId !== file.id) continue;
          const contributor = this.nodes.find(
            (n) => n.id === ownEdge.toId && n.kind === "Contributor",
          );
          if (contributor === undefined) continue;
          const prior = contributorShares.get(contributor.id);
          if (prior === undefined) {
            contributorShares.set(contributor.id, {
              node: contributor,
              share: ownEdge.confidence,
            });
          } else {
            prior.share += ownEdge.confidence;
          }
        }
      }
      const rows = [...contributorShares.values()]
        .sort((a, b) =>
          b.share === a.share ? a.node.id.localeCompare(b.node.id) : b.share - a.share,
        )
        .slice(0, limit)
        .map((entry) => ({
          id: entry.node.id,
          name: entry.node.name,
          email_hash: entry.node.emailHash ?? "",
          email_plain: entry.node.emailPlain ?? "",
          line_share: entry.share,
        }));
      return rows;
    }
    if (
      sql.startsWith(
        "SELECT languages_json, frameworks_json, api_contracts_json, iac_types_json FROM nodes WHERE kind = 'ProjectProfile'",
      )
    ) {
      const hit = this.nodes.find((n) => n.kind === "ProjectProfile");
      if (hit === undefined) return [];
      return [
        {
          languages_json: hit.languagesJson ?? "",
          frameworks_json: hit.frameworksJson ?? "",
          api_contracts_json: hit.apiContractsJson ?? "",
          iac_types_json: hit.iacTypesJson ?? "",
        },
      ];
    }
    if (
      sql.startsWith(
        "SELECT r.id AS id, r.name AS name, r.url AS url, r.method AS method, MIN(handler.file_path) AS file_path FROM nodes r LEFT JOIN relations hr ON hr.to_id = r.id AND hr.type = 'HANDLES_ROUTE' LEFT JOIN nodes handler ON handler.id = hr.from_id WHERE r.kind = 'Route'",
      )
    ) {
      const routes = this.nodes.filter((n) => n.kind === "Route");
      const rows = routes.map((r) => {
        const handlerEdges = this.edges.filter(
          (e) => e.type === "HANDLES_ROUTE" && e.toId === r.id,
        );
        const handlers = handlerEdges
          .map((e) => this.nodes.find((n) => n.id === e.fromId))
          .filter((n): n is WikiNode => n !== undefined);
        const minPath =
          handlers.length === 0
            ? ""
            : (handlers.map((h) => h.filePath).sort((a, b) => a.localeCompare(b))[0] ?? "");
        return {
          id: r.id,
          name: r.name,
          url: r.url ?? "",
          method: r.method ?? "",
          file_path: minPath,
        };
      });
      rows.sort((a, b) => {
        if (a.url !== b.url) return a.url.localeCompare(b.url);
        if (a.method !== b.method) return a.method.localeCompare(b.method);
        return a.id.localeCompare(b.id);
      });
      return rows;
    }
    if (
      sql.startsWith(
        "SELECT id, name, http_path, http_method, summary, file_path FROM nodes WHERE kind = 'Operation'",
      )
    ) {
      return this.nodes
        .filter((n) => n.kind === "Operation")
        .map((n) => ({
          id: n.id,
          name: n.name,
          http_path: n.httpPath ?? "",
          http_method: n.httpMethod ?? "",
          summary: n.summary ?? "",
          file_path: n.filePath,
        }))
        .sort((a, b) => {
          if (a.http_path !== b.http_path) return a.http_path.localeCompare(b.http_path);
          if (a.http_method !== b.http_method) return a.http_method.localeCompare(b.http_method);
          return a.id.localeCompare(b.id);
        });
    }
    if (
      sql.startsWith(
        "SELECT from_n.file_path AS from_file, from_n.name AS from_name, to_n.url AS to_url FROM relations r JOIN nodes from_n ON from_n.id = r.from_id JOIN nodes to_n ON to_n.id = r.to_id WHERE r.type = 'FETCHES'",
      )
    ) {
      const rows: { from_file: string; from_name: string; to_url: string }[] = [];
      for (const e of this.edges) {
        if (e.type !== "FETCHES") continue;
        const from = this.nodes.find((n) => n.id === e.fromId);
        const to = this.nodes.find((n) => n.id === e.toId);
        if (from === undefined || to === undefined) continue;
        rows.push({
          from_file: from.filePath,
          from_name: from.name,
          to_url: to.url ?? "",
        });
      }
      rows.sort((a, b) => {
        if (a.to_url !== b.to_url) return a.to_url.localeCompare(b.to_url);
        if (a.from_file !== b.from_file) return a.from_file.localeCompare(b.from_file);
        return a.from_name.localeCompare(b.from_name);
      });
      return rows;
    }
    if (
      sql.startsWith(
        "SELECT d.id AS id, d.name AS name, d.version AS version, d.ecosystem AS ecosystem, d.license AS license, d.lockfile_source AS lockfile_source, COUNT(r.id) AS usage_count FROM nodes d LEFT JOIN relations r ON r.to_id = d.id AND r.type = 'DEPENDS_ON' WHERE d.kind = 'Dependency'",
      )
    ) {
      const rows = this.nodes
        .filter((n) => n.kind === "Dependency")
        .map((d) => {
          const usageCount = this.edges.filter(
            (e) => e.type === "DEPENDS_ON" && e.toId === d.id,
          ).length;
          return {
            id: d.id,
            name: d.name,
            version: d.version ?? "",
            ecosystem: d.ecosystem ?? "",
            license: d.license ?? "",
            lockfile_source: d.lockfileSource ?? "",
            usage_count: usageCount,
          };
        });
      rows.sort((a, b) => {
        if (a.name !== b.name) return a.name.localeCompare(b.name);
        if (a.version !== b.version) return a.version.localeCompare(b.version);
        return a.id.localeCompare(b.id);
      });
      return rows;
    }
    if (
      sql.startsWith(
        "SELECT id, name, file_path, start_line, end_line, deadness FROM nodes WHERE deadness IN ('dead', 'unreachable-export')",
      )
    ) {
      return this.nodes
        .filter((n) => n.deadness === "dead" || n.deadness === "unreachable-export")
        .map((n) => ({
          id: n.id,
          name: n.name,
          file_path: n.filePath,
          start_line: n.startLine ?? null,
          end_line: n.endLine ?? null,
          deadness: n.deadness ?? "",
        }))
        .sort((a, b) => {
          if (a.file_path !== b.file_path) return a.file_path.localeCompare(b.file_path);
          const al = a.start_line ?? 0;
          const bl = b.start_line ?? 0;
          if (al !== bl) return (al as number) - (bl as number);
          return a.id.localeCompare(b.id);
        });
    }
    if (
      sql.startsWith(
        "SELECT id, file_path, orphan_grade FROM nodes WHERE kind = 'File' AND orphan_grade IS NOT NULL AND orphan_grade <> 'active'",
      )
    ) {
      return this.nodes
        .filter(
          (n) => n.kind === "File" && n.orphanGrade !== undefined && n.orphanGrade !== "active",
        )
        .map((n) => ({
          id: n.id,
          file_path: n.filePath,
          orphan_grade: n.orphanGrade ?? "",
        }))
        .sort((a, b) =>
          a.file_path === b.file_path
            ? a.id.localeCompare(b.id)
            : a.file_path.localeCompare(b.file_path),
        );
    }
    if (
      sql.startsWith(
        "SELECT n.name AS name FROM relations r JOIN nodes n ON n.id = r.from_id WHERE r.type = 'MEMBER_OF' AND r.to_id = ? AND n.kind IN ('Class', 'Function', 'Method')",
      )
    ) {
      const communityId = String(params[0]);
      const limit = Number(params[1] ?? 10);
      // Walk MEMBER_OF edges into non-File, non-Contributor members and
      // collect symbol names. In the seeded graph, MEMBER_OF is emitted
      // from files; symbol members for this SQL don't exist in the
      // seeded data, so returning an empty array matches the real
      // shape (communities in the seed are file-only).
      const names: string[] = [];
      for (const e of this.edges) {
        if (e.type !== "MEMBER_OF" || e.toId !== communityId) continue;
        const from = this.nodes.find((n) => n.id === e.fromId);
        if (from === undefined) continue;
        if (from.kind !== "Class" && from.kind !== "Function" && from.kind !== "Method") continue;
        if (from.name.length === 0) continue;
        names.push(from.name);
      }
      const kindOrder: Record<string, number> = { Class: 0, Function: 1, Method: 2 };
      const fromNodesByName = new Map<string, WikiNode>();
      for (const e of this.edges) {
        if (e.type !== "MEMBER_OF" || e.toId !== communityId) continue;
        const from = this.nodes.find((n) => n.id === e.fromId);
        if (from === undefined) continue;
        if (from.kind !== "Class" && from.kind !== "Function" && from.kind !== "Method") continue;
        fromNodesByName.set(from.id, from);
      }
      const sorted = [...fromNodesByName.values()]
        .filter((n) => n.name.length > 0)
        .sort((a, b) => {
          const ak = kindOrder[a.kind] ?? 99;
          const bk = kindOrder[b.kind] ?? 99;
          if (ak !== bk) return ak - bk;
          return a.name.localeCompare(b.name);
        })
        .slice(0, limit)
        .map((n) => ({ name: n.name }));
      return sorted;
    }
    if (
      sql.startsWith(
        "SELECT MAX(f.top_contributor_last_seen_days) AS max_days FROM relations m JOIN nodes f ON f.id = m.from_id AND f.kind = 'File' WHERE m.type = 'MEMBER_OF' AND m.to_id = ?",
      )
    ) {
      const communityId = String(params[0]);
      let max: number | undefined;
      for (const e of this.edges) {
        if (e.type !== "MEMBER_OF" || e.toId !== communityId) continue;
        const file = this.nodes.find((n) => n.id === e.fromId && n.kind === "File");
        if (file === undefined) continue;
        if (file.topContributorLastSeenDays !== undefined) {
          max =
            max === undefined
              ? file.topContributorLastSeenDays
              : Math.max(max, file.topContributorLastSeenDays);
        }
      }
      return [{ max_days: max ?? null }];
    }
    throw new Error(`WikiFakeStore: unhandled SQL: ${sql}`);
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
