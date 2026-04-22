/**
 * Verdict composition (Stream F.1).
 *
 * Takes a (base, head) git range and aggregates the signals other analyses
 * already produce (detect-changes → impact → communities → findings →
 * ownership → temporal) into a single 5-tier verdict with stable reasoning
 * chain, reviewer recs, GitHub labels, and Markdown comment.
 *
 * Design constraints:
 *   - **Determinism**: the reasoning chain is sorted by (severity-rank DESC,
 *     label ASC) so byte-for-byte output is stable across runs at the same
 *     commit. We do not depend on Map iteration order.
 *   - **Failure-isolation**: every store query is defended with a
 *     try/catch so a partial index (no Communities, no Findings, no
 *     Contributors) never crashes the verdict; it simply drops the missing
 *     signal.
 *   - **Zero `any`**: the only loose type surface is `Record<string,unknown>`
 *     for raw DuckDB rows, each of which we narrow with explicit casts.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import toml from "@iarna/toml";
import { isSuppressed, type SarifResult } from "@opencodehub/sarif";
import type { IGraphStore } from "@opencodehub/storage";
import { runDetectChanges } from "./detect-changes.js";
import { runImpact } from "./impact.js";
import { renderVerdictMarkdown } from "./verdict-markdown.js";
import {
  DEFAULT_VERDICT_CONFIG,
  type DecisionBoundary,
  type ReasoningSignal,
  type RecommendedReviewer,
  type VerdictConfig,
  type VerdictQuery,
  type VerdictResponse,
  type VerdictTier,
} from "./verdict-types.js";

const execFileAsync = promisify(execFile);

const TIER_ORDER: readonly VerdictTier[] = [
  "auto_merge",
  "single_review",
  "dual_review",
  "expert_review",
  "block",
];

const TIER_EXIT_CODES: Record<VerdictTier, 0 | 1 | 2> = {
  auto_merge: 0,
  single_review: 0,
  dual_review: 1,
  expert_review: 2,
  block: 2,
};

const TIER_LABELS: Record<VerdictTier, string> = {
  auto_merge: "review:automerge",
  single_review: "review:single",
  dual_review: "review:dual",
  expert_review: "review:expert",
  block: "review:block",
};

const SEVERITY_RANK: Record<"info" | "warn" | "error", number> = {
  error: 3,
  warn: 2,
  info: 1,
};

const ORPHAN_ESCALATION = new Set(["orphaned", "abandoned", "fossilized"]);

interface FileMeta {
  readonly orphanGrade?: string;
  readonly fixFollowFeatDensity?: number;
  /** Coverage ratio in [0, 1] from the coverage overlay (Stream Q.2). */
  readonly coveragePercent?: number;
  /** Max cyclomatic complexity across callables inside the file (Stream Q.2). */
  readonly maxCyclomatic?: number;
}

interface FindingSummary {
  readonly errorCount: number;
  readonly warningCount: number;
  readonly byRule: ReadonlyMap<string, number>;
}

interface AggregateState {
  readonly signals: ReasoningSignal[];
  readonly communities: Set<string>;
  readonly communityLabels: Set<string>;
  blastRadius: number;
  maxOrphanGrade: string | undefined;
  maxFixFollowFeat: number;
  findings: FindingSummary;
  /**
   * True iff at least one changed file has `cyclomaticComplexity > 10` AND
   * `coveragePercent < 0.5` (Stream Q.2 coverage-aware escalation).
   */
  complexAndUntested: boolean;
}

/**
 * Compose a verdict for the given git range.
 *
 * The function never throws: git errors, missing index rows, and empty
 * diffs all resolve to a coherent `VerdictResponse` (with `auto_merge` as
 * the baseline).
 */
