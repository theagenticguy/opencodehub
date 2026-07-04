/**
 * `codehub context <symbol>` — 360-degree view of a single symbol.
 *
 * Resolves the target by exact name against the graph, filtering out
 * synthetic import-tracking stubs (`filePath = '<external>'` and
 * `kind = 'CodeElement'`) that carry no caller/callee edges. Optional
 * `targetUid`, `filePath`, and `kind` narrow same-named candidates.
 * When exact-name yields zero rows we fall back to the BM25 index so
 * concept-phrase queries still work; when it yields more than one row
 * and no disambiguator narrows the set, we surface the candidate list.
 *
 * This command is graph-only — the lifecycle owner
 * (`openStoreForCommand`) constructs the composed `Store` envelope, but
 * `runContext` reaches through `store.graph` for every read so the
 * `IGraphStore` typed-finder surface stays the only contract.
 */

import { contextCapability } from "@opencodehub/core-ops";
import type { GraphNode, NodeKind } from "@opencodehub/core-types";
import type { IGraphStore, SearchResult } from "@opencodehub/storage";
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

function nodeToResolved(n: GraphNode): ResolvedNode {
  return {
    nodeId: n.id,
    name: n.name,
    kind: n.kind,
    filePath: n.filePath,
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
  graph: IGraphStore,
  symbol: string,
  opts: ContextOptions,
): Promise<Resolution> {
  if (opts.targetUid !== undefined && opts.targetUid.length > 0) {
    const list = await graph.listNodes({ ids: [opts.targetUid], limit: 1 });
    const node = list[0];
    if (!node) return { kind: "not_found" };
    return { kind: "resolved", target: nodeToResolved(node), alternates: [] };
  }

  // Name-keyed lookup with optional kind narrowing. The `file_path != '<external>'
  // AND kind != 'CodeElement'` invariants from the legacy SQL are now applied
  // post-finder so we don't need a `NOT IN` shape. The MCP-side migration in
  // `packages/mcp/src/tools/context.ts:418-429` pioneered this pattern.
  const listOpts =
    opts.kind !== undefined && opts.kind.length > 0 ? { kinds: [opts.kind as NodeKind] } : {};
  let candidates = await graph.listNodesByName(symbol, listOpts);
  // Drop synthetic import stubs.
  candidates = candidates.filter((n) => n.filePath !== "<external>" && n.kind !== "CodeElement");
  // Optional file-path substring narrow (LIKE %x%).
  if (opts.filePath !== undefined && opts.filePath.length > 0) {
    const sub = opts.filePath;
    candidates = candidates.filter((n) => n.filePath.includes(sub));
  }
  // Match prior `ORDER BY file_path LIMIT 25`.
  const sorted = [...candidates].sort((a, b) =>
    a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0,
  );
  const sliced = sorted.slice(0, 25);

  if (sliced.length === 1) {
    const head = sliced[0];
    if (!head) return { kind: "not_found" };
    return { kind: "resolved", target: nodeToResolved(head), alternates: [] };
  }
  if (sliced.length > 1) {
    return { kind: "ambiguous", candidates: sliced.map(nodeToResolved) };
  }

  const fallback = await graph.search({ text: symbol, limit: 5 });
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
  const graph = store.graph;
  try {
    const resolution = await resolveTarget(graph, symbol, opts);

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

    const [up, down, ctxOut] = await Promise.all([
      graph.traverse({
        startId: target.nodeId,
        direction: "up",
        maxDepth: 1,
        relationTypes: ["CALLS"],
      }),
      graph.traverse({
        startId: target.nodeId,
        direction: "down",
        maxDepth: 1,
        relationTypes: ["CALLS"],
      }),
      // Shared PROCESS_STEP reader — the one piece both surfaces run identically.
      contextCapability.execute({ targetId: target.nodeId }, { store, repoName: repoPath }),
    ]);
    const processes = ctxOut.processes;

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
