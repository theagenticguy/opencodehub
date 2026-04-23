/**
 * `codehub wiki` — emit a graph-only Markdown wiki.
 *
 * Opens the graph store for the resolved repo (via the shared open-store
 * helper), delegates to `@opencodehub/analysis`' `generateWiki`, and reports
 * the number of files written and total bytes on stdout.
 */

import { generateWiki } from "@opencodehub/analysis";
import { openStoreForCommand } from "./open-store.js";

export interface WikiCommandOptions {
  readonly output: string;
  readonly repo?: string;
  readonly home?: string;
  readonly json?: boolean;
}

export async function runWiki(opts: WikiCommandOptions): Promise<void> {
  const { store, repoPath } = await openStoreForCommand({
    ...(opts.repo !== undefined ? { repo: opts.repo } : {}),
    ...(opts.home !== undefined ? { home: opts.home } : {}),
  });
  try {
    const result = await generateWiki(store, {
      outputDir: opts.output,
      repoPath,
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