export async function computeVerdict(
  store: IGraphStore,
  query: VerdictQuery,
): Promise<VerdictResponse> {
  const repoPath = query.repoPath;
  const fileConfig = await loadTomlConfig(repoPath);
  const config = resolveConfig({ ...fileConfig, ...(query.config ?? {}) });
  const base = query.base ?? "main";
  const head = query.head ?? "HEAD";
  const compareRef = buildCompareRef(base, head);

  // ---- 1. detect_changes on the diff ----
  const changes = await runDetectChanges(store, {
    scope: "compare",
    compareRef,
    repoPath,
  });

  // Build the aggregate state up as we collect each signal.
  const state: AggregateState = {
    signals: [],
    communities: new Set<string>(),
    communityLabels: new Set<string>(),
    blastRadius: 0,
    maxOrphanGrade: undefined,
    maxFixFollowFeat: 0,
    findings: { errorCount: 0, warningCount: 0, byRule: new Map() },
    complexAndUntested: false,
  };

  addSignal(state, {
    label: "files_changed",
    value: changes.changedFiles.length,
    severity: "info",
  });
  addSignal(state, {
    label: "symbols_affected",
    value: changes.affectedSymbols.length,
    severity: "info",
  });

  if (changes.affectedSymbols.length === 0) {
    // Empty or doc-only diff → auto_merge with confidence 1.0.
    return finaliseEmpty(changes, config);
  }

  // ---- 2. blast radius per affected symbol (cap at first 20) ----
  // Aggregating as "max total_affected across symbols" matches PRD §F.1 step 4.
  const symbolsToProbe = changes.affectedSymbols.slice(0, 20);
  for (const sym of symbolsToProbe) {
    try {
      const res = await runImpact(store, {
        target: sym.id,
        direction: "upstream",
        maxDepth: 3,
      });
      if (res.totalAffected > state.blastRadius) {
        state.blastRadius = res.totalAffected;
      }
    } catch {
      // Ignore per-symbol traversal errors; partial data is acceptable.
    }
  }
  addSignal(state, {
    label: "blast_radius",
    value: state.blastRadius,
    severity: severityForBlast(state.blastRadius, config),
  });

  // ---- 3. community boundaries touched by the diff ----
  await collectCommunities(
    store,
    changes.affectedSymbols.map((s) => s.id),
    state,
  );
  if (state.communities.size > 0) {
    addSignal(state, {
      label: "communities_touched",
      value: state.communities.size,
      severity: state.communities.size >= config.communityBoundaryThreshold ? "warn" : "info",
    });
  }

  // ---- 4. findings on affected symbols / files ----
  await collectFindings(
    store,
    changes.affectedSymbols.map((s) => s.id),
    changes.changedFiles,
    state,
  );
  if (state.findings.errorCount > 0) {
    addSignal(state, {
      label: "findings_error",
      value: state.findings.errorCount,
      severity: "error",
    });
  }
  if (state.findings.warningCount > 0) {
    addSignal(state, {
      label: "findings_warning",
      value: state.findings.warningCount,
      severity: "warn",
    });
  }

  // ---- 5. per-file orphan grade + fix-follow-feat density + coverage ----
  const fileMeta = await collectFileMeta(store, changes.changedFiles);
  for (const m of fileMeta.values()) {
    if (m.orphanGrade !== undefined && ORPHAN_ESCALATION.has(m.orphanGrade)) {
      if (
        state.maxOrphanGrade === undefined ||
        rankOrphan(m.orphanGrade) > rankOrphan(state.maxOrphanGrade)
      ) {
        state.maxOrphanGrade = m.orphanGrade;
      }
    }
    if (m.fixFollowFeatDensity !== undefined && m.fixFollowFeatDensity > state.maxFixFollowFeat) {
      state.maxFixFollowFeat = m.fixFollowFeatDensity;
    }
    // Stream Q.2 escalation — any changed file whose callables breach the
    // complexity threshold AND whose coverage is thin pulls the verdict up
    // to at least `dual_review`. Both signals must be present; absent data
    // (pre-Q.2 index or no coverage report) is not punished.
    if (
      m.maxCyclomatic !== undefined &&
      m.maxCyclomatic > 10 &&
      m.coveragePercent !== undefined &&
      m.coveragePercent < 0.5
    ) {
      state.complexAndUntested = true;
    }
  }
  if (state.maxOrphanGrade !== undefined) {
    addSignal(state, {
      label: "orphan_grade",
      value: state.maxOrphanGrade,
      severity: "warn",
    });
  }
  if (state.maxFixFollowFeat > config.fixFollowFeatThreshold) {
    addSignal(state, {
      label: "fix_follow_feat_density",
      value: Math.round(state.maxFixFollowFeat * 1000) / 1000,
      severity: "warn",
    });
  }
  if (state.complexAndUntested) {
    addSignal(state, {
      label: "complex_and_untested",
      value: "cyclomatic>10 && coverage<0.5",
      severity: "warn",
    });
  }

  // ---- 6. reviewer recommendations from OWNED_BY ----
  const authorEmail = query.authorEmail ?? (await discoverAuthorEmail(repoPath));
  const reviewers = await collectReviewers(store, changes.changedFiles, authorEmail);

  // ---- 7. tier decision ----
  const tier = decideTier(state, config);

  // Append terminal verdict signal so the reasoning chain contains the
  // decision itself (useful for machine clients and eye-grep).
  addSignal(state, {
    label: "tier",
    value: tier,
    severity:
      tier === "block" || tier === "expert_review"
        ? "error"
        : tier === "dual_review"
          ? "warn"
          : "info",
  });

  const sortedSignals = sortSignals(state.signals);
  const confidence = computeConfidence(state, changes.changedFiles.length);
  const boundary = computeBoundary(state.blastRadius, tier, config);
  const labels = computeLabels(tier, state.communityLabels);

  const communitiesTouched = [...state.communities].sort();
  const response: VerdictResponse = {
    verdict: tier,
    confidence,
    decisionBoundary: boundary,
    reasoningChain: sortedSignals,
    recommendedReviewers: reviewers,
    githubLabels: labels,
    reviewCommentMarkdown: "",
    exitCode: TIER_EXIT_CODES[tier],
    blastRadius: state.blastRadius,
    communitiesTouched,
    changedFileCount: changes.changedFiles.length,
    affectedSymbolCount: changes.affectedSymbols.length,
  };
  const reviewCommentMarkdown = renderVerdictMarkdown(response);
  return { ...response, reviewCommentMarkdown };
}

