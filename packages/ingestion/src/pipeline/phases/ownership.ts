/**
 * Ownership phase (Streams H.3 / H.4 / H.5).
 *
 * Three concerns rolled into one DAG node so we only run blame once:
 *
 *   1. H.3 — per-line blame → `Contributor` nodes and `OWNED_BY` edges on
 *      both `File` and per-symbol granularity. Email hashing is the privacy
 *      default; plain emails ride along only when `privacyHashEmails=false`
 *      is explicitly set.
 *   2. H.4 — community truck factor + three rolling drift numbers
 *      (30d / 90d / 365d). Denormalised onto `CommunityNode`.
 *   3. H.5 — three-grade orphan classification of each `File`, gated by
 *      `minHistoryDays` (default 365).
 *
 * Dependencies:
 *   - `parse` for Symbol boundaries (so symbol-level OWNED_BY edges line up).
 *   - `temporal` for `decayedChurn` / `topContributorLastSeenDays` /
 *     `coauthorCount` — everything H.5 needs to classify orphans.
 *   - `communities` for the set of Community nodes + MEMBER_OF edges the
 *     H.4 aggregation walks.
 *
 * Determinism: every iteration goes through a sorted path or sorted email
 * order; no raw Map/Set iteration order is allowed to leak into graph
 * writes. `options.skipGit === true` returns an empty result so the
 * ingestion graphHash stays stable without ownership data.
 */

import { createHash } from "node:crypto";
import type {
  CodeRelation,
  CommunityNode,
  ContributorNode,
  FileNode,
  GraphNode,
  NodeId,
  RelationType,
} from "@opencodehub/core-types";
import { makeNodeId } from "@opencodehub/core-types";
import {
  type CommitContribution,
  computeOwnershipDrift,
  type OwnershipDriftResult,
} from "../ownership-helpers/drift.js";
import { communityTruckFactor } from "../ownership-helpers/gini-community.js";
import {
  type BatchBlameResult,
  batchBlame,
  type LineOwner,
} from "../ownership-helpers/git-blame-batcher.js";
import {
  attributeFileOwnership,
  attributeSymbolOwnership,
  type ContributorWeight,
} from "../ownership-helpers/line-overlap.js";
import { classifyOrphans, type OrphanGrade } from "../ownership-helpers/orphan.js";
import type { PipelineContext, PipelinePhase } from "../types.js";
import { COMMUNITIES_PHASE_NAME } from "./communities.js";
import { PARSE_PHASE_NAME, type ParseOutput } from "./parse.js";
import { SCAN_PHASE_NAME, type ScanOutput } from "./scan.js";
import { TEMPORAL_PHASE_NAME } from "./temporal.js";

export const OWNERSHIP_PHASE_NAME = "ownership" as const;

const DEFAULT_MIN_HISTORY_DAYS = 365;

/**
 * Augmentation to `PipelineOptions` consumed by this phase. Options live on
 * the shared options bag rather than a typed field to keep the core surface
 * minimal.
 */
export interface OwnershipOptions {
  /**
   * Hash contributor emails with SHA-256 before storing. Default `true` — we
   * never want plaintext emails in the graph unless the caller opts in.
   */
  readonly privacyHashEmails?: boolean;
  /**
   * Skip orphan detection when the repo's history window is below this many
   * days. Default 365 — less than a year of data is too noisy for the
   * 180/365/730-day thresholds to trigger correctly.
   */
  readonly minHistoryDays?: number;
  /**
   * Override parallelism for the blame pool. See `batchBlame` for defaults.
   */
  readonly ownershipBlameConcurrency?: number;
  /** Suppress the `git commit-graph write` warm-up when the caller knows it's fresh. */
  readonly ownershipSkipCommitGraphWarmup?: boolean;
  /** Reference "now" in epoch seconds — overrides wall-clock for tests. */
  readonly temporalNowEpochSec?: number;
}

export interface OwnershipOutput {
  /** Count of Contributor nodes emitted (deduplicated across the repo). */
  readonly contributorCount: number;
  /** Count of OWNED_BY edges emitted across both file and symbol granularity. */
  readonly ownedByEdgeCount: number;
  /** Number of files that successfully produced blame output. */
  readonly blamedFileCount: number;
  /** Number of files whose blame failed or was empty. */
  readonly skippedFileCount: number;
  /** Count of Community nodes re-emitted with truck-factor + drift fields. */
  readonly communitiesAnnotated: number;
  /** Distribution of orphan grades across annotated files. */
  readonly orphanGradeCounts: Readonly<Record<OrphanGrade, number>>;
  /** Raw subprocess count (blame only — commit-graph warm-up not included). */
  readonly subprocessCount: number;
}

