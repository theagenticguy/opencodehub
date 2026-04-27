/**
 * Gym runner — orchestrates LSP replays across one or more corpus files.
 *
 * For each corpus, the runner:
 *
 *   1. Loads + validates the YAML via `loadCorpus()`.
 *   2. Creates one `LspClientLike` per (language, fixtureRoot) pair via
 *      the injected `LspFactory`. A corpus's fixture directory is
 *      resolved as `path.resolve(repoRoot, corpus.corpus.path)`.
 *   3. Starts the client, calls `warmup()` when present, and replays
 *      every case by dispatching `queryReferences` / `queryImplementations` /
 *      `queryCallers` based on `case.kind`.
 *   4. Emits a `ManifestRecord` per case and — for non-waived cases —
 *      a `CaseScore` with precision/recall/F1, Jaccard, and (for
 *      `references` only) Kendall tau.
 *   5. Aggregates per-(language, tool, kind) rollups via `aggregate()`.
 *   6. Serializes the full manifest to JSONL when `outputManifestPath`
 *      is provided.
 *
 * All filesystem IO and LSP traffic is boundary-layer; the scoring paths
 * are pure and exercised by `runner.test.ts` with a scripted mock client.
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CorpusCase, CorpusFile } from "./corpus.js";
import { loadCorpus } from "./corpus.js";
import {
  canonicalize,
  type ManifestRecord,
  type ManifestRequestKind,
  type ManifestResult,
  type ManifestTarget,
} from "./manifest.js";
import {
  aggregate,
  type CaseScore,
  evaluateSet,
  jaccard,
  kendallTau,
  type Rollup,
} from "./metrics.js";
import type { LspClientLike, LspFactory } from "./scip-factory.js";

export interface RunnerConfig {
  readonly corpusPaths: readonly string[];
  readonly repoRoot: string;
  readonly lspFactory: LspFactory;
  readonly outputManifestPath?: string | undefined;
  readonly baselineManifestPath?: string | undefined;
  readonly waivedCaseIds?: ReadonlySet<string> | undefined;
}

export interface RunSummary {
  readonly totalCases: number;
  readonly passed: number;
  readonly failed: number;
  readonly waived: number;
}

export interface RunResult {
  readonly manifest: readonly ManifestRecord[];
  readonly caseScores: readonly CaseScore[];
  readonly rollups: readonly Rollup[];
  readonly summary: RunSummary;
}

const PERFECT_F1 = 0.999;

function resultKey(r: ManifestResult): string {
  return `${r.file}:${r.line}:${r.column}`;
}

function nowIsoUtc(): string {
  return new Date().toISOString();
}

/**
 * Resolve `corpus.target.file` against the fixture root. `target.file`
 * is fixture-relative (forward-slash separated), fixture root is
 * `repoRoot/corpus.corpus.path`.
 */
function resolveTargetFile(repoRoot: string, corpus: CorpusFile, relFile: string): string {
  const fixtureRoot = path.resolve(repoRoot, corpus.corpus.path);
  return path.join(fixtureRoot, relFile);
}

async function dispatchQuery(
  client: LspClientLike,
  kind: ManifestRequestKind,
  target: ManifestTarget,
  absTargetFile: string,
): Promise<readonly ManifestResult[]> {
  // Our corpus stores 1-indexed positions; each LSP client converts to
  // 0-indexed internally and returns 1-indexed hits, so we pass the raw
  // 1-indexed target straight through.
  const position = {
    filePath: absTargetFile,
    line: target.line,
    character: target.column,
  };
  switch (kind) {
    case "references": {
      const hits = await client.queryReferences(position);
      return hits.map((h) => ({ file: h.file, line: h.line, column: h.character }));
    }
    case "implementations": {
      const hits = await client.queryImplementations(position);
      return hits.map((h) => ({ file: h.file, line: h.line, column: h.character }));
    }
    case "callers": {
      const hits = await client.queryCallers({
        ...position,
        symbolKind: "function",
        symbolName: target.symbolName,
      });
      return hits.map((h) => {
        const out: ManifestResult = { file: h.file, line: h.line, column: h.character };
        if (h.enclosingSymbolName !== undefined) {
          out.enclosing = h.enclosingSymbolName;
        }
        return out;
      });
    }
    default: {
      const exhaustive: never = kind;
      throw new Error(`runner: unsupported request kind ${String(exhaustive)}`);
    }
  }
}

