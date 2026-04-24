/**
 * Resource template `codehub://repo/{name}/process/{processName}` — process trace.
 *
 * Resolves `processName` against the Process node's `name` first (the
 * synthesised `<entry>-flow` token), then its `inferredLabel` as a
 * fallback. The ordered trace walks PROCESS_STEP edges starting from
 * the entry point (step 0) through every BFS-reached symbol. Unknown
 * names produce a `{error, candidates}` envelope listing up to 5 close
 * matches.
 *
 * PROCESS_STEP edges live between callable symbols (not between the
 * Process node and its members). The entry point itself is the
 * `from_id` of the first step emitted by the phase; we surface it as
 * step 0 with its own row so the trace is usable standalone.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ListResourcesResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { DuckDbStore } from "@opencodehub/storage";
import { readRegistry } from "../repo-resolver.js";
import { rankCandidates } from "./repo-cluster.js";
import type { ResourceContext } from "./repos.js";
import { withResourceStore } from "./store-helper.js";
import { yamlScalar } from "./yaml.js";

const PATTERN = "codehub://repo/{name}/process/{processName}";
const CANDIDATES_CAP = 5;

export function registerRepoProcessResource(server: McpServer, ctx: ResourceContext): void {
  const template = new ResourceTemplate(PATTERN, {
    list: async (): Promise<ListResourcesResult> => {
      const opts = ctx.home !== undefined ? { home: ctx.home } : {};
      const reg = await readRegistry(opts);
      return {
        resources: Object.keys(reg)
          .sort()
          .map((name) => ({
            name: `${name}/process/{processName}`,
            uri: `codehub://repo/${encodeURIComponent(name)}/process/{processName}`,
            mimeType: "text/yaml",
            description: `Ordered PROCESS_STEP trace for a named process in repo ${name}`,
          })),
      };
    },
  });
  server.registerResource(
    "repo-process",
    template,
    {
      title: "Repo process trace",
      description:
        "YAML ordered PROCESS_STEP trace for a named process (entry point first; step ASC).",
      mimeType: "text/yaml",
    },
    async (uri, variables): Promise<ReadResourceResult> => {
      const nameRaw = variables["name"];
      const processRaw = variables["processName"];
      const nameVar = Array.isArray(nameRaw) ? nameRaw[0] : nameRaw;
      const processVar = Array.isArray(processRaw) ? processRaw[0] : processRaw;
      const repoName = nameVar ? decodeURIComponent(String(nameVar)) : undefined;
      const processName = processVar ? decodeURIComponent(String(processVar)) : "";

      const resourceOpts: { home?: string; pool?: typeof ctx.pool } = {};
      if (ctx.home !== undefined) resourceOpts.home = ctx.home;
      if (ctx.pool !== undefined) resourceOpts.pool = ctx.pool;

      return withResourceStore(uri.href, repoName, resourceOpts, async (store, resolvedRepo) => {
        const matchRows = (await store.query(
          `SELECT id, name, inferred_label, entry_point_id, step_count, file_path
           FROM nodes
           WHERE kind = 'Process' AND (name = ? OR inferred_label = ?)
           ORDER BY id ASC
           LIMIT 1`,
          [processName, processName],
        )) as readonly Record<string, unknown>[];

        if (matchRows.length === 0) {
          return buildNotFound(uri.href, resolvedRepo, processName, store);
        }
        const hit = matchRows[0];
        if (!hit) {
          return buildNotFound(uri.href, resolvedRepo, processName, store);
        }
        const processId = String(hit["id"] ?? "");
        const processRowName = String(hit["name"] ?? "");
        const processLabel =
          typeof hit["inferred_label"] === "string" && hit["inferred_label"].length > 0
            ? String(hit["inferred_label"])
            : null;
        const entryPointId =
          typeof hit["entry_point_id"] === "string" && hit["entry_point_id"].length > 0
            ? String(hit["entry_point_id"])
            : null;
        const processFilePath = String(hit["file_path"] ?? "");

        // Gather every symbol reached by PROCESS_STEP edges rooted at the
        // entry point. The phase emits steps between callable symbols; we
        // union from_id + to_id so the entry point itself (which is only
        // ever a `from_id` at step 1) appears in the trace at step 0.
        const traceRows = entryPointId ? await walkProcessTrace(store, entryPointId) : [];

        const lines: string[] = [];
        lines.push(`repo: ${yamlScalar(resolvedRepo)}`);
        lines.push("process:");
        lines.push(`  id: ${yamlScalar(processId)}`);
        lines.push(`  name: ${yamlScalar(processRowName)}`);
        if (processLabel) {
          lines.push(`  label: ${yamlScalar(processLabel)}`);
        }
        lines.push(`  processType: flow`);
        if (entryPointId) {
          lines.push(`  entryPointId: ${yamlScalar(entryPointId)}`);
        }
        if (processFilePath) {
          lines.push(`  filePath: ${yamlScalar(processFilePath)}`);
        }
        lines.push("trace:");
        if (traceRows.length === 0) {
          lines.push("  []");
        } else {
          for (const row of traceRows) {
            lines.push(`  - step: ${row.step}`);
            lines.push(`    id: ${yamlScalar(row.id)}`);
            lines.push(`    name: ${yamlScalar(row.name)}`);
            lines.push(`    kind: ${yamlScalar(row.kind)}`);
            lines.push(`    filePath: ${yamlScalar(row.filePath)}`);
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

interface TraceRow {
  readonly step: number;
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly filePath: string;
}

/**
 * Walk PROCESS_STEP edges rooted at `entryPointId` and return an ordered
 * (step ASC) list of participating symbols. The entry point itself is
 * surfaced as step 0; PROCESS_STEP rows populate the subsequent steps.
 */
