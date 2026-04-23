/**
 * Test-only helpers. Lives under src/ so tsc picks it up with the same strict
 * settings as production code, and so tests can import it without reaching
 * across the dist boundary.
 *
 * `FakeStore` is a narrow in-memory stand-in for IGraphStore. It models
 * just enough of the surface (`query`, `traverse`, and noop lifecycle
 * methods) for impact / rename / detect-changes tests to run without
 * spinning up DuckDB.
 */

import type {
  BulkLoadStats,
  EmbeddingRow,
  IGraphStore,
  SearchQuery,
  SearchResult,
  SqlParam,
  StoreMeta,
  TraverseQuery,
  TraverseResult,
  VectorQuery,
  VectorResult,
} from "@opencodehub/storage";

export interface FakeNode {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly filePath: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly entryPointId?: string;
  /** H.5 orphan grade — populated on `File` rows so impact tests can flex the multiplier. */
  readonly orphanGrade?: string;
  /** Export flag — used by the dead-code classifier. */
  readonly isExported?: boolean;
}

export interface FakeEdge {
  readonly fromId: string;
  readonly toId: string;
  readonly type: string;
  readonly confidence: number;
}

/**
 * Rudimentary SQL dispatcher. Each `query()` call is matched against a
 * small set of patterns produced by the analysis code (by-name lookup,
 * IN-list hydration, file-path filter, process-step join, …). Anything
 * unknown throws loudly so the test surfaces the shape it needs.
 */
export class FakeStore implements IGraphStore {
  readonly nodes: FakeNode[] = [];
  readonly edges: FakeEdge[] = [];

  addNode(n: FakeNode): void {
    this.nodes.push(n);
  }

