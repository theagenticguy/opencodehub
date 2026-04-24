/**
 * Temporal phase — derives 12 per-file git signals from two shared `git log`
 * subprocesses plus one optional branch-divergence pass.
 *
 * Pipeline position: depends on `scan` only; runs in parallel with other
 * structural phases. Mutates the shared KnowledgeGraph by looking up each
 * scanned File node and cloning it with the 12 temporal properties attached.
 *
 * Design constraints:
 *   - Subprocess budget ≤3 (main log dump, name-status dump, branch pass).
 *     Per-file `git log --follow` for signal 9 is opt-in; when enabled it
 *     breaks the budget — we cap it at `maxRenameFollowFiles` to bound cost.
 *   - Fail-open: any git error, malformed output, or missing history yields
 *     a no-signal outcome rather than a phase failure.
 *   - Deterministic: all output records are constructed in sorted-relPath
 *     order, and map-keyed records are sorted before emission.
 *   - `options.skipGit === true` is a kill switch that returns an empty
 *     result so the graphHash remains stable without temporal data.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FileBranchDivergence, FileNode } from "@opencodehub/core-types";
import type { PipelineContext, PipelinePhase } from "../types.js";
import { SCAN_PHASE_NAME, type ScanOutput } from "./scan.js";
import {
  computeBranchDivergence,
  listLocalBranches,
} from "./temporal-helpers/branch-divergence.js";
import { DEFAULT_CHURN_HALF_LIFE_DAYS, decayWeight } from "./temporal-helpers/churn-decay.js";
import {
  classifyConventionalType,
  sortedHistogram,
} from "./temporal-helpers/conventional-commits.js";
import { busFactor } from "./temporal-helpers/gini.js";
import { isRevertCommit } from "./temporal-helpers/revert-detect.js";
import { isTestFile, pairedTestCandidates } from "./temporal-helpers/test-pair.js";

const execFileAsync = promisify(execFile);

export const TEMPORAL_PHASE_NAME = "temporal" as const;

const DEFAULT_WINDOW_DAYS = 365;
const MIN_WINDOW_DAYS = 30;
const DEFAULT_BASE_BRANCH = "main";
const DEFAULT_MAX_RENAME_FOLLOW = 0;
const GIT_MAX_BUFFER = 500 * 1024 * 1024; // 500 MB
const FIX_FOLLOW_FEAT_WINDOW_SEC = 48 * 60 * 60;
const RISK_KEYWORD_RE = /\b(hotfix|urgent|rollback|broken|oops|fixup|WIP|emergency)\b/gi;
const COAUTHOR_RE = /^Co-authored-by:.*<([^>]+)>/gim;
const NAME_STATUS_SENTINEL = "___OCH_COMMIT___";

/**
 * Augmentation to `PipelineOptions` understood by this phase.
 *
 * These are read via `ctx.options as TemporalOptions` — the shared
 * `PipelineOptions` interface deliberately stays small. Any phase-specific
 * knobs pass through verbatim.
 */
export interface TemporalOptions {
  readonly temporalWindowDays?: number;
  readonly temporalChurnHalfLifeDays?: number;
  readonly temporalBaseBranch?: string;
  readonly temporalMaxRenameFollow?: number;
  /**
   * Reference "now" timestamp in epoch seconds for decay calculations.
   * Providing this makes fixture tests time-independent. Defaults to
   * `Date.now() / 1000`.
   */
  readonly temporalNowEpochSec?: number;
}

/** One commit's file-touch manifest, exposed for reuse by downstream phases. */
export interface TemporalCommitManifest {
  readonly sha: string;
  readonly files: readonly string[];
  /** Committer time (epoch seconds). Used by the cochange phase to emit `last_cocommit_at`. */
  readonly ct: number;
}

