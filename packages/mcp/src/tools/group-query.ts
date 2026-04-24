/**
 * `group_query` — BM25 on each repo in a group, fused with RRF (k=60).
 *
 * Response contract:
 *   {
 *     group:    string,
 *     query:    string,
 *     results:  [{ _repo, _rrf_score, nodeId, name, kind, filePath }],
 *     per_repo: [{ repo, count, error? }],
 *     warnings: string[],
 *   }
 *
 * Determinism:
 *   - Repo iteration is the alphabetical sort of `group.repos[*].name`.
 *   - BM25 ties are broken by `id ASC` in the DuckDB adapter.
 *   - RRF tiebreak falls back to lex `(_repo, nodeId)` ordering (the
 *     underlying `rrf()` breaks ties by first-run / first-rank; we do the
 *     final lex pass ourselves to keep cross-run order stable).
 *   - Per-repo BM25 limit scales with the outer `limit` so small groups
 *     don't silently truncate and large groups don't pull unnecessarily.
 *
 * Graceful degradation:
 *   - A repo missing from the registry, a missing DB file, or a DuckDB
 *     open error all emit a `per_repo[]` row with an `error` string and a
 *     human-readable entry in `warnings[]`. The fan-out continues; the
 *     tool never aborts unless the group itself is unknown.
 */
// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures

import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bm25Search, DEFAULT_RRF_K, DEFAULT_RRF_TOP_K, rrf } from "@opencodehub/search";
import { resolveDbPath } from "@opencodehub/storage";
import { z } from "zod";
import { toolError, toolErrorFromUnknown } from "../error-envelope.js";
import { readGroup } from "../group-resolver.js";
import { withNextSteps } from "../next-step-hints.js";
import { readRegistry } from "../repo-resolver.js";
import { fromToolResult, type ToolContext, type ToolResult, toToolResult } from "./shared.js";

const GroupQueryInput = {
  groupName: z.string().min(1).describe("Name of the group to query."),
  query: z.string().min(1).describe("Free-text BM25 search phrase."),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe("Maximum merged results to return (default 20, max 100)."),
  subgroup: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Optional filter — only these repo names (by registry name) from the group are queried. Unknown names are silently ignored.",
    ),
  kinds: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Optional node-kind filter passed through to BM25 on every member repo (e.g. ["Function", "Method"]).',
    ),
};

/** Row shape persisted in the per-call meta map; emitted verbatim in `results[]`. */
interface ResultRow {
  readonly _repo: string;
  readonly _rrf_score: number;
  readonly nodeId: string;
  readonly name: string;
  readonly kind: string;
  readonly filePath: string;
  /** Raw per-repo BM25 score, kept so operators can inspect contribution vs RRF. */
  readonly score: number;
}

interface PerRepoRow {
  readonly repo: string;
  readonly count: number;
  readonly error?: string;
}

/** Soft caps so the per-repo limit stays bounded regardless of caller input. */
const PER_REPO_BM25_MIN = 20;
const PER_REPO_BM25_MAX = 200;

/**
 * Scale per-repo BM25 limit with outer limit + group cardinality.
 * Heuristic: each member contributes up to `2 * limit / numRepos` hits, floor
 * at the outer limit (so a single-repo group still gets `limit` candidates),
 * cap at 200 to protect the RRF merge loop.
 */
function perRepoBm25Limit(outerLimit: number, numRepos: number): number {
  if (numRepos <= 0) return outerLimit;
  const heuristic = Math.ceil((outerLimit * 2) / numRepos);
  return Math.max(PER_REPO_BM25_MIN, Math.min(PER_REPO_BM25_MAX, Math.max(outerLimit, heuristic)));
}

interface GroupQueryArgs {
  readonly groupName: string;
  readonly query: string;
  readonly limit?: number | undefined;
  readonly subgroup?: readonly string[] | undefined;
  readonly kinds?: readonly string[] | undefined;
}