  addEdge(e: FakeEdge): void {
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
  search(_q: SearchQuery): Promise<readonly SearchResult[]> {
    return Promise.resolve([]);
  }
  vectorSearch(_q: VectorQuery): Promise<readonly VectorResult[]> {
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

  query(
    sql: string,
    params: readonly SqlParam[] = [],
  ): Promise<readonly Record<string, unknown>[]> {
    const trimmed = sql.replace(/\s+/g, " ").trim();
    const rows = this.dispatch(trimmed, params);
    return Promise.resolve(rows);
  }

  traverse(q: TraverseQuery): Promise<readonly TraverseResult[]> {
    // Breadth-first expansion; tracks visit order but doesn't guarantee the
    // shortest path — tests don't care about that and neither does the
    // production traversal on DuckDB.
    const minConf = q.minConfidence ?? 0;
    const relTypes = q.relationTypes ? new Set(q.relationTypes) : undefined;
    const results: TraverseResult[] = [];
    const seen = new Set<string>([q.startId]);
    type Frontier = {
      readonly id: string;
      readonly depth: number;
      readonly path: readonly string[];
    };
    let frontier: Frontier[] = [{ id: q.startId, depth: 0, path: [q.startId] }];
    while (frontier.length > 0) {
      const next: Frontier[] = [];
      for (const cur of frontier) {
        if (cur.depth >= q.maxDepth) continue;
        for (const e of this.edges) {
          if (relTypes && !relTypes.has(e.type)) continue;
          if (e.confidence < minConf) continue;
          const reaches =
            q.direction === "down" || q.direction === "both"
              ? e.fromId === cur.id
                ? e.toId
                : undefined
              : undefined;
          const reachesUp =
            q.direction === "up" || q.direction === "both"
              ? e.toId === cur.id
                ? e.fromId
                : undefined
              : undefined;
          for (const nxt of [reaches, reachesUp]) {
            if (!nxt) continue;
            if (seen.has(nxt)) continue;
            seen.add(nxt);
            const path = [...cur.path, nxt];
            const depth = cur.depth + 1;
            results.push({ nodeId: nxt, depth, path });
            next.push({ id: nxt, depth, path });
          }
        }
      }
      frontier = next;
    }
    // Sort to match DuckDB's ORDER BY depth, node_id.
    results.sort((a, b) =>
      a.depth === b.depth ? a.nodeId.localeCompare(b.nodeId) : a.depth - b.depth,
    );
    return Promise.resolve(results);
  }

  private dispatch(sql: string, params: readonly SqlParam[]): readonly Record<string, unknown>[] {
    // SELECT id, name, file_path, kind FROM nodes WHERE name = ? ORDER BY id
    if (/^SELECT id, name, file_path, kind FROM nodes WHERE name = \? ORDER BY id$/i.test(sql)) {
      const name = String(params[0]);
      return this.nodes
        .filter((n) => n.name === name)
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(nodeToRow);
    }
    // SELECT id, name, file_path, kind FROM nodes WHERE id = ? LIMIT 1
    if (/^SELECT id, name, file_path, kind FROM nodes WHERE id = \? LIMIT 1$/i.test(sql)) {
      const id = String(params[0]);
      const hit = this.nodes.find((n) => n.id === id);
      return hit ? [nodeToRow(hit)] : [];
    }
    // SELECT id, name, file_path, kind FROM nodes WHERE id IN (...)
    if (/^SELECT id, name, file_path, kind FROM nodes WHERE id IN \([?,\s]+\)$/i.test(sql)) {
      const set = new Set(params.map((p) => String(p)));
      return this.nodes.filter((n) => set.has(n.id)).map(nodeToRow);
    }
    // Symbol resolver for rename: SELECT id, name, file_path, kind, start_line, end_line
    if (
      /^SELECT id, name, file_path, kind, start_line, end_line FROM nodes WHERE name = \?/i.test(
        sql,
      )
    ) {
      const hasScope = /AND file_path = \?/i.test(sql);
      const name = String(params[0]);
      const scope = hasScope ? String(params[1]) : undefined;
      return this.nodes
        .filter((n) => n.name === name && (!scope || n.filePath === scope))
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(fullNodeRow);
    }
    // Rename referrers: SELECT DISTINCT n.id, n.name, n.file_path, n.kind,
    // n.start_line, n.end_line FROM relations r JOIN nodes n ON n.id =
    // r.from_id WHERE r.to_id = ? AND r.type IN (...)
    if (
      /^SELECT DISTINCT n\.id, n\.name, n\.file_path, n\.kind, n\.start_line, n\.end_line FROM relations r JOIN nodes n ON n\.id = r\.from_id WHERE r\.to_id = \? AND r\.type IN \([?,\s]+\)$/i.test(
        sql,
      )
    ) {
      const targetId = String(params[0]);
      const types = new Set(params.slice(1).map((p) => String(p)));
      const fromIds = new Set<string>();
      for (const e of this.edges) {
        if (e.toId === targetId && types.has(e.type)) fromIds.add(e.fromId);
      }
      return this.nodes
        .filter((n) => fromIds.has(n.id))
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(fullNodeRow);
    }
    // Rename repo file list: SELECT DISTINCT file_path FROM nodes WHERE kind = 'File' ORDER BY file_path
    if (
      /^SELECT DISTINCT file_path FROM nodes WHERE kind = 'File' ORDER BY file_path$/i.test(sql)
    ) {
      const seen = new Set<string>();
      for (const n of this.nodes) {
        if (n.kind === "File") seen.add(n.filePath);
      }
      return [...seen].sort().map((fp) => ({ file_path: fp }));
    }
    // Detect-changes symbol list
    if (
      /^SELECT id, name, kind, file_path, start_line, end_line FROM nodes WHERE file_path = \? AND kind NOT IN \('File', 'Folder'\) AND start_line IS NOT NULL AND end_line IS NOT NULL$/i.test(
        sql,
      )
    ) {
      const file = String(params[0]);
      return this.nodes
        .filter(
          (n) =>
            n.filePath === file &&
            n.kind !== "File" &&
            n.kind !== "Folder" &&
            n.startLine !== undefined &&
            n.endLine !== undefined,
        )
        .map((n) => ({
          id: n.id,
          name: n.name,
          kind: n.kind,
          file_path: n.filePath,
          start_line: n.startLine,
          end_line: n.endLine,
        }));
    }
    // Impact: processes that contain affected symbols (recursive PROCESS_STEP walk
    // from target *backwards* via r.to_id = ancestor_id to entry points)
    if (
      /^WITH RECURSIVE member_ancestors.*JOIN member_ancestors ma ON ma\.ancestor_id = p\.entry_point_id\s+WHERE p\.kind = 'Process'$/is.test(
        sql,
      )
    ) {
      const targetIds = new Set(params.map((p) => String(p)));
      // Reverse PROCESS_STEP adjacency: toId -> fromIds. Walk back from target
      // collecting every ancestor (which includes the entry point).
      const revAdj = new Map<string, string[]>();
      for (const e of this.edges) {
        if (e.type !== "PROCESS_STEP") continue;
        const bucket = revAdj.get(e.toId) ?? [];
        bucket.push(e.fromId);
        revAdj.set(e.toId, bucket);
      }
      const ancestors = new Set<string>();
      for (const t of targetIds) ancestors.add(t);
      const queue: string[] = [...targetIds];
      while (queue.length > 0) {
        const cur = queue.shift();
        if (!cur) break;
        for (const prev of revAdj.get(cur) ?? []) {
          if (ancestors.has(prev)) continue;
          ancestors.add(prev);
          queue.push(prev);
        }
      }
      const matches = new Map<
        string,
        { id: string; name: string; entry_point_id: string | null }
      >();
      for (const p of this.nodes) {
        if (p.kind !== "Process" || !p.entryPointId) continue;
        if (!ancestors.has(p.entryPointId)) continue;
        matches.set(p.id, {
          id: p.id,
          name: p.name,
          entry_point_id: p.entryPointId ?? null,
        });
      }
      return [...matches.values()].sort((a, b) => a.id.localeCompare(b.id));
    }
    // Detect-changes: processes for affected symbols
    if (
      /^SELECT DISTINCT r\.from_id AS process_id FROM relations r JOIN nodes p ON p\.id = r\.from_id WHERE r\.type = 'PROCESS_STEP' AND p\.kind = 'Process' AND r\.to_id IN \([?,\s]+\)$/i.test(
        sql,
      )
    ) {
      const targetIds = new Set(params.map((p) => String(p)));
      const processes = new Set<string>();
      const processNodes = new Map(
        this.nodes.filter((n) => n.kind === "Process").map((n) => [n.id, n]),
      );
      for (const e of this.edges) {
        if (e.type !== "PROCESS_STEP") continue;
        if (!targetIds.has(e.toId)) continue;
        if (!processNodes.has(e.fromId)) continue;
        processes.add(e.fromId);
      }
      return [...processes].sort().map((id) => ({ process_id: id }));
    }
    // Detect-changes: process metadata
    if (
      /^SELECT id, name, entry_point_id FROM nodes WHERE id IN \([?,\s]+\) AND kind = 'Process'$/i.test(
        sql,
      )
    ) {
      const ids = new Set(params.map((p) => String(p)));
      return this.nodes
        .filter((n) => ids.has(n.id) && n.kind === "Process")
        .map((n) => ({ id: n.id, name: n.name, entry_point_id: n.entryPointId ?? null }));
    }
    // Detect-changes: entry-point file lookup
    if (/^SELECT id, file_path FROM nodes WHERE id IN \([?,\s]+\)$/i.test(sql)) {
      const ids = new Set(params.map((p) => String(p)));
      return this.nodes
        .filter((n) => ids.has(n.id))
        .map((n) => ({ id: n.id, file_path: n.filePath }));
    }
    // Impact: orphan-grade lookup (Stream H.5).
    if (
      /^SELECT file_path, orphan_grade FROM nodes WHERE kind = 'File' AND file_path IN \([?,\s]+\)$/i.test(
        sql,
      )
    ) {
      const paths = new Set(params.map((p) => String(p)));
      return this.nodes
        .filter((n) => n.kind === "File" && paths.has(n.filePath))
        .map((n) => ({
          file_path: n.filePath,
          orphan_grade: n.orphanGrade ?? null,
        }));
    }
    // Impact: relation-type lookup
    if (
      /^SELECT from_id, to_id, type FROM relations WHERE from_id IN \([?,\s]+\) AND to_id IN \([?,\s]+\)$/i.test(
        sql,
      )
    ) {
      // Params: first N are from ids, next M are to ids. We don't know the split
      // without re-parsing; the production code concatenates them, so we derive N
      // by scanning the sql for the number of placeholders in each IN list.
      const inCounts = [...sql.matchAll(/IN \((\?(?:, \?)*)\)/g)].map(
        (m) => m[1]?.split(",").length ?? 0,
      );
      const fromCount = inCounts[0] ?? 0;
      const fromIds = new Set(params.slice(0, fromCount).map((p) => String(p)));
      const toIds = new Set(params.slice(fromCount).map((p) => String(p)));
      const out: Record<string, unknown>[] = [];
      for (const e of this.edges) {
        if (fromIds.has(e.fromId) && toIds.has(e.toId)) {
          out.push({ from_id: e.fromId, to_id: e.toId, type: e.type });
        }
      }
      return out;
    }
    // Dead-code: fetch all classifiable symbols with is_exported.
    if (
      /^SELECT id, name, kind, file_path, start_line, is_exported FROM nodes WHERE kind IN \([?,\s]+\)$/i.test(
        sql,
      )
    ) {
      const kinds = new Set(params.map((p) => String(p)));
      return this.nodes
        .filter((n) => kinds.has(n.kind))
        .map((n) => ({
          id: n.id,
          name: n.name,
          kind: n.kind,
          file_path: n.filePath,
          start_line: n.startLine ?? null,
          is_exported: n.isExported === true,
        }));
    }
    // Dead-code: inbound referrers grouped by target + source file.
    if (
      /^SELECT r\.to_id AS target_id, n\.file_path AS source_file FROM relations r JOIN nodes n ON n\.id = r\.from_id WHERE r\.to_id IN \([?,\s]+\) AND r\.type IN \([?,\s]+\)$/i.test(
        sql,
      )
    ) {
      const inMatches = [...sql.matchAll(/IN \(([?,\s]+)\)/g)];
      const targetCount = (inMatches[0]?.[1] ?? "").split(",").length;
      const targetIds = new Set(params.slice(0, targetCount).map((p) => String(p)));
      const types = new Set(params.slice(targetCount).map((p) => String(p)));
      const fileById = new Map(this.nodes.map((n) => [n.id, n.filePath]));
      const out: Record<string, unknown>[] = [];
      for (const e of this.edges) {
        if (!targetIds.has(e.toId)) continue;
        if (!types.has(e.type)) continue;
        out.push({
          target_id: e.toId,
          source_file: fileById.get(e.fromId) ?? "",
        });
      }
      return out;
    }
    // Dead-code: MEMBER_OF edges for community membership lookup.
    if (
      /^SELECT from_id AS symbol_id, to_id AS community_id FROM relations WHERE type = 'MEMBER_OF' AND from_id IN \([?,\s]+\)$/i.test(
        sql,
      )
    ) {
      const ids = new Set(params.map((p) => String(p)));
      const out: Record<string, unknown>[] = [];
      for (const e of this.edges) {
        if (e.type !== "MEMBER_OF") continue;
        if (!ids.has(e.fromId)) continue;
        out.push({ symbol_id: e.fromId, community_id: e.toId });
      }
      return out;
    }
    throw new Error(`FakeStore: unhandled SQL: ${sql}`);
  }
}

function nodeToRow(n: FakeNode): Record<string, unknown> {
  return { id: n.id, name: n.name, file_path: n.filePath, kind: n.kind };
}

function fullNodeRow(n: FakeNode): Record<string, unknown> {
  return {
    id: n.id,
    name: n.name,
    file_path: n.filePath,
    kind: n.kind,
    start_line: n.startLine ?? null,
    end_line: n.endLine ?? null,
  };
}

/** In-memory {@link FsAbstraction} for rename tests. */
export class FakeFs {
  readonly files = new Map<string, string>();

  constructor(seed: Readonly<Record<string, string>> = {}) {
    for (const [k, v] of Object.entries(seed)) this.files.set(k, v);
  }

  readFile(absPath: string): Promise<string> {
    const v = this.files.get(absPath);
    if (v === undefined) {
      const err = new Error(`ENOENT: ${absPath}`);
      return Promise.reject(err);
    }
    return Promise.resolve(v);
  }

  writeFileAtomic(absPath: string, content: string): Promise<void> {
    this.files.set(absPath, content);
    return Promise.resolve();
  }
}
