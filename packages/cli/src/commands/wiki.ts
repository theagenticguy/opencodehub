/**
 * `codehub wiki` — emit a graph-only Markdown wiki (default) or, with `--llm`,
 * route the top-ranked modules through `@opencodehub/summarizer`'s Bedrock
 * Converse client to generate narrative prose.
 *
 * Gating rules (mirrored in `@opencodehub/analysis`):
 *   - `--llm` absent: exact existing behavior (deterministic, no network).
 *   - `--llm` + `--offline`: hard error. The summarizer requires network.
 *   - `--llm --max-llm-calls 0`: dry-run — enumerate candidate modules but
 *     never contact Bedrock.
 *   - `--llm --max-llm-calls <n>`: call the summarizer for the top N modules
 *     by symbolCount. Per-module failures fall back to a deterministic
 *     substitute for that module without aborting the run.
 */

import { computeRiskTrends, loadSnapshots } from "@opencodehub/analysis";
import { generateWiki, type WikiLlmOptions } from "@opencodehub/wiki";
import { openStoreForCommand } from "./open-store.js";

export interface WikiCommandOptions {
  readonly output: string;
  readonly repo?: string;
  readonly home?: string;
  readonly json?: boolean;
  readonly offline?: boolean;
  readonly llm?: boolean;
  readonly maxLlmCalls?: number;
  readonly llmModel?: string;
}

export async function runWiki(opts: WikiCommandOptions): Promise<void> {
  const llmRequested = opts.llm === true;
  if (llmRequested && opts.offline === true) {
    throw new Error("codehub wiki: --llm requires network access; remove --offline or drop --llm");
  }

  const { store, repoPath } = await openStoreForCommand({
    ...(opts.repo !== undefined ? { repo: opts.repo } : {}),
    ...(opts.home !== undefined ? { home: opts.home } : {}),
  });
  try {
    const maxLlmCalls = Math.max(
      0,
      typeof opts.maxLlmCalls === "number" && Number.isFinite(opts.maxLlmCalls)
        ? Math.floor(opts.maxLlmCalls)
        : 0,
    );
    const llm: WikiLlmOptions | undefined = llmRequested
      ? {
          enabled: true,
          maxCalls: maxLlmCalls,
          ...(opts.llmModel !== undefined ? { modelId: opts.llmModel } : {}),
        }
      : undefined;
    const result = await generateWiki(store, {
      outputDir: opts.output,
      repoPath,
      loadTrends: async (p) => computeRiskTrends(await loadSnapshots(p)),
      ...(llm !== undefined ? { llm } : {}),
    });
    if (opts.json === true) {
      console.log(
        JSON.stringify(
          {
            outputDir: opts.output,
            fileCount: result.filesWritten.length,
            totalBytes: result.totalBytes,
            files: result.filesWritten,
            llm:
              llm === undefined
                ? { enabled: false }
                : {
                    enabled: true,
                    maxCalls: llm.maxCalls,
                    ...(llm.modelId !== undefined ? { modelId: llm.modelId } : {}),
                    dryRun: llm.maxCalls === 0,
                  },
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
    if (llm !== undefined) {
      const mode = llm.maxCalls === 0 ? "dry-run (0 calls)" : `cap ${llm.maxCalls}`;
      console.warn(`wiki: llm mode active — ${mode}`);
    }
    for (const f of result.filesWritten) {
      console.log(f);
    }
  } finally {
    await store.close();
  }
}