export interface TemporalOutput {
  readonly signalsEmitted: number;
  readonly filesSkipped: number;
  readonly windowDays: number;
  readonly subprocessCount: number;
  /**
   * Per-commit file-touch lists assembled from the shared `git log
   * --name-status` dump. Dependents (e.g. the `cochange` phase) consume
   * this instead of re-spawning git. Ordered by sha for determinism.
   *
   * Files are restricted to paths present in the scan output and are the
   * post-rename paths from `--name-status`. Empty when temporal was
   * short-circuited (e.g. `skipGit`, git failure, empty history).
   */
  readonly commitFileLists: readonly TemporalCommitManifest[];
}

export const temporalPhase: PipelinePhase<TemporalOutput> = {
  name: TEMPORAL_PHASE_NAME,
  deps: [SCAN_PHASE_NAME],
  async run(ctx, deps) {
    const scan = deps.get(SCAN_PHASE_NAME) as ScanOutput | undefined;
    if (scan === undefined) {
      throw new Error("temporal: scan output missing from dependency map");
    }
    return runTemporal(ctx, scan);
  },
};

/** Shape of one parsed header record from the `-z` git log dump. */
interface CommitRecord {
  readonly sha: string;
  readonly subject: string;
  readonly body: string;
  readonly ct: number;
  readonly authorEmail: string;
  readonly parents: readonly string[];
  readonly isMerge: boolean;
  readonly ccType: string | undefined;
  readonly files: string[];
}

/** Per-file accumulator, keyed by relative path. */
interface FileAccumulator {
  readonly ccTypes: Map<string, number>;
  readonly feats: number[]; // committer-times of feat: commits
  readonly fixes: number[]; // committer-times of fix: commits
  revertCount: number;
  readonly coauthors: Set<string>;
  readonly authorLinesChanged: Map<string, number>;
  readonly authorLastCt: Map<string, number>;
  decayedChurn: number;
  riskKeywordScore: number;
  readonly commitTimestamps: number[];
  readonly commitShas: Set<string>;
}

function newAccumulator(): FileAccumulator {
  return {
    ccTypes: new Map(),
    feats: [],
    fixes: [],
    revertCount: 0,
    coauthors: new Set(),
    authorLinesChanged: new Map(),
    authorLastCt: new Map(),
    decayedChurn: 0,
    riskKeywordScore: 0,
    commitTimestamps: [],
    commitShas: new Set(),
  };
}

