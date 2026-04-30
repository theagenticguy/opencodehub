/**
 * `codehub context <symbol>` — 360-degree view of a single symbol.
 *
 * Resolves the target by exact name against the `nodes` table, filtering out
 * synthetic import-tracking stubs (`file_path = '<external>'` and
 * `kind = 'CodeElement'`) that carry no caller/callee edges. Optional
 * `targetUid`, `filePath`, and `kind` narrow same-named candidates.
 * When exact-name yields zero rows we fall back to the BM25 index so
 * concept-phrase queries still work; when it yields more than one row
 * and no disambiguator narrows the set, we surface the candidate list.
 */

import type { IGraphStore, SearchResult, SqlParam } from "@opencodehub/storage";
import { type OpenStoreResult, openStoreForCommand } from "./open-store.js";

export interface ContextOptions {
  readonly repo?: string;
  readonly home?: string;
  readonly json?: boolean;
  readonly targetUid?: string;
  readonly filePath?: string;
  readonly kind?: string;
}

export interface ContextRuntimeHooks {
  readonly openStore?: (opts: ContextOptions) => Promise<OpenStoreResult>;
}

interface ProcessParticipation {
  readonly id: string;
  readonly label: string;
  readonly step: number | null;
}

interface ResolvedNode {
  readonly nodeId: string;
  readonly name: string;
  readonly kind: string;
  readonly filePath: string;
  readonly score: number;
}

type Resolution =
  | {
      readonly kind: "resolved";
      readonly target: ResolvedNode;
      readonly alternates: readonly ResolvedNode[];
    }
  | { readonly kind: "ambiguous"; readonly candidates: readonly ResolvedNode[] }
  | { readonly kind: "not_found" };

async function fetchProcessParticipation(
  store: IGraphStore,
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
    const rawStep = r["step"];
    const step = Number(rawStep);
    return {
      id: String(r["id"]),
      label,
      step: Number.isFinite(step) && step > 0 ? Math.trunc(step) : null,
    };
  });
}

function rowToResolvedNode(r: Record<string, unknown>): ResolvedNode {
  return {
    nodeId: String(r["id"]),
    name: String(r["name"] ?? ""),
    kind: String(r["kind"] ?? ""),
    filePath: String(r["file_path"] ?? ""),
    score: 0,
  };
}

function searchResultToResolvedNode(r: SearchResult): ResolvedNode {
  return {
    nodeId: r.nodeId,
    name: r.name,
    kind: r.kind,
    filePath: r.filePath,
    score: r.score,
  };
}

async function resolveTarget(
  store: IGraphStore,
  symbol: string,
  opts: ContextOptions,
): Promise<Resolution> {
  if (opts.targetUid !== undefined && opts.targetUid.length > 0) {
    const rows = (await store.query(
      "SELECT id, name, kind, file_path FROM nodes WHERE id = ? LIMIT 1",
      [opts.targetUid],
    )) as ReadonlyArray<Record<string, unknown>>;
    const row = rows[0];
    if (!row) return { kind: "not_found" };
    return { kind: "resolved", target: rowToResolvedNode(row), alternates: [] };
  }

  const params: SqlParam[] = [symbol];
  let sql =
    "SELECT id, name, kind, file_path FROM nodes WHERE name = ? AND file_path != '<external>' AND kind != 'CodeElement'";
  if (opts.kind !== undefined && opts.kind.length > 0) {
    sql += " AND kind = ?";
    params.push(opts.kind);
  }
  if (opts.filePath !== undefined && opts.filePath.length > 0) {
    sql += " AND file_path LIKE ?";
    params.push(`%${opts.filePath}%`);
  }
  sql += " ORDER BY file_path LIMIT 25";

  const exactRows = (await store.query(sql, params)) as ReadonlyArray<Record<string, unknown>>;

  if (exactRows.length === 1) {
    const row = exactRows[0];
    if (!row) return { kind: "not_found" };
    return { kind: "resolved", target: rowToResolvedNode(row), alternates: [] };
  }
  if (exactRows.length > 1) {
    return { kind: "ambiguous", candidates: exactRows.map(rowToResolvedNode) };
  }

  const fallback = await store.search({ text: symbol, limit: 5 });
  if (fallback.length === 0) return { kind: "not_found" };
  const [head, ...rest] = fallback;
  if (head === undefined) return { kind: "not_found" };
  return {
    kind: "resolved",
    target: searchResultToResolvedNode(head),
    alternates: rest.map(searchResultToResolvedNode),
  };
}

export async function runContext(
  symbol: string,
  opts: ContextOptions = {},
  hooks: ContextRuntimeHooks = {},
): Promise<void> {
  const openStore = hooks.openStore ?? openStoreForCommand;
  const { store, repoPath } = await openStore(opts);
  try {
    const resolution = await resolveTarget(store, symbol, opts);

    if (resolution.kind === "not_found") {
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              repoPath,
              target: null,
              callers: [],
              callees: [],
              processes: [],
              alternateCandidates: [],
            },
            null,
            2,
          ),
        );
        return;
      }
      console.warn(`context: no symbol matching "${symbol}" in ${repoPath}`);
      return;
    }

    if (resolution.kind === "ambiguous") {
      const candidates = resolution.candidates.slice(0, 10);
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              repoPath,
              ambiguous: true,
              candidates: resolution.candidates,
            },
            null,
            2,
          ),
        );
        process.exitCode = 1;
        return;
      }
      console.warn(
        `context: "${symbol}" matched ${resolution.candidates.length} symbols in ${repoPath}. Re-call with --target-uid, --file-path, or --kind.`,
      );
      for (let i = 0; i < candidates.length; i += 1) {
        const c = candidates[i];
        if (!c) continue;
        console.warn(`  ${i + 1}. [${c.kind}] ${c.name} — ${c.filePath}  (${c.nodeId})`);
      }
      if (resolution.candidates.length > candidates.length) {
        console.warn(`  … ${resolution.candidates.length - candidates.length} more`);
      }
      process.exitCode = 1;
      return;
    }

    const target = resolution.target;

    const [up, down, processes] = await Promise.all([
      store.traverse({
        startId: target.nodeId,
        direction: "up",
        maxDepth: 1,
        relationTypes: ["CALLS"],
      }),
      store.traverse({
        startId: target.nodeId,
        direction: "down",
        maxDepth: 1,
        relationTypes: ["CALLS"],
      }),
      fetchProcessParticipation(store, target.nodeId),
    ]);

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            repoPath,
            target,
            callers: up,
            callees: down,
            processes,
            alternateCandidates: resolution.alternates,
          },
          null,
          2,
        ),
      );
      return;
    }

    console.warn(`context: ${target.name} (${target.kind}) — ${target.filePath}`);
    console.log("");
    console.log(`Inbound (depth 1): ${up.length}`);
    for (const r of up) console.log(`  ← ${r.nodeId}`);
    console.log("");
    console.log(`Outbound (depth 1): ${down.length}`);
    for (const r of down) console.log(`  → ${r.nodeId}`);
    if (processes.length > 0) {
      console.log("");
      console.log(`Processes (${processes.length}):`);
      for (const p of processes) {
        const stepLabel = p.step !== null ? `step ${p.step}` : "participant";
        console.log(`  ⊿ ${p.label} — ${stepLabel}  (${p.id})`);
      }
    }
    if (resolution.alternates.length > 0) {
      console.log("");
      console.log(`Other candidates for "${symbol}":`);
      for (const c of resolution.alternates) {
        console.log(`  - ${c.name} (${c.kind}) — ${c.filePath}`);
      }
    }
  } finally {
    await store.close();
  }
}
