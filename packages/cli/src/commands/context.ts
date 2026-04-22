/**
 * `codehub context <symbol>` — 360-degree view of a single symbol.
 *
 * MVP implementation: finds node(s) matching `symbol` by name via the store's
 * BM25 index, then runs a `traverse` in both directions at depth 1 to list
 * immediate callers and callees.
 */

import { openStoreForCommand } from "./open-store.js";

export interface ContextOptions {
  readonly repo?: string;
  readonly home?: string;
  readonly json?: boolean;
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
    const [up, down] = await Promise.all([
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
    ]);

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            repoPath,
            target,
            callers: up,
            callees: down,
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