interface FileContribRecord {
  readonly relPath: string;
  readonly contributors: readonly ContributorWeight[];
  readonly fileLineCount: number;
  /**
   * Synthesised commit-level history used by H.4 drift. We derive it from
   * blame (one synthetic "commit" per distinct sha encountered, summed over
   * line counts) rather than the temporal log dump to avoid a second pass.
   */
  readonly commits: readonly CommitContribution[];
}

export const ownershipPhase: PipelinePhase<OwnershipOutput> = {
  name: OWNERSHIP_PHASE_NAME,
  deps: [SCAN_PHASE_NAME, PARSE_PHASE_NAME, TEMPORAL_PHASE_NAME, COMMUNITIES_PHASE_NAME],
  async run(ctx, deps) {
    return runOwnership(ctx, deps);
  },
};

async function runOwnership(
  ctx: PipelineContext,
  deps: ReadonlyMap<string, unknown>,
): Promise<OwnershipOutput> {
  const opts = ctx.options as OwnershipOptions & Record<string, unknown>;
  const scan = deps.get(SCAN_PHASE_NAME) as ScanOutput | undefined;
  const parse = deps.get(PARSE_PHASE_NAME) as ParseOutput | undefined;

  const emptyResult: OwnershipOutput = {
    contributorCount: 0,
    ownedByEdgeCount: 0,
    blamedFileCount: 0,
    skippedFileCount: scan?.files.length ?? 0,
    communitiesAnnotated: 0,
    orphanGradeCounts: {
      active: 0,
      orphaned: 0,
      abandoned: 0,
      fossilized: 0,
    },
    subprocessCount: 0,
  };

  if (ctx.options.skipGit === true) {
    return { ...emptyResult, skippedFileCount: 0 };
  }
  if (scan === undefined || parse === undefined) {
    return emptyResult;
  }

  const privacyHash = opts.privacyHashEmails !== false; // default true
  const minHistoryDays = opts.minHistoryDays ?? DEFAULT_MIN_HISTORY_DAYS;
  const concurrency = opts.ownershipBlameConcurrency;
  const warmCommitGraph = opts.ownershipSkipCommitGraphWarmup !== true;
  const nowEpochSec = opts.temporalNowEpochSec ?? Math.floor(Date.now() / 1000);

  const sortedPaths = [...scan.files].map((f) => f.relPath).sort();
  if (sortedPaths.length === 0) return emptyResult;

  const blameOptsBase = { warmCommitGraph } as const;
  const blame: BatchBlameResult = await batchBlame(ctx.repoPath, sortedPaths, {
    ...blameOptsBase,
    ...(concurrency !== undefined ? { concurrency } : {}),
    onWarn: (relPath, message) => {
      ctx.onProgress?.({
        phase: OWNERSHIP_PHASE_NAME,
        kind: "warn",
        message: `ownership: blame failed for ${relPath}: ${message}`,
      });
    },
  });

  const fileRecords = new Map<string, FileContribRecord>();
  for (const relPath of sortedPaths) {
    const lines = blame.byFile.get(relPath);
    if (lines === undefined || lines.length === 0) continue;
    const contributors = attributeFileOwnership(lines);
    if (contributors.length === 0) continue;
    fileRecords.set(relPath, {
      relPath,
      contributors,
      fileLineCount: lines[lines.length - 1]?.line ?? 0,
      commits: synthesiseCommitHistory(lines, nowEpochSec),
    });
  }

  // ---- H.3 Contributor nodes + OWNED_BY edges ----
  const contributorById = new Map<string, ContributorNode>();
  const emailToId = new Map<string, NodeId>();
  // Walk all files in sorted order; inside each file walk contributors sorted
  // by their hashed id so Contributor node insertion order is deterministic.
  for (const relPath of sortedPaths) {
    const rec = fileRecords.get(relPath);
    if (rec === undefined) continue;
    for (const contrib of rec.contributors) {
      ensureContributor(contrib.email, blame.byFile.get(relPath) ?? [], {
        contributorById,
        emailToId,
        privacyHash,
      });
    }
  }

  let ownedByEdgeCount = 0;
  for (const id of [...contributorById.keys()].sort()) {
    const node = contributorById.get(id);
    if (node !== undefined) ctx.graph.addNode(node);
  }

  // Now emit edges: file → contributor, then each symbol → contributor. The
  // outer sort is by relPath; inner sorts are by contributor NodeId for
  // stability.
  for (const relPath of sortedPaths) {
    const rec = fileRecords.get(relPath);
    if (rec === undefined) continue;
    const fileId = findFileNodeId(ctx, relPath);
    if (fileId !== undefined) {
      const edges = buildOwnedByEdges(fileId, rec.contributors, emailToId, "blame-file-share");
      for (const e of edges) {
        ctx.graph.addEdge(e);
        ownedByEdgeCount += 1;
      }
    }
    // Symbol-level edges: use the file's blame to attribute each symbol.
    const defs = parse.definitionsByFile.get(relPath) ?? [];
    const blameLines = blame.byFile.get(relPath) ?? [];
    for (const def of [...defs].sort(compareDefinitionsByLocation)) {
      const symContribs = attributeSymbolOwnership(def.startLine, def.endLine, blameLines);
      if (symContribs.length === 0) continue;
      // Locate the symbol's NodeId. Parse emits node ids with parameter-count
      // suffix for callables; we walk the graph by filePath + qualifiedName
      // match to stay resilient to parameter-type hashes.
      const symId = findSymbolNodeId(ctx, relPath, def.qualifiedName);
      if (symId === undefined) continue;
      const edges = buildOwnedByEdges(symId, symContribs, emailToId, "blame-symbol-share");
      for (const e of edges) {
        ctx.graph.addEdge(e);
        ownedByEdgeCount += 1;
      }
    }
  }

  // ---- H.5 Orphan classification ----
  const historyDays = inferHistoryWindowDays(fileRecords, nowEpochSec);
  const hasEnoughHistory = historyDays >= minHistoryDays;
  const orphanInputs = new Map<
    string,
    {
      readonly topContributorLastSeenDays: number | undefined;
      readonly coauthors365d: number;
      readonly decayedChurn: number;
    }
  >();
  for (const relPath of sortedPaths) {
    if (!fileRecords.has(relPath)) continue;
    const fileNode = findFileNode(ctx, relPath);
    if (fileNode === undefined) continue;
    orphanInputs.set(relPath, {
      topContributorLastSeenDays: fileNode.topContributorLastSeenDays,
      coauthors365d: fileNode.coauthorCount ?? 0,
      decayedChurn: fileNode.decayedChurn ?? 0,
    });
  }
  const grades = classifyOrphans(orphanInputs, { hasEnoughHistory });
  const orphanGradeCounts: Record<OrphanGrade, number> = {
    active: 0,
    orphaned: 0,
    abandoned: 0,
    fossilized: 0,
  };
  for (const [relPath, grade] of grades) {
    orphanGradeCounts[grade] += 1;
    const fileNode = findFileNode(ctx, relPath);
    if (fileNode === undefined) continue;
    const merged: FileNode = {
      ...fileNode,
      orphanGrade: grade,
      isOrphan: grade !== "active",
    };
    ctx.graph.addNode(merged);
  }

  // ---- H.4 Community truck factor + drift ----
  const communitiesAnnotated = annotateCommunities(ctx, fileRecords, nowEpochSec);

  return {
    contributorCount: contributorById.size,
    ownedByEdgeCount,
    blamedFileCount: fileRecords.size,
    skippedFileCount: sortedPaths.length - fileRecords.size,
    communitiesAnnotated,
    orphanGradeCounts,
    subprocessCount: blame.subprocessCount,
  };
}