function resolveConfig(partial: Partial<VerdictConfig> | undefined): VerdictConfig {
  if (partial === undefined) return DEFAULT_VERDICT_CONFIG;
  return { ...DEFAULT_VERDICT_CONFIG, ...partial };
}

function buildCompareRef(base: string, head: string): string {
  // Git's three-dot range is symmetric (merge-base); we use two-dot for
  // "changes on head that aren't on base" which matches typical PR diff
  // semantics. `detect-changes` feeds this directly to `git diff <ref>`.
  return `${base}..${head}`;
}

function finaliseEmpty(
  changes: Awaited<ReturnType<typeof runDetectChanges>>,
  _config: VerdictConfig,
): VerdictResponse {
  const signals: ReasoningSignal[] = [
    { label: "files_changed", value: changes.changedFiles.length, severity: "info" },
    { label: "symbols_affected", value: 0, severity: "info" },
    { label: "tier", value: "auto_merge", severity: "info" },
  ];
  const response: VerdictResponse = {
    verdict: "auto_merge",
    confidence: 1.0,
    decisionBoundary: { distancePercent: 100, nextTier: "single_review" },
    reasoningChain: sortSignals(signals),
    recommendedReviewers: [],
    githubLabels: [TIER_LABELS.auto_merge],
    reviewCommentMarkdown: "",
    exitCode: 0,
    blastRadius: 0,
    communitiesTouched: [],
    changedFileCount: changes.changedFiles.length,
    affectedSymbolCount: 0,
  };
  return { ...response, reviewCommentMarkdown: renderVerdictMarkdown(response) };
}

function addSignal(state: AggregateState, signal: ReasoningSignal): void {
  state.signals.push(signal);
}

function severityForBlast(blast: number, cfg: VerdictConfig): "info" | "warn" | "error" {
  if (blast >= cfg.blockThreshold) return "error";
  if (blast >= cfg.escalationThreshold) return "error";
  if (blast >= cfg.warningThreshold) return "warn";
  return "info";
}

