/**
 * Resource template `codehub://repo/{name}/cluster/{clusterName}` — cluster members.
 *
 * Resolves `clusterName` against the Community node's `name` (stable
 * `community-<id>` token) first, then its `inferredLabel` as a fallback
 * so agents can pass the human-readable label. Members are joined via
 * `MEMBER_OF` edges and ranked by `kind, name`. Cap at 100. Unknown
 * names produce a `{error, candidates}` envelope listing up to 5
 * similar cluster names.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ListResourcesResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { CommunityNode, GraphNode } from "@opencodehub/core-types";
import { readRegistry } from "../repo-resolver.js";
import type { ResourceContext } from "./repos.js";
import { withResourceStore } from "./store-helper.js";
import { yamlScalar } from "./yaml.js";

const PATTERN = "codehub://repo/{name}/cluster/{clusterName}";
const MEMBERS_CAP = 100;
const CANDIDATES_CAP = 5;

export function registerRepoClusterResource(server: McpServer, ctx: ResourceContext): void {
  const template = new ResourceTemplate(PATTERN, {
    list: async (): Promise<ListResourcesResult> => {
      const opts = ctx.home !== undefined ? { home: ctx.home } : {};
      const reg = await readRegistry(opts);
      return {
        resources: Object.keys(reg)
          .sort()
          .map((name) => ({
            name: `${name}/cluster/{clusterName}`,
            uri: `codehub://repo/${encodeURIComponent(name)}/cluster/{clusterName}`,
            mimeType: "text/yaml",
            description: `Members of a community cluster in repo ${name}`,
          })),
      };
    },
  });
  server.registerResource(
    "repo-cluster",
    template,
    {
      title: "Repo cluster members",
      description:
        "YAML list of symbols that MEMBER_OF a named community cluster. Cap 100. Ranked by kind, name.",
      mimeType: "text/yaml",
    },
    async (uri, variables): Promise<ReadResourceResult> => {
      const nameRaw = variables["name"];
      const clusterRaw = variables["clusterName"];
      const nameVar = Array.isArray(nameRaw) ? nameRaw[0] : nameRaw;
      const clusterVar = Array.isArray(clusterRaw) ? clusterRaw[0] : clusterRaw;
      const repoName = nameVar ? decodeURIComponent(String(nameVar)) : undefined;
      const clusterName = clusterVar ? decodeURIComponent(String(clusterVar)) : "";

      const resourceOpts: { home?: string; pool?: typeof ctx.pool } = {};
      if (ctx.home !== undefined) resourceOpts.home = ctx.home;
      if (ctx.pool !== undefined) resourceOpts.pool = ctx.pool;

      return withResourceStore(uri.href, repoName, resourceOpts, async (store, resolvedRepo) => {
        const graph = store.graph;
        const communities = (await graph.listNodesByKind("Community")) as readonly CommunityNode[];
        const hit = communities.find(
          (c) => c.name === clusterName || c.inferredLabel === clusterName,
        );

        if (hit === undefined) {
          return buildNotFound(uri.href, resolvedRepo, clusterName, communities);
        }
        const communityId = hit.id;
        const communityLabel =
          typeof hit.inferredLabel === "string" && hit.inferredLabel.length > 0
            ? hit.inferredLabel
            : null;
        const communityName = hit.name;

        const memberEdges = await graph.listEdgesByType("MEMBER_OF", { toIds: [communityId] });
        const memberIds = Array.from(new Set(memberEdges.map((e) => e.from)));
        const members: GraphNode[] =
          memberIds.length > 0 ? [...(await graph.listNodes({ ids: memberIds }))] : [];
        members.sort((a, b) => {
          if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
          if (a.name !== b.name) return a.name < b.name ? -1 : 1;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
        const cappedMembers = members.slice(0, MEMBERS_CAP);

        const lines: string[] = [];
        lines.push(`repo: ${yamlScalar(resolvedRepo)}`);
        lines.push(`cluster:`);
        lines.push(`  id: ${yamlScalar(communityId)}`);
        lines.push(`  name: ${yamlScalar(communityName)}`);
        if (communityLabel) {
          lines.push(`  label: ${yamlScalar(communityLabel)}`);
        }
        lines.push("members:");
        if (cappedMembers.length === 0) {
          lines.push("  []");
        } else {
          for (const m of cappedMembers) {
            lines.push(`  - id: ${yamlScalar(m.id)}`);
            lines.push(`    name: ${yamlScalar(m.name)}`);
            lines.push(`    kind: ${yamlScalar(m.kind)}`);
            lines.push(`    filePath: ${yamlScalar(m.filePath)}`);
          }
        }
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/yaml",
              text: `${lines.join("\n")}\n`,
            },
          ],
        };
      });
    },
  );
}

async function buildNotFound(
  uri: string,
  repoName: string,
  clusterName: string,
  communities: readonly CommunityNode[],
): Promise<ReadResourceResult> {
  const ordered = [...communities].sort((a, b) => {
    const ac = a.symbolCount ?? 0;
    const bc = b.symbolCount ?? 0;
    if (ac !== bc) return bc - ac;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const candidates = rankCandidates(
    clusterName,
    ordered.flatMap((c) => {
      const out: string[] = [];
      const n = typeof c.name === "string" ? c.name : null;
      const l = typeof c.inferredLabel === "string" ? c.inferredLabel : null;
      if (n) out.push(n);
      if (l && l !== n) out.push(l);
      return out;
    }),
  ).slice(0, CANDIDATES_CAP);

  const lines: string[] = [];
  lines.push(`repo: ${yamlScalar(repoName)}`);
  lines.push(`cluster: ${yamlScalar(clusterName)}`);
  lines.push('error: "not found"');
  lines.push("candidates:");
  if (candidates.length === 0) {
    lines.push("  []");
  } else {
    for (const c of candidates) {
      lines.push(`  - ${yamlScalar(c)}`);
    }
  }
  return {
    contents: [
      {
        uri,
        mimeType: "text/yaml",
        text: `${lines.join("\n")}\n`,
      },
    ],
  };
}

/**
 * Deterministic substring-first, Levenshtein-tiebreak ranker. Simple
 * enough to be obviously correct; good enough to offer 5 neighbours.
 */
export function rankCandidates(needle: string, haystack: readonly string[]): readonly string[] {
  const lower = needle.toLowerCase();
  const scored = haystack.map((h) => {
    const lh = h.toLowerCase();
    let score = 0;
    if (lh === lower) score = 1000;
    else if (lh.startsWith(lower)) score = 500 - Math.abs(lh.length - lower.length);
    else if (lh.includes(lower)) score = 250 - Math.abs(lh.length - lower.length);
    else score = 100 - levenshtein(lh, lower);
    return { value: h, score };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  });
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of scored) {
    if (seen.has(s.value)) continue;
    seen.add(s.value);
    out.push(s.value);
  }
  return out;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev: number[] = new Array(b.length + 1);
  const cur: number[] = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((cur[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = cur[j] ?? 0;
  }
  return prev[b.length] ?? 0;
}