async function runTemporal(ctx: PipelineContext, scan: ScanOutput): Promise<TemporalOutput> {
  const opts = ctx.options as TemporalOptions & Record<string, unknown>;
  const windowDaysRaw = opts.temporalWindowDays ?? DEFAULT_WINDOW_DAYS;
  const windowDays = Math.max(MIN_WINDOW_DAYS, Math.floor(windowDaysRaw));
  const halfLife = opts.temporalChurnHalfLifeDays ?? DEFAULT_CHURN_HALF_LIFE_DAYS;
  const baseBranch = opts.temporalBaseBranch ?? DEFAULT_BASE_BRANCH;
  const maxRenameFollow = opts.temporalMaxRenameFollow ?? DEFAULT_MAX_RENAME_FOLLOW;
  const nowEpochSec = opts.temporalNowEpochSec ?? Math.floor(Date.now() / 1000);

  const emptyResult: TemporalOutput = {
    signalsEmitted: 0,
    filesSkipped: scan.files.length,
    windowDays,
    subprocessCount: 0,
    commitFileLists: [],
  };

  if (ctx.options.skipGit === true) {
    return { ...emptyResult, filesSkipped: 0 };
  }

  // Only process files that were scanned — prevents spurious signals for
  // files no longer tracked.
  const scannedPaths = new Set<string>();
  for (const f of scan.files) scannedPaths.add(f.relPath);

  // 1) Shared log dump — header records only, NUL-separated format.
  const headerDump = await fetchHeaderDump(ctx.repoPath, windowDays, nowEpochSec, ctx);
  if (headerDump === undefined) {
    return emptyResult;
  }

  // 2) Shared log dump — name-status per commit, sentinel-delimited.
  const nameStatus = await fetchNameStatusDump(ctx.repoPath, windowDays, nowEpochSec, ctx);
  if (nameStatus === undefined) {
    return emptyResult;
  }
  let subprocessCount = 2;

  const records = parseHeaderDump(headerDump);
  if (records.length === 0) {
    return emptyResult;
  }
  attachFileLists(records, parseNameStatusDump(nameStatus));

  // Global per-author last-commit-anywhere timestamp — used by signal 11.
  const authorLastCtRepo = new Map<string, number>();
  for (const rec of records) {
    const prev = authorLastCtRepo.get(rec.authorEmail);
    if (prev === undefined || rec.ct > prev) {
      authorLastCtRepo.set(rec.authorEmail, rec.ct);
    }
  }

  // Per-file accumulation.
  const acc = new Map<string, FileAccumulator>();
  const ensure = (path: string): FileAccumulator => {
    let a = acc.get(path);
    if (a === undefined) {
      a = newAccumulator();
      acc.set(path, a);
    }
    return a;
  };

  // Count total lines for a commit from its name-status — used as a cheap
  // proxy for "lines_changed" when `--numstat` is not in the shared dump.
  // Each touched file contributes 1 to the raw churn unit; callers who want
  // true line counts can switch to `--numstat` later.
  for (const rec of records) {
    const revert = isRevertCommit(rec.subject, rec.body);
    const coEmails = extractCoAuthors(rec.body);
    const keywordHits = countMatches(`${rec.subject}\n${rec.body}`, RISK_KEYWORD_RE);
    const weight = decayWeight(rec.ct, nowEpochSec, halfLife);
    for (const filePath of rec.files) {
      if (!scannedPaths.has(filePath)) continue;
      const a = ensure(filePath);
      if (rec.ccType !== undefined) {
        a.ccTypes.set(rec.ccType, (a.ccTypes.get(rec.ccType) ?? 0) + 1);
      }
      if (!rec.isMerge) {
        if (rec.ccType === "feat") a.feats.push(rec.ct);
        if (rec.ccType === "fix") a.fixes.push(rec.ct);
      }
      if (revert) a.revertCount += 1;
      for (const e of coEmails) a.coauthors.add(e);
      a.decayedChurn += weight;
      a.riskKeywordScore += keywordHits;
      a.commitTimestamps.push(rec.ct);
      a.commitShas.add(rec.sha);
      a.authorLinesChanged.set(
        rec.authorEmail,
        (a.authorLinesChanged.get(rec.authorEmail) ?? 0) + 1,
      );
      const prevCt = a.authorLastCt.get(rec.authorEmail);
      if (prevCt === undefined || rec.ct > prevCt) {
        a.authorLastCt.set(rec.authorEmail, rec.ct);
      }
    }
  }

  // Branch divergence (signal 12): one optional extra git process.
  let branchEntries: ReadonlyMap<string, FileBranchDivergence> = new Map();
  const branchDiv = await tryBranchDivergence(ctx, baseBranch);
  if (branchDiv !== undefined) {
    branchEntries = branchDiv.entries;
    subprocessCount += branchDiv.subprocessCount;
  }
  // Index overlap files → first matching branch entry for each scanned file.
  const fileBranchDiv = new Map<string, FileBranchDivergence>();
  for (const [branchName, entry] of [...branchEntries].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    void branchName;
    for (const path of entry.overlapFiles) {
      if (!scannedPaths.has(path)) continue;
      if (!fileBranchDiv.has(path)) fileBranchDiv.set(path, entry);
    }
  }

  // Signal 9: rename history chain is a per-file `--follow` dump. It is
  // strictly bounded by `temporalMaxRenameFollow` because it breaks the
  // shared-dump discipline. Default zero means we emit empty chains.
  const renameChains = new Map<string, readonly string[]>();
  if (maxRenameFollow > 0) {
    const scannedSortedForRename = [...scannedPaths].sort();
    let used = 0;
    for (const relPath of scannedSortedForRename) {
      if (used >= maxRenameFollow) break;
      const chain = await renameChainFor(ctx.repoPath, relPath);
      if (chain.length > 0) {
        renameChains.set(relPath, chain);
        subprocessCount += 1;
      }
      used += 1;
    }
  }

  // Emit signals by merging onto the graph's existing File nodes. Iterate
  // sorted scan paths so node insertion order is reproducible.
  let signalsEmitted = 0;
  let filesSkipped = 0;
  const sortedPaths = [...scan.files].map((f) => f.relPath).sort();
  for (const relPath of sortedPaths) {
    const a = acc.get(relPath);
    if (a === undefined) {
      filesSkipped += 1;
      continue;
    }
    const existing = findFileNode(ctx, relPath);
    if (existing === undefined) {
      filesSkipped += 1;
      continue;
    }
    const bd = fileBranchDiv.get(relPath);
    const rc = renameChains.get(relPath);
    const signals = deriveSignals(a, {
      scannedPaths,
      acc,
      authorLastCtRepo,
      nowEpochSec,
      ...(bd !== undefined ? { fileBranchDiv: bd } : {}),
      ...(rc !== undefined ? { renameChain: rc } : {}),
    });
    const merged: FileNode = { ...existing, ...signals };
    ctx.graph.addNode(merged);
    signalsEmitted += 1;
  }

  // Expose per-commit file manifests for downstream phases (e.g. cochange)
  // that need the same git data without respawning a subprocess. Restrict
  // to scanned paths so consumers see a consistent file universe, and
  // order by sha for determinism.
  const commitFileLists = buildCommitFileLists(records, scannedPaths);

  return {
    signalsEmitted,
    filesSkipped,
    windowDays,
    subprocessCount,
    commitFileLists,
  };
}