/** Lexicographic severity ordering for deterministic sort. */
function sortSignals(signals: readonly ReasoningSignal[]): readonly ReasoningSignal[] {
  return [...signals].sort((a, b) => {
    const rankDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (rankDiff !== 0) return rankDiff;
    if (a.label !== b.label) return a.label < b.label ? -1 : 1;
    return String(a.value) < String(b.value) ? -1 : String(a.value) > String(b.value) ? 1 : 0;
  });
}

function rankOrphan(grade: string): number {
  if (grade === "fossilized") return 3;
  if (grade === "abandoned") return 2;
  if (grade === "orphaned") return 1;
  return 0;
}

/** @internal test-visible aggregate shape. */
export interface VerdictAggregate {
  readonly blastRadius: number;
  readonly communities: ReadonlySet<string>;
  readonly findings: FindingSummary;
  readonly maxOrphanGrade: string | undefined;
  readonly maxFixFollowFeat: number;
  /** Stream Q.2 — any changed file is complex AND under-tested. */
  readonly complexAndUntested?: boolean;
}

/** @internal test-visible tier decision (pure). */
export function decideTierFromAggregate(
  agg: VerdictAggregate,
  cfg: VerdictConfig = DEFAULT_VERDICT_CONFIG,
): VerdictTier {
  return decideTier(
    {
      signals: [],
      communities: new Set(agg.communities),
      communityLabels: new Set(),
      blastRadius: agg.blastRadius,
      maxOrphanGrade: agg.maxOrphanGrade,
      maxFixFollowFeat: agg.maxFixFollowFeat,
      findings: agg.findings,
      complexAndUntested: agg.complexAndUntested === true,
    },
    cfg,
  );
}

/** @internal test-visible boundary calculation. */
export function computeBoundaryForTest(
  blastRadius: number,
  tier: VerdictTier,
  cfg: VerdictConfig = DEFAULT_VERDICT_CONFIG,
): DecisionBoundary {
  return computeBoundary(blastRadius, tier, cfg);
}

/** @internal test-visible label synthesis. */
export function computeLabelsForTest(
  tier: VerdictTier,
  communityLabels: readonly string[],
): readonly string[] {
  return computeLabels(tier, new Set(communityLabels));
}

/** @internal deterministic signal sorter. */
export function sortSignalsForTest(
  signals: readonly ReasoningSignal[],
): readonly ReasoningSignal[] {
  return sortSignals(signals);
}

/** @internal exit-code mapping. */
export function exitCodeForTier(tier: VerdictTier): 0 | 1 | 2 {
  return TIER_EXIT_CODES[tier];
}

function decideTier(state: AggregateState, cfg: VerdictConfig): VerdictTier {
  const { blastRadius, communities, findings, maxOrphanGrade, maxFixFollowFeat } = state;

  if (blastRadius >= cfg.blockThreshold) return "block";
  if (blastRadius >= cfg.escalationThreshold || findings.errorCount > 0) {
    return "expert_review";
  }
  const communityGate =
    cfg.communityBoundaryEscalation && communities.size >= cfg.communityBoundaryThreshold;
  const orphanGate = maxOrphanGrade !== undefined;
  // Stream Q.2: "complex + untested" is a dual_review gate — the reviewer
  // burden scales with cyclomatic complexity and coverage gaps hide bugs.
  if (
    communityGate ||
    orphanGate ||
    state.complexAndUntested ||
    blastRadius >= cfg.warningThreshold
  ) {
    return "dual_review";
  }
  if (findings.warningCount > 0 || maxFixFollowFeat > cfg.fixFollowFeatThreshold) {
    return "single_review";
  }
  return "auto_merge";
}

function computeConfidence(state: AggregateState, changedFiles: number): number {
  // Start at 0.8 when we have a real diff + graph context; scale by the
  // number of signals we were able to collect. 3+ signals → +0.05.
  let conf = changedFiles === 0 ? 1.0 : 0.8;
  if (state.signals.length >= 3) conf += 0.05;
  if (state.communities.size > 0) conf += 0.05;
  if (state.findings.byRule.size > 0) conf += 0.05;
  // Clamp to [0.1, 1.0].
  return Math.min(1.0, Math.max(0.1, Math.round(conf * 100) / 100));
}