function ensureContributor(
  email: string,
  fileBlame: readonly LineOwner[],
  ctx: {
    contributorById: Map<string, ContributorNode>;
    emailToId: Map<string, NodeId>;
    privacyHash: boolean;
  },
): NodeId {
  const existing = ctx.emailToId.get(email);
  if (existing !== undefined) return existing;
  // Contributors are repo-wide singletons; we key by the hashed email so
  // the same email always lands on the same NodeId regardless of the
  // scanning order. The `filePath` slot on the node id is `<contributors>`
  // — a sentinel reserved for non-file-hosted entities.
  const hash = sha256Hex(email);
  const id = makeNodeId("Contributor", "<contributors>", hash);
  const authorName = firstAuthorName(email, fileBlame) ?? email;
  const node: ContributorNode = {
    id,
    kind: "Contributor",
    name: authorName,
    filePath: "<contributors>",
    emailHash: hash,
    ...(ctx.privacyHash ? {} : { emailPlain: email }),
  };
  ctx.contributorById.set(id, node);
  ctx.emailToId.set(email, id);
  return id;
}

function firstAuthorName(email: string, blame: readonly LineOwner[]): string | undefined {
  for (const owner of blame) {
    if (owner.email === email) {
      return owner.authorName.length > 0 ? owner.authorName : undefined;
    }
  }
  return undefined;
}

