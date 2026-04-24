/**
 * `codehub augment <pattern>` — fast-path enrichment for editor hooks.
 *
 * Claude Code's PreToolUse hook (and the Cursor equivalent) fires before the
 * model runs Grep/Glob/Bash, and forwards the search pattern to this command.
 * We answer with a compact text block on stderr that lists the top symbol
 * matches plus their immediate callers, callees, and process participation
 * — enough context for the agent to skip a noisy file search when the graph
 * already knows the answer.
 *
 * Design choices:
 *   - BM25 only. Loading the ONNX embedder would blow the <750ms cold-start
 *     budget. Hybrid search is `codehub query`'s job.
 *   - Registry-driven cwd → repo resolution. If the caller's cwd is not
 *     inside any registered repo, we emit nothing and exit 0.
 *   - Graceful failure. Missing index, malformed DB, permission errors —
 *     every error path returns the empty string and exits 0 so a broken
 *     hook never blocks the model's tool call.
 *   - Write to stderr. stdout is reserved for MCP JSON-RPC anywhere this
 *     helper might be re-used, and Claude Code's hook reads the subprocess
 *     stderr back into the model's context.
 */

import { resolve, sep } from "node:path";
import { bm25Search } from "@opencodehub/search";
import { DuckDbStore, resolveDbPath } from "@opencodehub/storage";
import { type RepoEntry, readRegistry } from "../registry.js";

/** Public-API shape for `runAugment`. */
export interface AugmentOptions {
  /** Override cwd for tests and hook simulators. */
  readonly cwd?: string;
  /** Override `~` for registry lookup in tests. */
  readonly home?: string;
  /** Max BM25 hits to enrich. Defaults to 5. */
  readonly limit?: number;
  /** Sink used for the enriched output. Defaults to `process.stderr.write`. */
  readonly writer?: (chunk: string) => void;
}

/** Internal shape accumulated per symbol before rendering. */
interface EnrichedHit {
  readonly name: string;
  readonly kind: string;
  readonly filePath: string;
  readonly score: number;
  readonly callers: readonly string[];
  readonly callees: readonly string[];
  readonly processes: readonly string[];
}

const DEFAULT_HIT_LIMIT = 5;
const MIN_PATTERN_LEN = 3;
const MAX_CALLERS = 3;
const MAX_CALLEES = 3;
const MAX_PROCESSES = 3;

/**
 * Entry point invoked by `src/index.ts`. Never throws — wraps the whole body
 * in a try/catch so the shell hook can rely on exit-code 0 regardless of
 * internal failure.
 */
export async function runAugment(pattern: string, opts: AugmentOptions = {}): Promise<void> {
  const write =
    opts.writer ??
    ((chunk: string): void => {
      process.stderr.write(chunk);
    });

  try {
    const text = await augment(pattern, opts);
    if (text.length > 0) write(`${text}\n`);
  } catch {
    // Graceful failure — never break the calling hook.
  }
}

/**
 * Pure computation: resolves the repo for `cwd`, opens the store read-only,
 * runs BM25 + a few hydration queries, and returns the rendered text block
 * (empty string on any miss).
 *
 * Exported for direct unit testing without stubbing stderr.
 */