export async function runGroupQuery(ctx: ToolContext, args: GroupQueryArgs): Promise<ToolResult> {
  try {
    const limit = args.limit ?? 20;
    const opts = ctx.home !== undefined ? { home: ctx.home } : {};
    const group = await readGroup(args.groupName, opts);
    if (!group) {
      return toToolResult(
        toolError(
          "NOT_FOUND",
          `Group ${args.groupName} is not defined.`,
          "Run `codehub group list` to see defined groups.",
        ),
      );
    }
    const registry = await readRegistry(opts);

    // Stable iteration order: alphabetical by registry name.
    const sortedRepos = [...group.repos].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );

    // Optional subgroup filter — skip members not in the subgroup set.
    const subgroupFilter =
      args.subgroup && args.subgroup.length > 0 ? new Set(args.subgroup) : undefined;
    const targetRepos = subgroupFilter
      ? sortedRepos.filter((r) => subgroupFilter.has(r.name))
      : sortedRepos;

    const perRepoLimit = perRepoBm25Limit(limit, Math.max(targetRepos.length, 1));

    const meta = new Map<string, ResultRow>();
    const runs: { id: string }[][] = [];
    const perRepo: PerRepoRow[] = [];
    const warnings: string[] = [];

    for (const repo of targetRepos) {
      const hit = registry[repo.name];
      if (!hit) {
        perRepo.push({ repo: repo.name, count: 0, error: "not_in_registry" });
        warnings.push(
          `${repo.name}: not in registry — run \`codehub analyze\` in that repo, then retry.`,
        );
        continue;
      }
      const repoPath = resolve(hit.path);
      const dbPath = resolveDbPath(repoPath);

      let store: Awaited<ReturnType<typeof ctx.pool.acquire>>;
      try {
        store = await ctx.pool.acquire(repoPath, dbPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        perRepo.push({ repo: repo.name, count: 0, error: "open_failed" });
        warnings.push(`${repo.name}: failed to open index (${msg}).`);
        continue;
      }

      try {
        const bm25Query =
          args.kinds && args.kinds.length > 0
            ? { text: args.query, kinds: args.kinds, limit: perRepoLimit }
            : { text: args.query, limit: perRepoLimit };
        const results = await bm25Search(store, bm25Query);
        const ranked: { id: string }[] = [];
        for (const r of results) {
          const id = `${repo.name}::${r.nodeId}`;
          ranked.push({ id });
          if (!meta.has(id)) {
            meta.set(id, {
              _repo: repo.name,
              _rrf_score: 0,
              nodeId: r.nodeId,
              name: r.name,
              kind: r.kind,
              filePath: r.filePath,
              score: r.score,
            });
          }
        }
        runs.push(ranked);
        perRepo.push({ repo: repo.name, count: results.length });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        perRepo.push({ repo: repo.name, count: 0, error: "query_failed" });
        warnings.push(`${repo.name}: BM25 query failed (${msg}).`);
      } finally {
        await ctx.pool.release(repoPath);
      }
    }

    const fused = rrf(runs, DEFAULT_RRF_K, Math.max(limit, DEFAULT_RRF_TOP_K));
    const rows: ResultRow[] = [];
    for (const f of fused) {
      const row = meta.get(f.id);
      if (!row) continue;
      rows.push({ ...row, _rrf_score: f.score });
    }
    // Deterministic final ordering: _rrf_score desc, then (_repo, nodeId) lex asc.
    rows.sort((a, b) => {
      if (a._rrf_score !== b._rrf_score) return b._rrf_score - a._rrf_score;
      if (a._repo !== b._repo) return a._repo < b._repo ? -1 : 1;
      if (a.nodeId !== b.nodeId) return a.nodeId < b.nodeId ? -1 : 1;
      return 0;
    });
    const top = rows.slice(0, limit);

    const reposQueried = perRepo.filter((r) => r.error === undefined).map((r) => r.repo);
    const header = `Top ${top.length} match(es) for "${args.query}" in group ${group.name} (${reposQueried.length} repo${reposQueried.length === 1 ? "" : "s"} queried, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}):`;
    const body =
      top.length === 0
        ? "(no matches — try a broader phrase)"
        : top
            .map(
              (r, i) =>
                `${i + 1}. [${r._repo}] ${r.name} [${r.kind}] — ${r.filePath} (rrf ${r._rrf_score.toFixed(4)})`,
            )
            .join("\n");
    const warnLines = warnings.length > 0 ? `\n\nWarnings:\n- ${warnings.join("\n- ")}` : "";
    const next =
      top.length === 0
        ? ["broaden the query or review group composition with `group_status`"]
        : [
            `call \`context\` with symbol="${top[0]?.name ?? ""}" and repo="${top[0]?._repo ?? ""}" to inspect the top hit`,
            `call \`group_status\` with groupName="${group.name}" if results look stale`,
          ];

    return toToolResult(
      withNextSteps(
        `${header}\n${body}${warnLines}`,
        {
          group: group.name,
          query: args.query,
          results: top,
          per_repo: perRepo,
          warnings,
        },
        next,
      ),
    );
  } catch (err) {
    return toToolResult(toolErrorFromUnknown(err));
  }
}

export function registerGroupQueryTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "group_query",
    {
      title: "Cross-repo search",
      description:
        "Run BM25 against every repo in a named group and fuse the per-repo rankings with Reciprocal Rank Fusion (RRF, k=60). Useful when a concept spans client and server repos. Repos are visited in alphabetical order so ties are deterministic. Per-repo errors are reported in `per_repo[].error` and `warnings[]` — the fan-out never aborts on a single-repo failure.",
      inputSchema: GroupQueryInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => fromToolResult(await runGroupQuery(ctx, args)),
  );
}
