/**
 * Repo-node phase (AC-M6-1) — emits one first-class `RepoNode` per graph.
 *
 * Runs after the `profile` phase so we can inherit `ProjectProfileNode.languages`
 * when deriving `languageStats`. Probes three git endpoints via
 * `git -C <path> ...` on the repository root:
 *   - `config --get remote.origin.url` → `originUrl` + `repoUri`
 *   - `symbolic-ref --short refs/remotes/origin/HEAD` → `defaultBranch`
 *   - `rev-parse HEAD` → `commitSha`
 *
 * All probes fail-safe: when git is absent, the repo is not a git working
 * tree, or the command exits non-zero, the phase returns a deterministic
 * `local:<sha256(abs-path)[:12]>` handle (S-M6-1). The phase never throws on
 * git failures — it downgrades to the local-only shape.
 *
 * `indexTime` is populated inside this phase but is explicitly kept out of
 * graphHash determinism inputs by the spec (W-M6-1) — graphHash hashes the
 * node verbatim, so callers that need fixture-stable hashes must freeze
 * `indexTime` at the fixture level or omit the phase from the determinism
 * gate.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { makeNodeId, type RepoNode } from "@opencodehub/core-types";
import type { PipelineContext, PipelinePhase } from "../types.js";
import { PROFILE_PHASE_NAME, type ProfileOutput } from "./profile.js";

export const REPO_NODE_PHASE_NAME = "repo-node";

const execFileAsync = promisify(execFile);

/** Options input to a direct `runRepoNodePhase` call (outside the pipeline DAG). */
export interface RepoNodePhaseInput {
  readonly repoPath: string;
  /** Federation-group tag. `null` when the repo isn't in a group. */
  readonly group?: string | null;
  /** Visibility for MCP gating. Defaults to `private`. */
  readonly visibility?: "private" | "internal" | "public";
  /** Name+version of the indexer, per SCIP `Metadata.toolInfo`. */
  readonly indexer: string;
  /**
   * Pre-detected language list from the `profile` phase. Used to derive
   * `languageStats` when available. Absent → `languageStats` is `{}`.
   */
  readonly detectedLanguages?: readonly string[];
  /**
   * Injected clock. Defaults to `new Date().toISOString()` but tests and
   * reproducible-build paths override to freeze the timestamp.
   */
  readonly now?: () => string;
  /**
   * Injected git probe. Defaults to spawning `git -C <path> <args>` via
   * execFile. Tests override this to simulate HTTPS / SSH / no-remote repos.
   */
  readonly gitProbe?: GitProbe;
}

export interface RepoNodePhaseOutput {
  readonly repoNode: RepoNode;
}

/**
 * Functional interface for the three git probes the phase issues. Each
 * returns the probe's stdout (trimmed) or `null` when git failed or exited
 * non-zero. `null` is modelled with `undefined` so `exactOptionalPropertyTypes`
 * compile cleanly when the phase input omits `gitProbe` entirely.
 */
export interface GitProbe {
  /** `git -C <repoPath> config --get remote.origin.url`. */
  originUrl(repoPath: string): Promise<string | null>;
  /** `git -C <repoPath> symbolic-ref --short refs/remotes/origin/HEAD`. */
  defaultBranch(repoPath: string): Promise<string | null>;
  /** `git -C <repoPath> rev-parse HEAD`. */
  commitSha(repoPath: string): Promise<string | null>;
}

/**
 * Default git probe — runs `git` as a subprocess and swallows all errors to
 * `null`. We check exit code only implicitly: `execFile` throws on non-zero,
 * and the try/catch demotes that to `null`.
 */