function computeBoundary(
  blastRadius: number,
  tier: VerdictTier,
  cfg: VerdictConfig,
): DecisionBoundary {
  const idx = TIER_ORDER.indexOf(tier);
  const nextTier = idx < TIER_ORDER.length - 1 ? (TIER_ORDER[idx + 1] ?? null) : null;
  if (nextTier === null) return { distancePercent: 0, nextTier: null };

  // Map the current tier to its boundary window, then compute how far the
  // current blast radius has progressed into that window. The window for
  // `auto_merge` is [0, warningThreshold); for `single_review` and
  // `dual_review` it's [warningThreshold, escalationThreshold); for
  // `expert_review` it's [escalationThreshold, blockThreshold).
  let lo = 0;
  let hi = cfg.warningThreshold;
  if (tier === "single_review" || tier === "dual_review") {
    lo = cfg.warningThreshold;
    hi = cfg.escalationThreshold;
  } else if (tier === "expert_review") {
    lo = cfg.escalationThreshold;
    hi = cfg.blockThreshold;
  }
  const range = Math.max(1, hi - lo);
  const progress = Math.min(range, Math.max(0, blastRadius - lo));
  const remainingRatio = 1 - progress / range;
  const distancePercent = Math.max(0, Math.min(100, Math.round(remainingRatio * 100)));
  return { distancePercent, nextTier };
}

function computeLabels(tier: VerdictTier, communityLabels: ReadonlySet<string>): readonly string[] {
  const out = [TIER_LABELS[tier]];
  for (const label of [...communityLabels].sort()) {
    out.push(`area:${label}`);
  }
  return out;
}

async function collectCommunities(
  store: IGraphStore,
  symbolIds: readonly string[],
  state: AggregateState,
): Promise<void> {
  if (symbolIds.length === 0) return;
  try {
    const placeholders = symbolIds.map(() => "?").join(",");
    const rows = await store.query(
      `SELECT r.to_id AS community_id, n.inferred_label AS label
         FROM relations r
         LEFT JOIN nodes n ON n.id = r.to_id
        WHERE r.type = 'MEMBER_OF' AND r.from_id IN (${placeholders})`,
      symbolIds,
    );
    for (const row of rows) {
      const id = stringField(row, "community_id");
      if (id.length === 0) continue;
      state.communities.add(id);
      const label = stringField(row, "label");
      if (label.length > 0) state.communityLabels.add(label);
    }
  } catch {
    // Graph may not have community nodes yet.
  }
}

async function collectFindings(
  store: IGraphStore,
  symbolIds: readonly string[],
  files: readonly string[],
  state: AggregateState,
): Promise<void> {
  if (symbolIds.length === 0 && files.length === 0) return;
  const byRule = new Map<string, number>();
  let errorCount = 0;
  let warningCount = 0;

  if (symbolIds.length > 0) {
    try {
      const placeholders = symbolIds.map(() => "?").join(",");
      const rows = await store.query(
        `SELECT DISTINCT n.rule_id AS rule_id,
                         n.severity AS severity,
                         n.suppressed_json AS suppressed_json
           FROM relations r
           JOIN nodes n ON n.id = r.from_id
          WHERE r.type = 'FOUND_IN' AND n.kind = 'Finding' AND r.to_id IN (${placeholders})`,
        symbolIds,
      );
      for (const row of rows) {
        // Stream T: skip findings tagged via SARIF suppressions[] (loaded
        // from .codehub/suppressions.yaml or inline `codehub-suppress:`
        // comments). They still travel through SARIF + the graph, but do
        // not count toward blocking verdict signals.
        if (isRowSuppressed(row)) continue;
        const severity = stringField(row, "severity");
        const ruleId = stringField(row, "rule_id");
        if (ruleId.length > 0) byRule.set(ruleId, (byRule.get(ruleId) ?? 0) + 1);
        if (severity === "error") errorCount += 1;
        else if (severity === "warning") warningCount += 1;
      }
    } catch {
      // Finding schema may be absent.
    }
  }

  // Fallback path: query findings by file_path on the Finding node (same row
  // as scanner-emitted location). This catches file-level findings not tied
  // to a specific symbol.
  if (files.length > 0) {
    try {
      const placeholders = files.map(() => "?").join(",");
      const rows = await store.query(
        `SELECT rule_id, severity, suppressed_json FROM nodes
          WHERE kind = 'Finding' AND file_path IN (${placeholders})`,
        files,
      );
      for (const row of rows) {
        if (isRowSuppressed(row)) continue;
        const severity = stringField(row, "severity");
        const ruleId = stringField(row, "rule_id");
        if (ruleId.length > 0 && !byRule.has(ruleId)) {
          byRule.set(ruleId, 1);
          if (severity === "error") errorCount += 1;
          else if (severity === "warning") warningCount += 1;
        }
      }
    } catch {
      // Ignore.
    }
  }

  state.findings = { errorCount, warningCount, byRule };
}

