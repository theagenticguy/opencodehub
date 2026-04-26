/**
 * `codehub context <symbol>` — 360-degree view of a single symbol.
 *
 * MVP implementation: finds node(s) matching `symbol` by name via the store's
 * BM25 index, then runs a `traverse` in both directions at depth 1 to list
 * immediate callers and callees.
 *
 * In addition we surface PROCESS_STEP participation — the Process nodes
 * that include this symbol as a step — by querying the relations table
 * directly. This mirrors the MCP `context` tool's `processes` field;
 * without it Process-kind targets return empty inbound/outbound even
 * though the graph carries the step edges.
 */

import { openStoreForCommand } from "./open-store.js";

export interface ContextOptions {
  readonly repo?: string;
  readonly home?: string;
  readonly json?: boolean;
}

interface ProcessParticipation {
  readonly id: string;
  readonly label: string;
  readonly step: number | null;
}

async function fetchProcessParticipation(
  store: Awaited<ReturnType<typeof openStoreForCommand>>["store"],
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

export async function runContext(symbol: string, opts: ContextOptions = {}): Promise<void> {
  const { store, repoPath } = await openStoreForCommand(opts);
  try {
    const candidates = await store.search({ text: symbol, limit: 5 });
    if (candidates.length === 0) {
      console.warn(`context: no symbol matching "${symbol}" in ${repoPath}`);
      return;
    }
    const target = candidates[0];
    if (target === undefined) return;

    // Restrict to CALLS so callers/callees match the MCP `context` tool
    // (which queries `r.type = 'CALLS'` directly). Without this filter the
    // store defaults to ALL_RELATION_TYPES and folds in CONTAINS/DEFINES/
    // HAS_METHOD/etc., over-inclusive by ~2.3× on real codebases.
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
            alternateCandidates: candidates.slice(1),
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
    if (candidates.length > 1) {
      console.log("");
      console.log(`Other candidates for "${symbol}":`);
      for (const c of candidates.slice(1)) {
        console.log(`  - ${c.name} (${c.kind}) — ${c.filePath}`);
      }
    }
  } finally {
    await store.close();
  }
}