function buildCommitFileLists(
  records: readonly CommitRecord[],
  scannedPaths: ReadonlySet<string>,
): readonly TemporalCommitManifest[] {
  const out: TemporalCommitManifest[] = [];
  for (const rec of records) {
    const filtered: string[] = [];
    for (const f of rec.files) {
      if (scannedPaths.has(f)) filtered.push(f);
    }
    if (filtered.length === 0) continue;
    // Sort + de-dup the file list so the manifest is canonical.
    const uniqueSorted = [...new Set(filtered)].sort();
    out.push({ sha: rec.sha, files: uniqueSorted, ct: rec.ct });
  }
  out.sort((a, b) => (a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0));
  return out;
}

interface DerivationContext {
  readonly scannedPaths: ReadonlySet<string>;
  readonly acc: ReadonlyMap<string, FileAccumulator>;
  readonly authorLastCtRepo: ReadonlyMap<string, number>;
  readonly nowEpochSec: number;
  readonly fileBranchDiv?: FileBranchDivergence;
  readonly renameChain?: readonly string[];
}

/** Shape of the set of fields merged onto a FileNode. */
interface TemporalSignalsPatch {
  ccTypeCounts?: Readonly<Record<string, number>>;
  fixFollowFeatDensity?: number;
  revertCount?: number;
  coauthorCount?: number;
  busFactor?: number;
  decayedChurn?: number;
  riskKeywordScore?: number;
  testRatio?: number;
  renameHistoryChain?: readonly string[];
  commitIntervalMaxDays?: number;
  commitIntervalAvgDays?: number;
  topContributorLastSeenDays?: number;
  branchDivergence?: FileBranchDivergence;
}