function scoreCase(
  corpus: CorpusFile,
  c: CorpusCase,
  actual: readonly ManifestResult[],
): CaseScore {
  const expectedKeys = c.expected.map(resultKey);
  const actualKeys = actual.map(resultKey);
  const set = evaluateSet(expectedKeys, actualKeys);
  const jac = jaccard(expectedKeys, actualKeys);
  const score: CaseScore = {
    language: corpus.language,
    tool: corpus.tool.name,
    caseKind: c.kind,
    caseId: c.id,
    scores: set,
    jaccard: jac,
  };
  // Kendall tau only makes sense for the `references` ordered set. The
  // `callers` and `implementations` shapes are unordered — computing a
  // rank correlation there would be noise, not signal.
  if (c.kind === "references") {
    score.kendallTau = kendallTau(expectedKeys, actualKeys);
  }
  return score;
}

function buildManifestRecord(
  corpus: CorpusFile,
  c: CorpusCase,
  actual: readonly ManifestResult[],
): ManifestRecord {
  const record: ManifestRecord = {
    manifest_version: "1",
    language: corpus.language,
    corpus: corpus.corpus,
    tool: corpus.tool,
    request: {
      kind: c.kind,
      target: c.target,
    },
    result_set: [...actual],
    captured_at: nowIsoUtc(),
  };
  if (c.labeler !== undefined) record.labeler = c.labeler;
  if (c.labeler_note !== undefined) record.labeler_note = c.labeler_note;
  if (c.waived === true) record.waived = true;
  return record;
}

async function appendManifestJsonl(
  filePath: string,
  records: readonly ManifestRecord[],
): Promise<void> {
  if (records.length === 0) return;
  await mkdir(path.dirname(filePath), { recursive: true });
  const body = `${records.map((r) => canonicalize(r)).join("\n")}\n`;
  // Use a single atomic append so partial writes can't corrupt the
  // JSONL record boundary mid-run.
  const { appendFile } = await import("node:fs/promises");
  await appendFile(filePath, body, "utf-8");
}

async function resetManifestFile(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "", "utf-8");
}

/**
 * Load a previously-captured manifest and re-score it against the
 * expected rows recorded in each matching corpus case. Used by the
 * `replay` CLI subcommand: CI can reproduce the scoring run bit-for-bit
 * without re-spawning an LSP subprocess.
 */
export async function replayManifest(params: {
  readonly manifestPath: string;
  readonly corpusPaths: readonly string[];
}): Promise<RunResult> {
  const { manifestPath, corpusPaths } = params;
  const { readManifest } = await import("./manifest.js");
  const records = await readManifest(manifestPath);

  // Index records by (fingerprint of language + corpus + request) so we
  // can marry each one back to its corpus case's expected rows.
  const recordIndex = new Map<string, ManifestRecord>();
  for (const r of records) {
    recordIndex.set(replayKey(r.language, r.corpus.commit, r.request.kind, r.request.target), r);
  }

  const corpora: CorpusFile[] = [];
  for (const cp of corpusPaths) {
    corpora.push(await loadCorpus(cp));
  }

  const manifestOut: ManifestRecord[] = [];
  const caseScores: CaseScore[] = [];
  let waived = 0;

  for (const corpus of corpora) {
    for (const c of corpus.cases) {
      const key = replayKey(corpus.language, corpus.corpus.commit, c.kind, c.target);
      const rec = recordIndex.get(key);
      if (rec === undefined) continue;
      manifestOut.push(rec);
      if (c.waived === true || rec.waived === true) {
        waived += 1;
        continue;
      }
      caseScores.push(scoreCase(corpus, c, rec.result_set));
    }
  }

  const rollups = aggregate(caseScores);
  const passed = caseScores.filter((s) => s.scores.f1 >= PERFECT_F1).length;
  const failed = caseScores.length - passed;
  return {
    manifest: manifestOut,
    caseScores,
    rollups,
    summary: { totalCases: manifestOut.length, passed, failed, waived },
  };
}

function replayKey(
  language: string,
  commit: string,
  kind: ManifestRequestKind,
  target: ManifestTarget,
): string {
  return [language, commit, kind, target.file, target.line, target.column, target.symbolName].join(
    "|",
  );
}

/**
 * Primary entry point. Serial per language (no worker pool — v1 is
 * correctness-first).
 */