export async function augment(pattern: string, opts: AugmentOptions = {}): Promise<string> {
  if (typeof pattern !== "string" || pattern.length < MIN_PATTERN_LEN) return "";

  const cwd = resolve(opts.cwd ?? process.cwd());
  const limit = opts.limit ?? DEFAULT_HIT_LIMIT;

  const repo = await resolveRepoForCwd(cwd, opts.home);
  if (repo === undefined) return "";

  const dbPath = resolveDbPath(repo.path);
  const store = new DuckDbStore(dbPath, { readOnly: true });
  try {
    await store.open();
  } catch {
    // No index, corrupt DB, or file missing — treat as "nothing to say".
    return "";
  }

  try {
    const hits = await bm25Search(store, { text: pattern, limit });
    if (hits.length === 0) return "";

    const topIds = hits.slice(0, limit).map((h) => h.nodeId);
    const [callersMap, calleesMap, processesMap] = await Promise.all([
      fetchCallersByTarget(store, topIds),
      fetchCalleesBySource(store, topIds),
      fetchProcessesBySymbol(store, topIds),
    ]);

    const enriched: EnrichedHit[] = hits.slice(0, limit).map((h) => ({
      name: h.name,
      kind: h.kind,
      filePath: h.filePath,
      score: h.score,
      callers: (callersMap.get(h.nodeId) ?? []).slice(0, MAX_CALLERS),
      callees: (calleesMap.get(h.nodeId) ?? []).slice(0, MAX_CALLEES),
      processes: (processesMap.get(h.nodeId) ?? []).slice(0, MAX_PROCESSES),
    }));

    return renderBlock(enriched, repo.name);
  } finally {
    await store.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Registry resolution — pick the most-specific registered repo that contains
// `cwd` (or is contained by it). Mirrors the longest-prefix match used by
// other CLI surfaces so nested registrations behave predictably.
// ---------------------------------------------------------------------------

async function resolveRepoForCwd(
  cwd: string,
  home: string | undefined,
): Promise<RepoEntry | undefined> {
  try {
    const registryOpts = home !== undefined ? { home } : {};
    const registry = await readRegistry(registryOpts);
    let best: RepoEntry | undefined;
    let bestLen = -1;
    for (const entry of Object.values(registry)) {
      const repoPath = resolve(entry.path);
      const matched =
        cwd === repoPath || cwd.startsWith(repoPath + sep) || repoPath.startsWith(cwd + sep);
      if (matched && repoPath.length > bestLen) {
        best = entry;
        bestLen = repoPath.length;
      }
    }
    return best;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Graph hydration — three batched SQL round-trips keyed on the top-N node ids.
// Any failure degrades silently to an empty map so the caller can still emit
// the flat BM25 ranking.
// ---------------------------------------------------------------------------

async function fetchCallersByTarget(
  store: DuckDbStore,
  ids: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => "?").join(",");
  try {
    const rows = await store.query(
      `SELECT r.to_id AS target_id, n.name AS caller_name
         FROM relations r
         JOIN nodes n ON n.id = r.from_id
        WHERE r.type = 'CALLS' AND r.to_id IN (${placeholders})`,
      ids,
    );
    for (const row of rows) {
      const tid = String(row["target_id"] ?? "");
      const name = String(row["caller_name"] ?? "");
      if (tid.length === 0 || name.length === 0) continue;
      const arr = out.get(tid);
      if (arr === undefined) out.set(tid, [name]);
      else arr.push(name);
    }
  } catch {
    // Swallow — callers list collapses to empty, everything else keeps going.
  }
  return out;
}

async function fetchCalleesBySource(
  store: DuckDbStore,
  ids: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => "?").join(",");
  try {
    const rows = await store.query(
      `SELECT r.from_id AS source_id, n.name AS callee_name
         FROM relations r
         JOIN nodes n ON n.id = r.to_id
        WHERE r.type = 'CALLS' AND r.from_id IN (${placeholders})`,
      ids,
    );
    for (const row of rows) {
      const sid = String(row["source_id"] ?? "");
      const name = String(row["callee_name"] ?? "");
      if (sid.length === 0 || name.length === 0) continue;
      const arr = out.get(sid);
      if (arr === undefined) out.set(sid, [name]);
      else arr.push(name);
    }
  } catch {
    // ignore
  }
  return out;
}

async function fetchProcessesBySymbol(
  store: DuckDbStore,
  ids: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => "?").join(",");
  // PROCESS_STEP edges are emitted from a Process node toward each symbol
  // that participates (see `detect-changes.ts`). Chase r.from_id back to a
  // Process node name in a single JOIN so we avoid a second round-trip.
  try {
    const rows = await store.query(
      `SELECT r.to_id AS symbol_id, p.name AS process_name
         FROM relations r
         JOIN nodes p ON p.id = r.from_id
        WHERE r.type = 'PROCESS_STEP'
          AND p.kind = 'Process'
          AND r.to_id IN (${placeholders})`,
      ids,
    );
    for (const row of rows) {
      const sid = String(row["symbol_id"] ?? "");
      const name = String(row["process_name"] ?? "");
      if (sid.length === 0 || name.length === 0) continue;
      const arr = out.get(sid);
      if (arr === undefined) out.set(sid, [name]);
      else arr.push(name);
    }
  } catch {
    // ignore
  }
  return out;
}

// ---------------------------------------------------------------------------
// Text rendering — intentionally terse; Claude Code's hook inlines the body
// directly into the model's context, so every byte is billed.
// ---------------------------------------------------------------------------

function renderBlock(hits: readonly EnrichedHit[], repoName: string): string {
  if (hits.length === 0) return "";
  const lines: string[] = [`[codehub:${repoName}] ${hits.length} related symbols:`, ""];
  for (const h of hits) {
    lines.push(`${h.name} [${h.kind}] — ${h.filePath}`);
    if (h.callers.length > 0) lines.push(`  called by: ${h.callers.join(", ")}`);
    if (h.callees.length > 0) lines.push(`  calls: ${h.callees.join(", ")}`);
    if (h.processes.length > 0) lines.push(`  flows: ${h.processes.join(", ")}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