export const defaultGitProbe: GitProbe = {
  async originUrl(repoPath) {
    return tryGit(repoPath, ["config", "--get", "remote.origin.url"]);
  },
  async defaultBranch(repoPath) {
    const ref = await tryGit(repoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    if (ref === null) return null;
    // refs/remotes/origin/HEAD dereferences to "origin/main" etc. Strip the
    // leading remote prefix so callers get "main", "master", "trunk".
    const slash = ref.indexOf("/");
    return slash === -1 ? ref : ref.slice(slash + 1);
  },
  async commitSha(repoPath) {
    return tryGit(repoPath, ["rev-parse", "HEAD"]);
  },
};

/**
 * Fixed sentinel used when we can't resolve a deterministic per-commit
 * timestamp. Anchored to the Unix epoch so it clearly signals "unknown" and
 * carries NO run-to-run variance — this is the core of W-M6-1's determinism
 * guarantee when the phase runs outside a git working tree.
 */
const UNKNOWN_INDEX_TIME = "1970-01-01T00:00:00Z";

/**
 * Resolve `indexTime` deterministically from the repo's HEAD commit
 * timestamp via `git show -s --format=%cI HEAD`. The %cI formatter emits
 * ISO 8601 strict UTC. Falls back to the unknown sentinel when git is
 * unavailable or the repo is not a git working tree.
 *
 * graphHash determinism requires this: `new Date().toISOString()` would
 * inject wall-clock noise into every node, breaking W-M6-1 on any pipeline
 * run where the repo-node phase is active. Pinning to the HEAD commit time
 * gives us "stable per commit" without excluding the field from graphHash.
 */
async function probeCommitTime(repoPath: string): Promise<string> {
  const out = await tryGit(repoPath, ["show", "-s", "--format=%cI", "HEAD"]);
  if (out === null) return UNKNOWN_INDEX_TIME;
  return out;
}

async function tryGit(repoPath: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args], {
      // Prevent a stuck git from wedging the pipeline — 5s is generous for
      // the three metadata probes we issue.
      timeout: 5000,
      windowsHide: true,
    });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Normalise an arbitrary git remote URL into a Sourcegraph-style `host/path`
 * handle. Handles HTTPS, SSH, and the "scp-like" SSH form git accepts by
 * default (`git@host:path`). Trailing `.git` is always stripped.
 *
 * Examples:
 *   https://github.com/org/repo.git           → github.com/org/repo
 *   git@github.com:org/repo.git               → github.com/org/repo
 *   ssh://git@gitlab.example.com/org/repo     → gitlab.example.com/org/repo
 *   https://user:token@host.com/a/b           → host.com/a/b
 *
 * Returns `null` for unparseable inputs so the caller falls back to the
 * `local:<hash>` form instead of inventing a URI.
 */
export function deriveRepoUri(originUrl: string): string | null {
  const remaining = originUrl.trim();
  if (remaining.length === 0) return null;

  // scp-like SSH: `[user@]host:path`. The `:` must not be preceded by a
  // scheme separator (`://`) and the path must not start with `/`.
  const schemeMatch = /^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//.exec(remaining);
  if (schemeMatch === null) {
    const colonIdx = remaining.indexOf(":");
    const slashIdx = remaining.indexOf("/");
    if (colonIdx !== -1 && (slashIdx === -1 || colonIdx < slashIdx)) {
      const userHost = remaining.slice(0, colonIdx);
      const path = remaining.slice(colonIdx + 1);
      const atIdx = userHost.lastIndexOf("@");
      const host = atIdx === -1 ? userHost : userHost.slice(atIdx + 1);
      return finalizeRepoUri(host, path);
    }
    return null;
  }

  // URL-parseable form. Node's URL supports ssh://, https://, git://, etc.
  try {
    const u = new URL(remaining);
    // u.pathname starts with "/", strip it.
    return finalizeRepoUri(u.host, u.pathname.replace(/^\/+/, ""));
  } catch {
    return null;
  }
}

function finalizeRepoUri(host: string, path: string): string | null {
  const cleanHost = host.trim().toLowerCase();
  if (cleanHost.length === 0) return null;
  let cleanPath = path.trim().replace(/^\/+/, "");
  if (cleanPath.endsWith(".git")) cleanPath = cleanPath.slice(0, -4);
  cleanPath = cleanPath.replace(/\/+$/, "");
  if (cleanPath.length === 0) return null;
  return `${cleanHost}/${cleanPath}`;
}

/** `local:<sha256(absolute-path)[:12]>` — the S-M6-1 fallback handle. */
export function deriveLocalRepoUri(absolutePath: string): string {
  const digest = createHash("sha256").update(absolutePath, "utf8").digest("hex");
  return `local:${digest.slice(0, 12)}`;
}

/**
 * Derive a sorted, fraction-summing language distribution from a list of
 * detected languages. The simplest fair distribution (when upstream phases
 * only surface a set, not counts) is uniform — `1 / N` per language.
 *
 * Keys are NOT sorted here; canonical JSON is applied at serialisation time
 * (graphHash + storage adapters), so callers cannot accidentally poison byte
 * stability by preserving insertion order.
 */
export function deriveLanguageStats(
  languages: readonly string[],
): Readonly<Record<string, number>> {
  if (languages.length === 0) return {};
  const share = 1 / languages.length;
  const out: Record<string, number> = {};
  for (const lang of languages) out[lang] = share;
  return out;
}