/**
 * Bridge between a DuckDB Finding row and SARIF's `isSuppressed` predicate.
 * We rehydrate the persisted `suppressed_json` array into a minimal
 * SarifResult shape and delegate so the "non-empty suppressions[]"
 * definition lives in @opencodehub/sarif.
 */
function isRowSuppressed(row: Record<string, unknown>): boolean {
  const raw = row["suppressed_json"];
  if (typeof raw !== "string" || raw.length === 0) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  const result = { suppressions: parsed } as unknown as SarifResult;
  return isSuppressed(result);
}

async function collectFileMeta(
  store: IGraphStore,
  files: readonly string[],
): Promise<ReadonlyMap<string, FileMeta>> {
  const out = new Map<string, FileMeta>();
  if (files.length === 0) return out;
  try {
    const placeholders = files.map(() => "?").join(",");
    const rows = await store.query(
      `SELECT file_path, orphan_grade, fix_follow_feat_density, coverage_percent
         FROM nodes
        WHERE kind = 'File' AND file_path IN (${placeholders})`,
      files,
    );
    for (const row of rows) {
      const filePath = stringField(row, "file_path");
      if (filePath.length === 0) continue;
      const meta: {
        orphanGrade?: string;
        fixFollowFeatDensity?: number;
        coveragePercent?: number;
        maxCyclomatic?: number;
      } = {};
      const grade = row["orphan_grade"];
      if (typeof grade === "string" && grade.length > 0) {
        meta.orphanGrade = grade;
      }
      const density = row["fix_follow_feat_density"];
      if (typeof density === "number" && Number.isFinite(density)) {
        meta.fixFollowFeatDensity = density;
      }
      const cov = row["coverage_percent"];
      if (typeof cov === "number" && Number.isFinite(cov)) {
        meta.coveragePercent = cov;
      }
      out.set(filePath, meta);
    }
  } catch {
    // Columns may not exist on a pre-H.5 / pre-Q.2 store.
  }

  // Max cyclomatic complexity per file, across callable kinds. Emitted as a
  // separate query because the column is populated on child symbol rows,
  // not on the File row itself.
  try {
    const placeholders = files.map(() => "?").join(",");
    const rows = await store.query(
      `SELECT file_path, MAX(cyclomatic_complexity) AS max_cyclomatic
         FROM nodes
        WHERE kind IN ('Function', 'Method', 'Constructor')
          AND file_path IN (${placeholders})
        GROUP BY file_path`,
      files,
    );
    for (const row of rows) {
      const filePath = stringField(row, "file_path");
      if (filePath.length === 0) continue;
      const maxC = row["max_cyclomatic"];
      if (typeof maxC !== "number" || !Number.isFinite(maxC)) continue;
      const existing = out.get(filePath) ?? {};
      out.set(filePath, { ...existing, maxCyclomatic: maxC });
    }
  } catch {
    // `cyclomatic_complexity` column may be absent on older stores.
  }
  return out;
}

