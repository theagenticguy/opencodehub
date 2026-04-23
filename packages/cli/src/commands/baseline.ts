/**
 * `codehub baseline` — freeze a SARIF snapshot as the audit baseline and
 * diff a subsequent scan against it.
 *
 * Subcommands:
 *   - freeze [--from <path>]
 *       Copies the latest scan log (default: `.codehub/scan.sarif` or the
 *       explicit `--from`) to `.codehub/baseline.sarif`. The copy is
 *       validated against the SARIF 2.1.0 schema on the way through so
 *       corrupt logs cannot poison a baseline.
 *
 *   - diff [--baseline <path>] [--current <path>] [--exit-code] [--json]
 *       Buckets the results into new / fixed / unchanged / updated by
 *       `partialFingerprints["opencodehub/v1"]` via `diffSarif`. Prints a
 *       one-line summary by default, or a JSON payload with `--json`.
 *       With `--exit-code`, exits 1 iff the `new` bucket is non-empty.
 *
 * Both subcommands resolve paths relative to `repoPath` (default: CWD,
 * or the registered repo via `--repo`).
 */

import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type DiffResult, diffSarif, type SarifLog, SarifLogSchema } from "@opencodehub/sarif";
import { resolveRepoMetaDir } from "@opencodehub/storage";
import { writeFileAtomic } from "../fs-atomic.js";
import { readRegistry } from "../registry.js";

export interface BaselineCommonOptions {
  /** `--repo <name>`: look up a registered repo instead of using `path`. */
  readonly repo?: string;
  /** Test hook — override registry home. */
  readonly home?: string;
}

export interface BaselineFreezeOptions extends BaselineCommonOptions {
  /** Source SARIF path. Defaults to `<repo>/.codehub/scan.sarif`. */
  readonly from?: string;
  /** Destination path. Defaults to `<repo>/.codehub/baseline.sarif`. */
  readonly to?: string;
}

export interface BaselineFreezeSummary {
  readonly from: string;
  readonly to: string;
  readonly runCount: number;
  readonly resultCount: number;
}

export interface BaselineDiffOptions extends BaselineCommonOptions {
  /** Baseline SARIF path. Defaults to `<repo>/.codehub/baseline.sarif`. */
  readonly baseline?: string;
  /** Current SARIF path. Defaults to `<repo>/.codehub/scan.sarif`. */
  readonly current?: string;
  /** When true, exit 1 iff the `new` bucket is non-empty. */
  readonly exitCode?: boolean;
  /** When true, emit JSON payload on stdout instead of the summary line. */
  readonly json?: boolean;
}

export interface BaselineDiffSummary {
  readonly baseline: string;
  readonly current: string;
  readonly counts: {
    readonly new: number;
    readonly fixed: number;
    readonly unchanged: number;
    readonly updated: number;
  };
  readonly exitCode: 0 | 1;
}

async function resolveRepoPath(path: string, opts: BaselineCommonOptions): Promise<string> {
  if (opts.repo !== undefined) {
    const registryOpts = opts.home !== undefined ? { home: opts.home } : {};
    const registry = await readRegistry(registryOpts);
    const hit = registry[opts.repo];
    if (hit) return resolve(hit.path);
    return resolve(opts.repo);
  }
  return resolve(path);
}

async function readValidatedSarif(path: string): Promise<SarifLog> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const result = SarifLogSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `codehub baseline: ${path} is not a valid SARIF 2.1.0 log: ${result.error.message}`,
    );
  }
  return result.data;
}

function countResults(log: SarifLog): number {
  let total = 0;
  for (const run of log.runs) {
    total += run.results?.length ?? 0;
  }
  return total;
}

export async function runBaselineFreeze(
  path: string,
  opts: BaselineFreezeOptions = {},
): Promise<BaselineFreezeSummary> {
  const repoPath = await resolveRepoPath(path, opts);
  const metaDir = resolveRepoMetaDir(repoPath);
  const fromPath = resolve(opts.from ?? `${metaDir}/scan.sarif`);
  const toPath = resolve(opts.to ?? `${metaDir}/baseline.sarif`);

  const log = await readValidatedSarif(fromPath);
  await mkdir(metaDir, { recursive: true });
  await writeFileAtomic(toPath, `${JSON.stringify(log, null, 2)}\n`, { raw: true });

  const runCount = log.runs.length;
  const resultCount = countResults(log);
  console.warn(
    `codehub baseline: froze ${fromPath} → ${toPath} (${runCount} run(s), ${resultCount} result(s))`,
  );
  return { from: fromPath, to: toPath, runCount, resultCount };
}

export async function runBaselineDiff(
  path: string,
  opts: BaselineDiffOptions = {},
): Promise<BaselineDiffSummary> {
  const repoPath = await resolveRepoPath(path, opts);
  const metaDir = resolveRepoMetaDir(repoPath);
  const baselinePath = resolve(opts.baseline ?? `${metaDir}/baseline.sarif`);
  const currentPath = resolve(opts.current ?? `${metaDir}/scan.sarif`);

  const [baseline, current] = await Promise.all([
    readValidatedSarif(baselinePath),
    readValidatedSarif(currentPath),
  ]);
  const diff = diffSarif(baseline, current);
  const counts = {
    new: diff.new.length,
    fixed: diff.fixed.length,
    unchanged: diff.unchanged.length,
    updated: diff.updated.length,
  } as const;

  const exitCode: 0 | 1 = opts.exitCode === true && counts.new > 0 ? 1 : 0;

  if (opts.json === true) {
    const payload = {
      baseline: baselinePath,
      current: currentPath,
      counts,
      new: diff.new,
      fixed: diff.fixed,
      updated: diff.updated,
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(
      `${counts.new} new, ${counts.fixed} fixed, ${counts.unchanged} unchanged, ${counts.updated} updated\n`,
    );
  }

  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }

  return { baseline: baselinePath, current: currentPath, counts, exitCode };
}

/**
 * Return a DiffResult without any CLI side effects. Exposed so other
 * commands (scan) can reuse the bucketing logic without re-reading files.
 */
export function computeBaselineDiff(baseline: SarifLog, current: SarifLog): DiffResult {
  return diffSarif(baseline, current);
}
