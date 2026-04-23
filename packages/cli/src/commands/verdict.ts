/**
 * `codehub verdict` — 5-tier PR verdict CLI.
 */

import {
  computeVerdict,
  type VerdictConfig,
  type VerdictQuery,
  type VerdictResponse,
} from "@opencodehub/analysis";
import type { IGraphStore } from "@opencodehub/storage";
import { openStoreForCommand } from "./open-store.js";
import { cliExitCodeForTier, renderJson, renderMarkdown, renderSummary } from "./verdict-render.js";

export type VerdictOutputFormat = "markdown" | "json" | "summary";

export interface VerdictCliOptions {
  readonly base?: string;
  readonly head?: string;
  readonly repo?: string;
  readonly home?: string;
  readonly outputFormat?: VerdictOutputFormat;
  readonly prComment?: boolean;
  readonly exitCode?: boolean;
  readonly json?: boolean;
  readonly configOverrides?: Partial<VerdictConfig>;
  readonly storeFactory?: () => Promise<{ store: IGraphStore; repoPath: string }>;
  readonly computeVerdictFn?: (store: IGraphStore, query: VerdictQuery) => Promise<VerdictResponse>;
}

export interface ResolvedVerdictMode {
  readonly format: VerdictOutputFormat;
  readonly exitCode: boolean;
}

/**
 * Resolve raw CLI flags to effective mode. `--pr-comment` implies markdown +
 * exit-code. `--json` is a backward-compat alias for `--output-format json`.
 */
export function resolveVerdictMode(opts: VerdictCliOptions): ResolvedVerdictMode {
  if (opts.prComment === true) {
    return { format: "markdown", exitCode: true };
  }
  const explicit = opts.outputFormat;
  const format: VerdictOutputFormat = explicit ?? (opts.json === true ? "json" : "summary");
  // Default exit-code policy: on for summary (interactive + CI ergonomic),
  // off for json and explicit markdown (backward compat for scripts that
  // parse the output and manage their own exit).
  const defaultExit = format === "summary";
  const exitCode = opts.exitCode === true ? true : opts.exitCode === false ? false : defaultExit;
  return { format, exitCode };
}

export async function runVerdict(opts: VerdictCliOptions = {}): Promise<void> {
  const mode = resolveVerdictMode(opts);
  const factory = opts.storeFactory ?? (() => openStoreForCommand(opts));
  const { store, repoPath } = await factory();
  const compute = opts.computeVerdictFn ?? computeVerdict;
  try {
    const query: VerdictQuery = {
      repoPath,
      ...(opts.base !== undefined ? { base: opts.base } : {}),
      ...(opts.head !== undefined ? { head: opts.head } : {}),
      ...(opts.configOverrides !== undefined ? { config: opts.configOverrides } : {}),
    };
    const verdict = await compute(store, query);
    const output =
      mode.format === "json"
        ? renderJson(verdict)
        : mode.format === "markdown"
          ? renderMarkdown(verdict)
          : renderSummary(verdict);
    process.stdout.write(`${output}\n`);
    if (mode.exitCode) {
      process.exitCode = cliExitCodeForTier(verdict.verdict);
    }
  } finally {
    await store.close();
  }
}