function deriveSignals(a: FileAccumulator, c: DerivationContext): TemporalSignalsPatch {
  const patch: TemporalSignalsPatch = {};
  if (a.ccTypes.size > 0) {
    patch.ccTypeCounts = sortedHistogram(a.ccTypes);
  }
  // Fix-follow-feat density.
  if (a.fixes.length > 0) {
    const feats = [...a.feats].sort((x, y) => x - y);
    let hits = 0;
    for (const fixCt of a.fixes) {
      // Linear walk — per-file count is small; binary search adds complexity
      // without material benefit at expected scale.
      for (const featCt of feats) {
        if (featCt >= fixCt) break;
        if (fixCt - featCt <= FIX_FOLLOW_FEAT_WINDOW_SEC) {
          hits += 1;
          break;
        }
      }
    }
    patch.fixFollowFeatDensity = round3(hits / a.fixes.length);
  }
  patch.revertCount = a.revertCount;
  patch.coauthorCount = a.coauthors.size;
  patch.busFactor = busFactor([...a.authorLinesChanged.values()]);
  patch.decayedChurn = round3(a.decayedChurn);
  patch.riskKeywordScore = a.riskKeywordScore;
  patch.testRatio = computeTestRatio(a, c);
  if (c.renameChain !== undefined && c.renameChain.length > 0) {
    patch.renameHistoryChain = c.renameChain;
  }
  const gaps = commitGapsDays(a.commitTimestamps);
  if (gaps !== undefined) {
    patch.commitIntervalMaxDays = gaps.max;
    patch.commitIntervalAvgDays = gaps.avg;
  }
  const lastSeen = topContributorLastSeenDays(a, c.authorLastCtRepo, c.nowEpochSec);
  if (lastSeen !== undefined) {
    patch.topContributorLastSeenDays = lastSeen;
  }
  if (c.fileBranchDiv !== undefined) {
    patch.branchDivergence = c.fileBranchDiv;
  }
  return patch;
}

function computeTestRatio(a: FileAccumulator, c: DerivationContext): number {
  // Locate candidate test files for this accumulator. We need the file path
  // that keys `a` — since we don't pass it in, walk the Map.
  let relPath: string | undefined;
  for (const [k, v] of c.acc) {
    if (v === a) {
      relPath = k;
      break;
    }
  }
  if (relPath === undefined) return 0;
  if (isTestFile(relPath)) return 1;
  const candidates = pairedTestCandidates(relPath);
  if (candidates.length === 0) return 0;
  const srcShas = a.commitShas;
  if (srcShas.size === 0) return 0;
  const testShas = new Set<string>();
  for (const cand of candidates) {
    if (!c.scannedPaths.has(cand)) continue;
    const tAcc = c.acc.get(cand);
    if (tAcc === undefined) continue;
    for (const sha of tAcc.commitShas) testShas.add(sha);
  }
  if (testShas.size === 0) return 0;
  let intersection = 0;
  for (const sha of srcShas) {
    if (testShas.has(sha)) intersection += 1;
  }
  const union = srcShas.size + testShas.size - intersection;
  if (union === 0) return 0;
  return round3(intersection / union);
}

function commitGapsDays(ts: readonly number[]): { max: number; avg: number } | undefined {
  if (ts.length < 2) return undefined;
  const sorted = [...ts].sort((a, b) => a - b);
  let maxGap = 0;
  let total = 0;
  const n = sorted.length - 1;
  for (let i = 0; i < n; i += 1) {
    const cur = sorted[i + 1] ?? 0;
    const prev = sorted[i] ?? 0;
    const gap = (cur - prev) / 86_400;
    if (gap > maxGap) maxGap = gap;
    total += gap;
  }
  return { max: Math.round(maxGap), avg: round2(total / n) };
}

function topContributorLastSeenDays(
  a: FileAccumulator,
  repoLastCt: ReadonlyMap<string, number>,
  nowEpochSec: number,
): number | undefined {
  if (a.authorLinesChanged.size === 0) return undefined;
  let topEmail: string | undefined;
  let topCount = -1;
  for (const [email, count] of a.authorLinesChanged) {
    if (count > topCount) {
      topCount = count;
      topEmail = email;
    }
  }
  if (topEmail === undefined) return undefined;
  const last = repoLastCt.get(topEmail);
  if (last === undefined) return undefined;
  const raw = (nowEpochSec - last) / 86_400;
  if (raw < 0) return 0;
  return Math.round(raw);
}

