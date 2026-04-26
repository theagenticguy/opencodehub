/**
 * `codehub detect-changes` — map a git diff onto affected graph symbols.
 *
 * Delegates to `@opencodehub/analysis.runDetectChanges`. The CLI layer
 * only resolves the scope flag, runs git against the repo, and formats
 * the result. Useful from CI (GitHub Actions, GitLab CI) without
 * launching the MCP server.
 *
 * Exit codes:
 *   0 — diff produced zero affected symbols (risk: LOW or empty diff).
 *   1 — diff produced HIGH or CRITICAL risk. Operators configure CI
 *       gates to fail on non-zero.
 *   Any risk tier MEDIUM or below stays on exit 0 so informational runs
 *   are non-blocking.
 */

import { runDetectChanges } from "@opencodehub/analysis";
import { openStoreForCommand } from "./open-store.js";

export interface DetectChangesOptions {
  readonly scope?: "unstaged" | "staged" | "all" | "compare";
  readonly compareRef?: string;
  readonly repo?: string;
  readonly home?: string;
  readonly json?: boolean;
  /** When true, fail (exit 1) on any non-LOW risk. Default: HIGH+CRIT only. */
  readonly strict?: boolean;
}

export async function runDetectChangesCmd(opts: DetectChangesOptions = {}): Promise<void> {
  const scope = opts.scope ?? "all";
  if (scope === "compare" && (opts.compareRef === undefined || opts.compareRef.length === 0)) {
    console.error(
      "codehub detect-changes: --scope=compare requires --compare-ref <git-ref> (e.g. origin/main)",
    );
    process.exitCode = 2;
    return;
  }

  const { store, repoPath } = await openStoreForCommand(opts);
  try {
    const q: {
      scope: "unstaged" | "staged" | "all" | "compare";
      repoPath: string;
      compareRef?: string;
    } = { scope, repoPath };
    if (opts.compareRef !== undefined) q.compareRef = opts.compareRef;
    const result = await runDetectChanges(store, q);

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const { summary, changedFiles, affectedSymbols, affectedProcesses } = result;
      console.log(
        `detect-changes: ${summary.fileCount} file(s), ${summary.symbolCount} symbol(s), ${summary.processCount} process(es) affected. Risk: ${summary.risk}.`,
      );
      if (changedFiles.length > 0) {
        console.log("Changed files:");
        for (const f of changedFiles.slice(0, 30)) console.log(`  • ${f}`);
        if (changedFiles.length > 30) {
          console.log(`  … ${changedFiles.length - 30} more`);
        }
      }
      if (affectedSymbols.length > 0) {
        console.log(`Affected symbols (${affectedSymbols.length}):`);
        for (const s of affectedSymbols.slice(0, 50)) {
          console.log(`  • ${s.name} [${s.kind}] — ${s.filePath}`);
        }
        if (affectedSymbols.length > 50) {
          console.log(`  … ${affectedSymbols.length - 50} more`);
        }
      }
      if (affectedProcesses.length > 0) {
        console.log(`Affected processes (${affectedProcesses.length}):`);
        for (const p of affectedProcesses) {
          console.log(`  ⊿ ${p.name} — ${p.entryPointFile}`);
        }
      }
    }

    const risk = result.summary.risk;
    const blockOn: ReadonlySet<string> = opts.strict
      ? new Set(["MEDIUM", "HIGH", "CRITICAL"])
      : new Set(["HIGH", "CRITICAL"]);
    if (blockOn.has(risk)) {
      process.exitCode = 1;
    }
  } finally {
    await store.close();
  }
}
