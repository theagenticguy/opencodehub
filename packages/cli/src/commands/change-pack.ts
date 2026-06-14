/**
 * `codehub change-pack` — diff-scoped change-pack: impacted subgraph +
 * verdict + affected tests + cost estimate.
 *
 * Delegates to `@opencodehub/analysis.runChangePack`. The CLI layer only
 * resolves the scope flags, opens a read-only store, and formats the
 * result. CLI sibling of the `change_pack` MCP tool — usable from CI
 * without launching the MCP server.
 *
 * Exit codes mirror `codehub verdict`: the verdict already carries the
 * 0|1|2 ladder (auto_merge/single_review → 0, dual_review → 1,
 * expert_review/block → 2), so we reuse `pack.verdict.exitCode` verbatim
 * for both the JSON and human-summary paths. CI gates configured against
 * `codehub verdict` therefore behave identically against `change-pack`.
 */

import type { ChangePack, ChangePackQuery } from "@opencodehub/analysis";
import { runChangePack } from "@opencodehub/analysis";
import type { IGraphStore } from "@opencodehub/storage";
import { type OpenStoreResult, openStoreForCommand } from "./open-store.js";

export interface ChangePackOptions {
  readonly base?: string;
  readonly head?: string;
  readonly depth?: number;
  readonly minConfidence?: number;
  readonly budget?: number;
  readonly includeTestsInSubgraph?: boolean;
  readonly repo?: string;
  readonly home?: string;
  readonly json?: boolean;
  /**
   * Test seam — inject a custom store factory. Production callers leave
   * this unset; the runtime calls {@link openStoreForCommand}. Mirrors the
   * `_store` / `_generatePack` seams on `verdict` / `code-pack`.
   */
  readonly _openStore?: (opts: ChangePackOptions) => Promise<OpenStoreResult>;
  /**
   * Test seam — inject a custom `runChangePack`. Production callers leave
   * this unset; the runtime uses `@opencodehub/analysis.runChangePack`,
   * which shells out to git. Tests inject a deterministic stand-in so the
   * suite never spawns git or touches disk — mirrors verdict.ts's
   * `computeVerdictFn` seam.
   */
  readonly _runChangePack?: (store: IGraphStore, query: ChangePackQuery) => Promise<ChangePack>;
}

export async function runChangePackCmd(opts: ChangePackOptions = {}): Promise<void> {
  const openStore = opts._openStore ?? openStoreForCommand;
  const run = opts._runChangePack ?? runChangePack;
  const { store, repoPath } = await openStore(opts);
  try {
    const query: ChangePackQuery = {
      repoPath,
      ...(opts.base !== undefined ? { base: opts.base } : {}),
      ...(opts.head !== undefined ? { head: opts.head } : {}),
      ...(opts.depth !== undefined ? { depth: opts.depth } : {}),
      ...(opts.minConfidence !== undefined ? { minConfidence: opts.minConfidence } : {}),
      ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
      ...(opts.includeTestsInSubgraph !== undefined
        ? { includeTestsInSubgraph: opts.includeTestsInSubgraph }
        : {}),
    };
    const pack = await run(store.graph, query);

    if (opts.json) {
      console.log(JSON.stringify(pack, null, 2));
    } else {
      const { changedFiles, changedSymbols, impactedSubgraph, verdict, affectedTests } = pack;
      console.log(
        `change-pack: ${changedFiles.length} file(s), ${changedSymbols.length} symbol(s) changed. Verdict: ${verdict.verdict}.`,
      );
      const truncatedNote = impactedSubgraph.truncated ? " (truncated)" : "";
      console.log(
        `Impacted subgraph: ${impactedSubgraph.nodeCount} node(s), ${impactedSubgraph.edgeCount} edge(s)${truncatedNote}.`,
      );
      const lead = verdict.reasoningChain[0];
      if (lead !== undefined) {
        console.log(`Verdict reasoning: ${lead.label} = ${lead.value} [${lead.severity}]`);
      }
      if (changedFiles.length > 0) {
        console.log("Changed files:");
        for (const f of changedFiles.slice(0, 30)) console.log(`  • ${f}`);
        if (changedFiles.length > 30) {
          console.log(`  … ${changedFiles.length - 30} more`);
        }
      }
      if (affectedTests.length > 0) {
        console.log(`Affected tests (${affectedTests.length}):`);
        for (const t of affectedTests.slice(0, 30)) {
          console.log(`  • ${t.name} — ${t.filePath}`);
        }
        if (affectedTests.length > 30) {
          console.log(`  … ${affectedTests.length - 30} more`);
        }
      }
      const cost = pack.costAttribution;
      console.log(
        `Tokens saved: ${cost.tokensSaved} (${cost.tokensSavedPct}%) vs blind read [${cost.tokenizerModel}]; CI tests skippable: ${cost.ciTestsSkipped}/${cost.totalTestCount}`,
      );
    }

    // Reuse the verdict's own 0|1|2 exit code so CI gate semantics match
    // `codehub verdict` exactly — set in both the JSON and summary paths.
    process.exitCode = pack.verdict.exitCode;
  } finally {
    await store.close();
  }
}
