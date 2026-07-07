/**
 * `codehub wiki` — emit a graph-only Markdown wiki.
 *
 * Fully deterministic: renders the 5 page families plus a top-level index
 * from the persisted graph. No network, no clock, no LLM calls — two runs
 * against the same graph produce byte-identical output.
 */

import { computeRiskTrends, loadSnapshots } from "@opencodehub/analysis";
import { generateWiki } from "@opencodehub/wiki";
import { openStoreForCommand } from "./open-store.js";

export interface WikiCommandOptions {
  readonly output: string;
  readonly repo?: string;
  readonly home?: string;
  readonly json?: boolean;
  readonly offline?: boolean;
}

export async function runWiki(opts: WikiCommandOptions): Promise<void> {
  const { store, repoPath } = await openStoreForCommand({
    ...(opts.repo !== undefined ? { repo: opts.repo } : {}),
    ...(opts.home !== undefined ? { home: opts.home } : {}),
  });
  try {
    const result = await generateWiki(store.graph, {
      outputDir: opts.output,
      repoPath,
      loadTrends: async (p) => computeRiskTrends(await loadSnapshots(p)),
    });
    if (opts.json === true) {
      console.log(
        JSON.stringify(
          {
            outputDir: opts.output,
            fileCount: result.filesWritten.length,
            totalBytes: result.totalBytes,
            files: result.filesWritten,
          },
          null,
          2,
        ),
      );
      return;
    }
    console.warn(
      `wiki: wrote ${result.filesWritten.length} files (${result.totalBytes} bytes) to ${opts.output}`,
    );
    for (const f of result.filesWritten) {
      console.log(f);
    }
  } finally {
    await store.close();
  }
}