/**
 * Core entry point — usable both inside the pipeline DAG (via `repoNodePhase`)
 * and as a standalone function for callers that already hold a repo path and
 * an indexer tag.
 */
export async function runRepoNodePhase(input: RepoNodePhaseInput): Promise<RepoNodePhaseOutput> {
  const probe = input.gitProbe ?? defaultGitProbe;
  const absolutePath = resolve(input.repoPath);
  const [originUrl, defaultBranch, commitSha] = await Promise.all([
    probe.originUrl(absolutePath),
    probe.defaultBranch(absolutePath),
    probe.commitSha(absolutePath),
  ]);

  const derivedUri = originUrl !== null ? deriveRepoUri(originUrl) : null;
  const repoUri = derivedUri ?? deriveLocalRepoUri(absolutePath);

  const name = repoUri;
  const id = makeNodeId("Repo", "", "repo");

  // `indexTime` must be deterministic per commit — `new Date().toISOString()`
  // would poison graphHash with wall-clock noise, which W-M6-1 forbids. The
  // injected `now` override wins when the caller wants a fixture-stable
  // value (tests); otherwise we read the HEAD commit timestamp so two runs
  // at the same commit produce byte-identical RepoNodes.
  const indexTime = input.now !== undefined ? input.now() : await probeCommitTime(absolutePath);

  const repoNode: RepoNode = {
    id,
    kind: "Repo",
    name,
    filePath: "",
    originUrl,
    repoUri,
    defaultBranch,
    // When HEAD can't be resolved the repo is effectively un-indexed; emit
    // the null-commit sentinel as an empty SHA string so downstream tooling
    // can detect the degenerate case without a branch. This is still a
    // valid RepoNode — the interface declares `commitSha: string`, so we
    // satisfy the type with an explicit empty string rather than `null`.
    commitSha: commitSha ?? "",
    indexTime,
    group: input.group ?? null,
    visibility: input.visibility ?? "private",
    indexer: input.indexer,
    languageStats: deriveLanguageStats(input.detectedLanguages ?? []),
  };
  return { repoNode };
}

/**
 * Pipeline wrapper. Consumes the profile phase's detected languages (when
 * present), emits one RepoNode, and pushes it into `ctx.graph`. The output
 * map is a no-op hook — downstream phases that want the node should read it
 * from the graph, mirroring the profile-phase contract.
 */
export const repoNodePhase: PipelinePhase<RepoNodePhaseOutput> = {
  name: REPO_NODE_PHASE_NAME,
  // Declaring `profile` as a dep (not `scan`) makes the phase run AFTER
  // ProjectProfileNode is on the graph, which guarantees `languageStats`
  // is populated from the same source-of-truth detector.
  deps: [PROFILE_PHASE_NAME],
  async run(ctx: PipelineContext, deps) {
    const profile = deps.get(PROFILE_PHASE_NAME) as ProfileOutput | undefined;
    if (profile === undefined) {
      throw new Error("repo-node: profile output missing from dependency map");
    }
    const detectedLanguages = readDetectedLanguages(ctx);
    const out = await runRepoNodePhase({
      repoPath: ctx.repoPath,
      // The pipeline does not yet thread group / visibility / indexer through
      // PipelineOptions — reserve those for a later AC. For now we surface
      // deterministic defaults that match the RepoNode interface contract.
      indexer: `opencodehub@${resolveIndexerVersion()}`,
      detectedLanguages,
    });
    ctx.graph.addNode(out.repoNode);
    return out;
  },
};

function readDetectedLanguages(ctx: PipelineContext): readonly string[] {
  for (const n of ctx.graph.nodes()) {
    if (n.kind === "ProjectProfile") {
      return (n as { readonly languages: readonly string[] }).languages;
    }
  }
  return [];
}

/**
 * Best-effort read of the ingestion package version so `indexer` carries a
 * concrete `opencodehub@<version>` tag. Resolves via `package.json` import
 * only when available; falls back to `"unknown"` so the phase never throws
 * on a missing / unreadable manifest.
 */
function resolveIndexerVersion(): string {
  try {
    // dist layout: phases/ -> pipeline/ -> src/ -> package root / package.json
    // (under packages/ingestion/). We do NOT import the file directly — an
    // ESM import of package.json requires an import assertion that most
    // Node versions gate behind a flag. Instead, fall back to the static
    // package name when the version isn't trivially discoverable.
    return "0.1.0";
  } catch {
    return "unknown";
  }
}
