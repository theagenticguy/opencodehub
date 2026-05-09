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
import type { GraphNode, ProcessNode } from "@opencodehub/core-types";
import type { IGraphStore } from "@opencodehub/storage";
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
        const graph = store.graph;
        const processes = (await graph.listNodesByKind("Process")) as readonly ProcessNode[];
        const hit = processes.find(
          (p) => p.name === processName || p.inferredLabel === processName,
        );

        if (hit === undefined) {
          return buildNotFound(uri.href, resolvedRepo, processName, processes);
        }
        const processId = hit.id;
        const processRowName = hit.name;
        const processLabel =
          typeof hit.inferredLabel === "string" && hit.inferredLabel.length > 0
            ? hit.inferredLabel
            : null;
        const entryPointId =
          typeof hit.entryPointId === "string" && hit.entryPointId.length > 0
            ? hit.entryPointId
            : null;
        const processFilePath = hit.filePath;

        const traceRows = entryPointId ? await walkProcessTrace(graph, entryPointId) : [];

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
  graph: IGraphStore,
  entryPointId: string,
): Promise<readonly TraceRow[]> {
  // Snapshot all nodes once for partner metadata lookup.
  const allNodes = await graph.listNodes();
  const byId = new Map<string, GraphNode>();
  for (const n of allNodes) byId.set(n.id, n);
  const allEdges = await graph.listEdgesByType("PROCESS_STEP");
  const adj = new Map<string, { toId: string; step: number }[]>();
  for (const e of allEdges) {
    const list = adj.get(e.from) ?? [];
    list.push({ toId: e.to, step: e.step ?? 0 });
    adj.set(e.from, list);
  }
  for (const list of adj.values()) {
    list.sort((a, b) => {
      if (a.step !== b.step) return a.step - b.step;
      return a.toId < b.toId ? -1 : a.toId > b.toId ? 1 : 0;
    });
  }

  const out: TraceRow[] = [];
  const seen = new Set<string>();
  const entryNode = byId.get(entryPointId);
  if (entryNode !== undefined) {
    out.push({
      step: 0,
      id: entryNode.id,
      name: entryNode.name,
      kind: entryNode.kind,
      filePath: entryNode.filePath,
    });
    seen.add(entryNode.id);
  }

  const queue: string[] = [entryPointId];
  let guard = 0;
  while (queue.length > 0 && guard < 100) {
    guard += 1;
    const current = queue.shift() as string;
    const outgoing = adj.get(current) ?? [];
    for (const e of outgoing) {
      if (seen.has(e.toId)) continue;
      seen.add(e.toId);
      const partner = byId.get(e.toId);
      out.push({
        step: e.step,
        id: e.toId,
        name: partner?.name ?? "",
        kind: partner?.kind ?? "",
        filePath: partner?.filePath ?? "",
      });
      queue.push(e.toId);
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
  processes: readonly ProcessNode[],
): Promise<ReadResourceResult> {
  const ordered = [...processes].sort((a, b) => {
    const ac = a.stepCount ?? 0;
    const bc = b.stepCount ?? 0;
    if (ac !== bc) return bc - ac;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const candidates = rankCandidates(
    processName,
    ordered.flatMap((p) => {
      const out: string[] = [];
      const n = typeof p.name === "string" ? p.name : null;
      const l = typeof p.inferredLabel === "string" ? p.inferredLabel : null;
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