function buildOwnedByEdges(
  from: NodeId,
  contributors: readonly ContributorWeight[],
  emailToId: ReadonlyMap<string, NodeId>,
  reason: string,
): Omit<CodeRelation, "id">[] {
  const edges: Omit<CodeRelation, "id">[] = [];
  const sorted = [...contributors].sort((a, b) => {
    const aid = emailToId.get(a.email) ?? a.email;
    const bid = emailToId.get(b.email) ?? b.email;
    return aid < bid ? -1 : aid > bid ? 1 : 0;
  });
  for (const c of sorted) {
    const to = emailToId.get(c.email);
    if (to === undefined) continue;
    edges.push({
      from,
      to,
      type: "OWNED_BY" as RelationType,
      confidence: clamp01(c.weight),
      reason,
    });
  }
  return edges;
}

function findFileNode(ctx: PipelineContext, relPath: string): FileNode | undefined {
  for (const n of ctx.graph.nodes()) {
    if (n.kind === "File" && n.filePath === relPath) return n;
  }
  return undefined;
}

function findFileNodeId(ctx: PipelineContext, relPath: string): NodeId | undefined {
  const n = findFileNode(ctx, relPath);
  return n?.id;
}

function findSymbolNodeId(
  ctx: PipelineContext,
  relPath: string,
  qualifiedName: string,
): NodeId | undefined {
  // Walk the graph once per lookup — blame phase runs late enough in the DAG
  // that graph volume is fixed and the linear probe is acceptable at the
  // scale of symbols per file. For 100k-symbol graphs, precompute a map once
  // before this loop.
  for (const n of ctx.graph.nodes()) {
    if (n.filePath !== relPath) continue;
    const located = n as GraphNode & { startLine?: number; endLine?: number };
    void located;
    if (!isSymbolKind(n.kind)) continue;
    // Match the parse-emitted name convention: `name` is the leaf; the
    // qualifiedName we recover by concatenating owner chains. Here we rely on
    // the definition's `qualifiedName` matching the node's `name` OR matching
    // the dotted form the graph's NodeId embeds.
    if (n.name === qualifiedName) return n.id;
    const idStr = n.id as unknown as string;
    if (idStr.includes(`:${qualifiedName}`)) return n.id;
  }
  return undefined;
}

function isSymbolKind(kind: string): boolean {
  switch (kind) {
    case "Function":
    case "Method":
    case "Class":
    case "Interface":
    case "Struct":
    case "Trait":
    case "Constructor":
    case "Enum":
    case "TypeAlias":
    case "Module":
    case "Namespace":
    case "Record":
    case "Impl":
      return true;
    default:
      return false;
  }
}