async function walkProcessTrace(
  store: DuckDbStore,
  entryPointId: string,
): Promise<readonly TraceRow[]> {
  // Seed with the entry-point node at step 0.
  const entryRows = (await store.query(
    `SELECT id, name, kind, file_path FROM nodes WHERE id = ? LIMIT 1`,
    [entryPointId],
  )) as readonly Record<string, unknown>[];
  const out: TraceRow[] = [];
  const seen = new Set<string>();
  if (entryRows.length > 0) {
    const r = entryRows[0];
    if (r) {
      out.push({
        step: 0,
        id: String(r["id"] ?? ""),
        name: String(r["name"] ?? ""),
        kind: String(r["kind"] ?? ""),
        filePath: String(r["file_path"] ?? ""),
      });
      seen.add(String(r["id"] ?? ""));
    }
  }

  // PROCESS_STEP edges share the same (from_id, to_id, step). We walk the
  // closure reachable from `entryPointId` by any chain of steps — joining
  // relations to relations via (from_id, to_id) is an expensive recursive
  // CTE; instead we iterate in application code and rely on the phase's
  // 30-node cap to bound the walk.
  const queue: string[] = [entryPointId];
  let guard = 0;
  while (queue.length > 0 && guard < 100) {
    guard += 1;
    const current = queue.shift() as string;
    const edges = (await store.query(
      `SELECT r.to_id AS to_id, r.step AS step, n.name AS name, n.kind AS kind, n.file_path AS file_path
       FROM relations r
       JOIN nodes n ON n.id = r.to_id
       WHERE r.type = 'PROCESS_STEP' AND r.from_id = ?
       ORDER BY r.step ASC, n.id ASC`,
      [current],
    )) as readonly Record<string, unknown>[];
    for (const row of edges) {
      const toId = String(row["to_id"] ?? "");
      if (!toId || seen.has(toId)) continue;
      seen.add(toId);
      const step = typeof row["step"] === "number" ? row["step"] : Number(row["step"] ?? 0);
      out.push({
        step,
        id: toId,
        name: String(row["name"] ?? ""),
        kind: String(row["kind"] ?? ""),
        filePath: String(row["file_path"] ?? ""),
      });
      queue.push(toId);
    }
  }
  out.sort((a, b) => {
    if (a.step !== b.step) return a.step - b.step;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return out;
}

async function buildNotFound(
  uri: string,
  repoName: string,
  processName: string,
  store: DuckDbStore,
): Promise<ReadResourceResult> {
  const allRows = (await store.query(
    `SELECT name, inferred_label
     FROM nodes
     WHERE kind = 'Process'
     ORDER BY COALESCE(step_count, 0) DESC, id ASC`,
    [],
  )) as readonly Record<string, unknown>[];
  const candidates = rankCandidates(
    processName,
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
  lines.push(`process: ${yamlScalar(processName)}`);
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