function extractCoAuthors(body: string): readonly string[] {
  const out = new Set<string>();
  COAUTHOR_RE.lastIndex = 0;
  let m: RegExpExecArray | null = COAUTHOR_RE.exec(body);
  while (m !== null) {
    const email = m[1];
    if (email !== undefined) out.add(email.toLowerCase());
    m = COAUTHOR_RE.exec(body);
  }
  return [...out];
}

function countMatches(text: string, re: RegExp): number {
  let n = 0;
  re.lastIndex = 0;
  while (re.exec(text) !== null) n += 1;
  return n;
}

function round3(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000) / 1000;
}

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

// ---- git subprocess helpers ----

/**
 * Convert an epoch-second cutoff to the `YYYY-MM-DD` form `git log --since`
 * accepts. Anchoring `--since` to a deterministic date (rather than the
 * relative `N.days.ago` form) lets callers inject a reproducible clock via
 * `temporalNowEpochSec` without having to monkey-patch the real system clock.
 */
function sinceCutoffIso(nowEpochSec: number, windowDays: number): string {
  const cutoffSec = nowEpochSec - windowDays * 86_400;
  const d = new Date(cutoffSec * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function fetchHeaderDump(
  repoPath: string,
  windowDays: number,
  nowEpochSec: number,
  ctx: PipelineContext,
): Promise<string | undefined> {
  try {
    // Format fields are NUL-separated inside a record; git's `-z` emits NUL
    // between records so we can split cleanly even through multi-line bodies.
    const format = "%H%x00%s%x00%b%x00%ct%x00%ae%x00%P";
    const since = sinceCutoffIso(nowEpochSec, windowDays);
    const { stdout } = await execFileAsync(
      "git",
      ["log", "--all", `--since=${since}`, "-z", `--format=${format}`],
      { cwd: repoPath, maxBuffer: GIT_MAX_BUFFER, encoding: "utf8" },
    );
    return stdout;
  } catch (err) {
    ctx.onProgress?.({
      phase: TEMPORAL_PHASE_NAME,
      kind: "warn",
      message: `temporal: git log dump failed (${(err as Error).message})`,
    });
    return undefined;
  }
}

async function fetchNameStatusDump(
  repoPath: string,
  windowDays: number,
  nowEpochSec: number,
  ctx: PipelineContext,
): Promise<string | undefined> {
  try {
    const since = sinceCutoffIso(nowEpochSec, windowDays);
    const { stdout } = await execFileAsync(
      "git",
      ["log", "--all", `--since=${since}`, "--name-status", `--format=${NAME_STATUS_SENTINEL}%H`],
      { cwd: repoPath, maxBuffer: GIT_MAX_BUFFER, encoding: "utf8" },
    );
    return stdout;
  } catch (err) {
    ctx.onProgress?.({
      phase: TEMPORAL_PHASE_NAME,
      kind: "warn",
      message: `temporal: git log name-status dump failed (${(err as Error).message})`,
    });
    return undefined;
  }
}

async function tryBranchDivergence(
  ctx: PipelineContext,
  baseBranch: string,
): Promise<
  { entries: ReadonlyMap<string, FileBranchDivergence>; subprocessCount: number } | undefined
> {
  const branches = await listLocalBranches(ctx.repoPath);
  if (branches.length === 0) return undefined;
  if (!branches.includes(baseBranch)) {
    return undefined;
  }
  const candidates = branches.filter((b) => b !== baseBranch);
  if (candidates.length === 0) return { entries: new Map(), subprocessCount: 1 };
  const { entries } = await computeBranchDivergence({
    repoPath: ctx.repoPath,
    baseBranch,
    branches: candidates,
  });
  // 1 (for-each-ref) + 2·candidates (rev-list + log per branch).
  const subprocessCount = 1 + 2 * candidates.length;
  return { entries, subprocessCount };
}

async function renameChainFor(repoPath: string, relPath: string): Promise<readonly string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["log", "--follow", "--name-only", "--format=", "--", relPath],
      { cwd: repoPath, maxBuffer: GIT_MAX_BUFFER, encoding: "utf8" },
    );
    // `--name-only` emits one path per commit; collect oldest → newest. The
    // log iterates newest first, so reverse for chain order.
    const seen: string[] = [];
    const dupes = new Set<string>();
    for (const line of stdout.split("\n")) {
      const t = line.trim();
      if (t.length === 0) continue;
      if (dupes.has(t)) continue;
      dupes.add(t);
      seen.push(t);
    }
    seen.reverse();
    return seen;
  } catch {
    return [];
  }
}