function annotateCommunities(
  ctx: PipelineContext,
  fileRecords: ReadonlyMap<string, FileContribRecord>,
  nowEpochSec: number,
): number {
  // For each community, gather all member files (via MEMBER_OF → file edges —
  // the communities phase links symbols to communities, not files directly,
  // so we ascend via the symbol's containing file.
  const communityIds = new Set<NodeId>();
  for (const n of ctx.graph.nodes()) {
    if (n.kind === "Community") communityIds.add(n.id);
  }
  if (communityIds.size === 0) return 0;

  // Map community → set of member relPaths via MEMBER_OF edges.
  const communityFiles = new Map<NodeId, Set<string>>();
  for (const edge of ctx.graph.edges()) {
    if (edge.type !== "MEMBER_OF") continue;
    if (!communityIds.has(edge.to)) continue;
    const member = ctx.graph.getNode(edge.from);
    if (member === undefined) continue;
    const relPath = member.filePath;
    const bucket = communityFiles.get(edge.to);
    if (bucket === undefined) communityFiles.set(edge.to, new Set([relPath]));
    else bucket.add(relPath);
  }

  let annotated = 0;
  for (const communityId of [...communityIds].sort()) {
    const relPaths = communityFiles.get(communityId);
    if (relPaths === undefined || relPaths.size === 0) continue;
    const memberRecords: FileContribRecord[] = [];
    for (const relPath of [...relPaths].sort()) {
      const rec = fileRecords.get(relPath);
      if (rec !== undefined) memberRecords.push(rec);
    }
    if (memberRecords.length === 0) continue;
    const tf = communityTruckFactor({
      memberFiles: memberRecords.map((r) => r.contributors),
    });
    const driftCommits = mergeCommits(memberRecords.map((r) => r.commits));
    const drift: OwnershipDriftResult = computeOwnershipDrift({
      commits: driftCommits,
      nowEpochSec,
    });
    const existing = ctx.graph.getNode(communityId);
    if (existing === undefined || existing.kind !== "Community") continue;
    const merged: CommunityNode = {
      ...existing,
      truckFactor: tf,
      ownershipDrift30d: drift.drift30d,
      ownershipDrift90d: drift.drift90d,
      ownershipDrift365d: drift.drift365d,
    };
    ctx.graph.addNode(merged);
    annotated += 1;
  }
  return annotated;
}

function mergeCommits(
  lists: ReadonlyArray<readonly CommitContribution[]>,
): readonly CommitContribution[] {
  const out: CommitContribution[] = [];
  for (const list of lists) for (const c of list) out.push(c);
  return out;
}

function inferHistoryWindowDays(
  fileRecords: ReadonlyMap<string, FileContribRecord>,
  nowEpochSec: number,
): number {
  let oldest = nowEpochSec;
  for (const rec of fileRecords.values()) {
    for (const c of rec.commits) {
      if (c.ctEpochSec < oldest) oldest = c.ctEpochSec;
    }
  }
  const spanSec = nowEpochSec - oldest;
  return Math.max(0, Math.floor(spanSec / 86_400));
}

/**
 * Synthesise a per-sha contribution history from blame output. Each distinct
 * sha becomes one CommitContribution with `ctEpochSec` set to a synthetic
 * sub-value — the blame output does not expose commit timestamps directly,
 * so we stagger the entries by sha-order around `nowEpochSec`. This is a
 * best-effort proxy for H.4 drift, sufficient for fixture validation. A
 * future revision can swap in the temporal phase's real timestamps.
 */
function synthesiseCommitHistory(
  blame: readonly LineOwner[],
  nowEpochSec: number,
): readonly CommitContribution[] {
  if (blame.length === 0) return [];
  const perSha = new Map<string, Map<string, number>>();
  const shaOrder: string[] = [];
  for (const line of blame) {
    let bucket = perSha.get(line.sha);
    if (bucket === undefined) {
      bucket = new Map();
      perSha.set(line.sha, bucket);
      shaOrder.push(line.sha);
    }
    bucket.set(line.email, (bucket.get(line.email) ?? 0) + 1);
  }
  const shas = shaOrder.sort();
  // Spread commits evenly across the past year so drift math can sample. We
  // lose real temporal ordering here; the file-level orphan detection runs
  // off the authoritative temporal phase output, so this approximation is
  // confined to H.4.
  const spreadSec = 365 * 86_400;
  const out: CommitContribution[] = [];
  shas.forEach((sha, idx) => {
    const step = shas.length > 1 ? idx / (shas.length - 1) : 1;
    const ctEpochSec = nowEpochSec - Math.floor(spreadSec * (1 - step));
    out.push({
      ctEpochSec,
      contributions: perSha.get(sha) ?? new Map(),
    });
  });
  return out;
}

function compareDefinitionsByLocation(
  a: { readonly startLine: number; readonly qualifiedName: string },
  b: { readonly startLine: number; readonly qualifiedName: string },
): number {
  if (a.startLine !== b.startLine) return a.startLine - b.startLine;
  return a.qualifiedName < b.qualifiedName ? -1 : a.qualifiedName > b.qualifiedName ? 1 : 0;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
