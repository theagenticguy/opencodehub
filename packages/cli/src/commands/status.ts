/**
 * `codehub status [path]` — show the recorded index state for a repo.
 *
 * Reads `<repo>/.codehub/meta.json` and prints schemaVersion, lastCommit,
 * node/edge counts, and a best-effort staleness envelope. Staleness is
 * computed by `@opencodehub/analysis` when available; otherwise we fall back
 * to a simple `lastCommit` / registry check.
 */

import { resolve } from "node:path";
import { computeStaleness } from "@opencodehub/analysis";
import { embeddingsPopulated } from "@opencodehub/search";
import { readStoreMeta } from "@opencodehub/storage";
import { listGroups } from "../groups.js";
import { readRegistry } from "../registry.js";
import { openStoreForCommand } from "./open-store.js";

/**
 * Retrieval-mode probe result for the status output. `summaries` is the count
 * of distinct nodes with an LLM summary (dense-leg input); `vectors` reports
 * whether the embeddings table is populated. Both are best-effort: a degraded
 * or absent store yields `summaries: null`.
 */
export interface RetrievalState {
  readonly summaries: number | null;
  readonly vectors: "populated" | "bm25-only";
}

export interface StatusOptions {
  readonly home?: string;
  /**
   * Test seam: open a read-only store and return its retrieval state. Defaults
   * to opening the real composed store. Tests inject a stub so they don't need
   * a live store.sqlite on disk.
   */
  readonly probeRetrieval?: (repoPath: string) => Promise<RetrievalState | undefined>;
}

async function defaultProbeRetrieval(repoPath: string): Promise<RetrievalState | undefined> {
  let store: Awaited<ReturnType<typeof openStoreForCommand>>["store"] | undefined;
  try {
    const opened = await openStoreForCommand({ repo: repoPath, readOnly: true });
    store = opened.store;
    const summaries = await store.temporal.countSymbolSummaries();
    const populated = await embeddingsPopulated(store.graph);
    return { summaries, vectors: populated ? "populated" : "bm25-only" };
  } catch {
    // No index / degraded store / missing binding — caller degrades the
    // output rather than failing the whole status command.
    return undefined;
  } finally {
    await store?.close();
  }
}

export async function runStatus(path: string, opts: StatusOptions = {}): Promise<void> {
  const repoPath = resolve(path);
  const meta = await readStoreMeta(repoPath);
  if (!meta) {
    console.warn(`No index found at ${repoPath}. Run \`codehub analyze\`.`);
    return;
  }

  const registryOpts = opts.home !== undefined ? { home: opts.home } : {};
  const registry = await readRegistry(registryOpts);
  const registryHit = Object.values(registry).find((e) => resolve(e.path) === repoPath);

  console.log(`path:           ${repoPath}`);
  console.log(`schemaVersion:  ${meta.schemaVersion}`);
  console.log(`indexedAt:      ${meta.indexedAt}`);
  console.log(`lastCommit:     ${meta.lastCommit ?? "-"}`);
  console.log(`nodes:          ${meta.nodeCount}`);
  console.log(`edges:          ${meta.edgeCount}`);

  // Retrieval mode. `query` runs BM25-only unless the embeddings table is
  // populated AND the active embedder's modelId matches `meta.embedderModelId`
  // — so report the embedder id from meta (no second probe) alongside the
  // vector state, instead of implying hybrid will fire. Summaries are a
  // distinct table (dense-leg context), not what gates BM25-vs-hybrid; we
  // surface the count so an empty-summaries index is visible.
  const probe = opts.probeRetrieval ?? defaultProbeRetrieval;
  const retrieval = await probe(repoPath);
  if (retrieval === undefined) {
    console.log("summaries:      -");
    console.log("vectors:        unknown");
  } else {
    console.log(`summaries:      ${retrieval.summaries ?? "-"}`);
    console.log(`vectors:        ${retrieval.vectors}`);
  }
  console.log(`embedder:       ${meta.embedderModelId ?? "none"}`);

  if (registryHit === undefined) {
    console.log("registry:       missing — run `codehub analyze` to re-register");
  } else {
    console.log("registry:       ok");
  }

  // Surface every group the current repo belongs to, alphabetically.
  if (registryHit !== undefined) {
    const groups = await listGroups(registryOpts);
    const memberOf = groups
      .filter((g) => g.repos.some((r) => r.name === registryHit.name))
      .map((g) => g.name)
      .sort();
    console.log(`groups:         ${memberOf.length > 0 ? memberOf.join(", ") : "(none)"}`);
  }

  // Optional deeper staleness check via @opencodehub/analysis if wired.
  const staleness = await tryComputeStaleness(repoPath, meta.lastCommit);
  if (staleness !== undefined) {
    console.log(`stale:          ${staleness.isStale ? "yes" : "no"}`);
    if (staleness.hint) {
      console.log(`hint:           ${staleness.hint}`);
    }
  }
}

async function tryComputeStaleness(
  repoPath: string,
  lastCommit: string | undefined,
): Promise<{ isStale: boolean; hint?: string } | undefined> {
  // `@opencodehub/analysis` is bundled into this CLI (workspace libs are
  // inlined at build time), so a static import is correct. Staleness is still
  // best-effort: a git failure inside computeStaleness should not fail status.
  try {
    return await computeStaleness(repoPath, lastCommit);
  } catch {
    return undefined;
  }
}
