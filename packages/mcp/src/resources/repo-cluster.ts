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
import type { DuckDbStore } from "@opencodehub/storage";
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
        const matchRows = (await store.query(
          `SELECT id, name, inferred_label
           FROM nodes
           WHERE kind = 'Community' AND (name = ? OR inferred_label = ?)
           ORDER BY id ASC
           LIMIT 1`,
          [clusterName, clusterName],
        )) as readonly Record<string, unknown>[];

        if (matchRows.length === 0) {
          return buildNotFound(uri.href, resolvedRepo, clusterName, store);
        }
        const hit = matchRows[0];
        if (!hit) {
          return buildNotFound(uri.href, resolvedRepo, clusterName, store);
        }
        const communityId = String(hit["id"] ?? "");
        const communityLabel =
          typeof hit["inferred_label"] === "string" && hit["inferred_label"].length > 0
            ? String(hit["inferred_label"])
            : null;
        const communityName = String(hit["name"] ?? "");

        const members = (await store.query(
          `SELECT n.id AS id, n.name AS name, n.kind AS kind, n.file_path AS file_path
           FROM relations r
           JOIN nodes n ON n.id = r.from_id
           WHERE r.type = 'MEMBER_OF' AND r.to_id = ?
           ORDER BY n.kind ASC, n.name ASC, n.id ASC
           LIMIT ?`,
          [communityId, MEMBERS_CAP],
        )) as readonly Record<string, unknown>[];

        const lines: string[] = [];
        lines.push(`repo: ${yamlScalar(resolvedRepo)}`);
        lines.push(`cluster:`);
        lines.push(`  id: ${yamlScalar(communityId)}`);
        lines.push(`  name: ${yamlScalar(communityName)}`);
        if (communityLabel) {
          lines.push(`  label: ${yamlScalar(communityLabel)}`);
        }
        lines.push("members:");
        if (members.length === 0) {
          lines.push("  []");
        } else {
          for (const raw of members) {
            lines.push(`  - id: ${yamlScalar(String(raw["id"] ?? ""))}`);
            lines.push(`    name: ${yamlScalar(String(raw["name"] ?? ""))}`);
            lines.push(`    kind: ${yamlScalar(String(raw["kind"] ?? ""))}`);
            lines.push(`    filePath: ${yamlScalar(String(raw["file_path"] ?? ""))}`);
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
  store: DuckDbStore,
): Promise<ReadResourceResult> {
  const allRows = (await store.query(
    `SELECT name, inferred_label
     FROM nodes
     WHERE kind = 'Community'
     ORDER BY COALESCE(symbol_count, 0) DESC, id ASC`,
    [],
  )) as readonly Record<string, unknown>[];
  const candidates = rankCandidates(
    clusterName,
    allRows.flatMap((r) => {
      const out: string[] = [];
      const n = typeof r["name"] === "string" ? r["name"] : null;
      const l = typeof r["inferred_label"] === "string" ? r["inferred_label"] : null;
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