// ---- parsing ----

/**
 * Parse the 6-field NUL-separated header dump.
 *
 * Record boundary bytes are NUL-terminated, so we split on NUL and consume
 * in strides of 6. The sha field of every record except the first is
 * prefixed with a newline (git's record terminator leaks across records);
 * trim leading whitespace defensively.
 */
function parseHeaderDump(dump: string): CommitRecord[] {
  if (dump.length === 0) return [];
  const parts = dump.split("\x00");
  const records: CommitRecord[] = [];
  // The final element after split is typically an empty string (trailing
  // record terminator); drop it.
  const stride = 6;
  const usable = parts.length - (parts[parts.length - 1] === "" ? 1 : 0);
  const completeRecords = Math.floor(usable / stride);
  for (let i = 0; i < completeRecords; i += 1) {
    const base = i * stride;
    const shaRaw = parts[base];
    const subject = parts[base + 1];
    const body = parts[base + 2];
    const ctRaw = parts[base + 3];
    const emailRaw = parts[base + 4];
    const parentsRaw = parts[base + 5];
    if (
      shaRaw === undefined ||
      subject === undefined ||
      body === undefined ||
      ctRaw === undefined ||
      emailRaw === undefined ||
      parentsRaw === undefined
    ) {
      continue;
    }
    const sha = shaRaw.replace(/^\s+/, "");
    const ct = Number(ctRaw);
    if (!Number.isFinite(ct)) continue;
    const authorEmail = emailRaw.toLowerCase();
    const parents = parentsRaw
      .trim()
      .split(/\s+/)
      .filter((p) => p.length > 0);
    const ccType = classifyConventionalType(subject);
    records.push({
      sha,
      subject,
      body,
      ct,
      authorEmail,
      parents,
      isMerge: parents.length > 1,
      ccType,
      files: [],
    });
  }
  return records;
}

/**
 * Parse the sentinel-delimited `--name-status` dump into a map of
 * sha → array of post-rename paths.
 */
function parseNameStatusDump(dump: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let currentSha: string | undefined;
  const lines = dump.split("\n");
  for (const line of lines) {
    if (line.length === 0) continue;
    if (line.startsWith(NAME_STATUS_SENTINEL)) {
      currentSha = line.slice(NAME_STATUS_SENTINEL.length);
      if (!out.has(currentSha)) out.set(currentSha, []);
      continue;
    }
    if (currentSha === undefined) continue;
    const tokens = line.split("\t");
    if (tokens.length === 0) continue;
    const status = tokens[0] ?? "";
    if (status.length === 0) continue;
    // A/M/D → column 1. R/C → column 2 (post-rename path).
    const leadingChar = status.charAt(0);
    let path: string | undefined;
    if (leadingChar === "R" || leadingChar === "C") {
      path = tokens[2];
    } else if (leadingChar === "A" || leadingChar === "M" || leadingChar === "D") {
      path = tokens[1];
    } else {
      path = tokens[1];
    }
    if (path === undefined || path.length === 0) continue;
    const bucket = out.get(currentSha);
    if (bucket) bucket.push(path);
  }
  return out;
}

function attachFileLists(records: CommitRecord[], files: ReadonlyMap<string, string[]>): void {
  for (const rec of records) {
    const arr = files.get(rec.sha);
    if (arr !== undefined) {
      rec.files.push(...arr);
    }
  }
}

function findFileNode(ctx: PipelineContext, relPath: string): FileNode | undefined {
  for (const n of ctx.graph.nodes()) {
    if (n.kind === "File" && n.filePath === relPath) {
      return n;
    }
  }
  return undefined;
}