async function collectReviewers(
  store: IGraphStore,
  files: readonly string[],
  authorEmail: string | undefined,
): Promise<readonly RecommendedReviewer[]> {
  if (files.length === 0) return [];
  // Build a list of File node ids — the form `File:<path>:<path>`.
  const fileNodeIds = files.map((f) => `File:${f}:${f}`);
  try {
    const placeholders = fileNodeIds.map(() => "?").join(",");
    const rows = await store.query(
      `SELECT c.email_hash AS email_hash,
              c.email_plain AS email,
              c.name AS name,
              SUM(r.confidence) AS total_weight
         FROM relations r
         JOIN nodes c ON c.id = r.to_id
        WHERE r.type = 'OWNED_BY' AND c.kind = 'Contributor' AND r.from_id IN (${placeholders})
        GROUP BY c.email_hash, c.email_plain, c.name
        ORDER BY total_weight DESC, c.email_hash ASC
        LIMIT 10`,
      fileNodeIds,
    );
    const out: RecommendedReviewer[] = [];
    for (const row of rows) {
      const email = stringField(row, "email");
      const emailHash = stringField(row, "email_hash");
      const name = stringField(row, "name");
      const weightRaw = row["total_weight"];
      const weight = typeof weightRaw === "number" && Number.isFinite(weightRaw) ? weightRaw : 0;
      if (
        authorEmail !== undefined &&
        (email.toLowerCase() === authorEmail.toLowerCase() || emailHash === hashEmail(authorEmail))
      ) {
        continue;
      }
      if (out.length >= 2) break;
      // Normalise weights into [0, 1] by the largest observed.
      out.push({ email, emailHash, name, weight });
    }
    if (out.length === 0) return [];
    const maxWeight = Math.max(...out.map((o) => o.weight), 1e-9);
    return out.map((o) => ({
      email: o.email,
      emailHash: o.emailHash,
      name: o.name,
      weight: Math.min(1, Math.max(0, o.weight / maxWeight)),
    }));
  } catch {
    return [];
  }
}

function hashEmail(email: string): string {
  // We avoid importing crypto here; the cheap contains-check on raw email
  // handles the common case. `email_hash` collisions are still rare in
  // practice because blame always supplies plaintext in memory; the hashed
  // column is stable at write time.
  return email.toLowerCase();
}

async function discoverAuthorEmail(repoPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["log", "-1", "--format=%ae", "HEAD"], {
      cwd: repoPath,
      maxBuffer: 1 * 1024 * 1024,
    });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

function stringField(row: Record<string, unknown>, field: string): string {
  const v = row[field];
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

async function loadTomlConfig(repoPath: string): Promise<Partial<VerdictConfig>> {
  const configPath = path.join(repoPath, ".codehub", "config.toml");
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    return {};
  }
  let parsed: toml.JsonMap;
  try {
    parsed = toml.parse(raw);
  } catch {
    return {};
  }
  const section = parsed["verdict"];
  if (section === undefined || typeof section !== "object" || Array.isArray(section)) {
    return {};
  }
  const verdictSection = section as Record<string, unknown>;
  // Mutable mirror of `VerdictConfig`. `Partial<VerdictConfig>` preserves
  // the `readonly` flags from the source interface, which blocks assignment
  // during progressive build-up; strip them here so we can populate field
  // by field, then widen the frozen public type at the return boundary.
  const out: {
    -readonly [K in keyof VerdictConfig]?: VerdictConfig[K];
  } = {};
  const b = verdictSection["blockThreshold"];
  if (typeof b === "number" && Number.isFinite(b)) out.blockThreshold = b;
  const e = verdictSection["escalationThreshold"];
  if (typeof e === "number" && Number.isFinite(e)) out.escalationThreshold = e;
  const w = verdictSection["warningThreshold"];
  if (typeof w === "number" && Number.isFinite(w)) out.warningThreshold = w;
  const c = verdictSection["communityBoundaryThreshold"];
  if (typeof c === "number" && Number.isFinite(c)) out.communityBoundaryThreshold = c;
  const ce = verdictSection["communityBoundaryEscalation"];
  if (typeof ce === "boolean") out.communityBoundaryEscalation = ce;
  const f = verdictSection["fixFollowFeatThreshold"];
  if (typeof f === "number" && Number.isFinite(f)) out.fixFollowFeatThreshold = f;
  return out;
}