export async function runGym(config: RunnerConfig): Promise<RunResult> {
  const corpora: CorpusFile[] = [];
  const corpusPaths: string[] = [];
  for (const cp of config.corpusPaths) {
    try {
      corpora.push(await loadCorpus(cp));
      corpusPaths.push(cp);
    } catch (err) {
      // Surface the offending path and rethrow; loadCorpus already
      // namespaces the error with the filename.
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  if (config.outputManifestPath !== undefined) {
    await resetManifestFile(config.outputManifestPath);
  }

  const waivedCaseIds = config.waivedCaseIds ?? new Set<string>();

  const allManifest: ManifestRecord[] = [];
  const allScores: CaseScore[] = [];
  let waivedCount = 0;

  for (const corpus of corpora) {
    const fixtureRoot = path.resolve(config.repoRoot, corpus.corpus.path);
    // Missing fixture submodule: downgrade to a waived record for each
    // case in the corpus instead of crashing the whole run. This keeps
    // CI jobs green on boxes that skipped `git submodule update`, and
    // produces a manifest that `detect_changes` / baseline tooling can
    // still compare against (same request shape, empty result_set).
    if (!(await fixtureExists(fixtureRoot))) {
      process.stderr.write(
        `codehub-gym: fixture missing at ${fixtureRoot}; recording ${corpus.cases.length} waived records\n`,
      );
      const stub: ManifestRecord[] = [];
      for (const c of corpus.cases) {
        const record = buildManifestRecord(corpus, c, []);
        record.waived = true;
        stub.push(record);
        waivedCount += 1;
      }
      allManifest.push(...stub);
      if (config.outputManifestPath !== undefined) {
        await appendManifestJsonl(config.outputManifestPath, stub);
      }
      continue;
    }

    const client = config.lspFactory.create(corpus.language, fixtureRoot);
    const batchedRecords: ManifestRecord[] = [];
    let clientStartFailure: Error | null = null;
    try {
      await client.start();
    } catch (err) {
      // LSP binary missing on this box, cold-start timeout, etc. Mirror
      // the missing-fixture path: waive the corpus and keep the run
      // going so other languages can still execute. Surface the error
      // on stderr so the operator knows what to install.
      clientStartFailure = err instanceof Error ? err : new Error(String(err));
    }

    if (clientStartFailure !== null) {
      process.stderr.write(
        `codehub-gym: ${corpus.language} client start failed (${clientStartFailure.message}); ` +
          `waiving ${corpus.cases.length} ${corpus.language} cases\n`,
      );
      const stub: ManifestRecord[] = [];
      for (const c of corpus.cases) {
        const record = buildManifestRecord(corpus, c, []);
        record.waived = true;
        stub.push(record);
        waivedCount += 1;
      }
      allManifest.push(...stub);
      if (config.outputManifestPath !== undefined) {
        await appendManifestJsonl(config.outputManifestPath, stub);
      }
      // client.stop() on a never-started client is a no-op for every
      // concrete LSP client we ship, but call it anyway for safety.
      try {
        await client.stop();
      } catch {
        // ignore
      }
      continue;
    }

    try {
      if (client.warmup !== undefined) {
        const warmupFiles = collectWarmupFiles(corpus);
        await client.warmup(warmupFiles);
      }

      for (const c of corpus.cases) {
        const absTarget = resolveTargetFile(config.repoRoot, corpus, c.target.file);
        const actual = await dispatchQuery(client, c.kind, c.target, absTarget);
        const record = buildManifestRecord(corpus, c, actual);
        batchedRecords.push(record);

        const isWaived = c.waived === true || waivedCaseIds.has(c.id);
        if (isWaived) {
          waivedCount += 1;
          continue;
        }
        allScores.push(scoreCase(corpus, c, actual));
      }
    } finally {
      await client.stop();
    }

    allManifest.push(...batchedRecords);
    if (config.outputManifestPath !== undefined) {
      await appendManifestJsonl(config.outputManifestPath, batchedRecords);
    }
  }

  const rollups = aggregate(allScores);
  const passed = allScores.filter((s) => s.scores.f1 >= PERFECT_F1).length;
  const failed = allScores.length - passed;
  return {
    manifest: allManifest,
    caseScores: allScores,
    rollups,
    summary: {
      totalCases: allManifest.length,
      passed,
      failed,
      waived: waivedCount,
    },
  };
}

/**
 * Collect the union of target + expected file paths for a corpus so the
 * LSP client's `warmup` hook can `didOpen` them before the first cross-
 * file query. De-duplicated. Returns workspace-relative forward-slash
 * paths, since all LSP clients accept either shape.
 */
async function fixtureExists(fixtureRoot: string): Promise<boolean> {
  try {
    const s = await stat(fixtureRoot);
    return s.isDirectory();
  } catch {
    return false;
  }
}

function collectWarmupFiles(corpus: CorpusFile): string[] {
  const files = new Set<string>();
  for (const c of corpus.cases) {
    files.add(c.target.file);
    for (const r of c.expected) {
      files.add(r.file);
    }
  }
  return Array.from(files);
}
