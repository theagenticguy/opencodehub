/**
 * `group_contracts` — cross-repo HTTP-contract discovery.
 *
 * For every repo in a named group, read the unresolved FETCHES edges
 * stored by the `fetches` ingestion phase (target id prefixed with
 * `fetches:unresolved:METHOD:URL`). Each unresolved edge is then matched
 * against the `Route` nodes in every OTHER repo in the group. A match
 * surfaces as a `contract` row mapping consumer → producer.
 *
 * Determinism:
 *   - Repos iterate in alphabetical order.
 *   - Contracts are sorted by (consumerRepo, consumerSymbol, method,
 *     path, producerRepo) so repeated calls yield stable output.
 *
 * Annotations: readOnlyHint, idempotentHint, openWorldHint:false — the
 * tool never reaches past the named group.
 */
// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContractRegistry } from "@opencodehub/analysis";
import type { IGraphStore } from "@opencodehub/storage";
import { resolveGraphPath } from "@opencodehub/storage";
import { z } from "zod";
import { toolError, toolErrorFromUnknown } from "../error-envelope.js";
import { readGroup } from "../group-resolver.js";
import { withNextSteps } from "../next-step-hints.js";
import { readRegistry } from "../repo-resolver.js";
import { repoUriForEntry } from "../repo-uri-for-entry.js";
import { resolveGroupContractsPath } from "./group-sync.js";
import { fromToolResult, type ToolContext, type ToolResult, toToolResult } from "./shared.js";

const UNRESOLVED_PREFIX = "fetches:unresolved:";

const GroupContractsInput = {
  groupName: z.string().min(1).describe("Name of the group to inspect."),
};

interface ContractRow {
  readonly consumerRepo: string;
  /** Cross-repo handle for the consumer repo. */
  readonly consumerRepoUri: string;
  readonly consumerSymbol: string;
  readonly producerRepo: string;
  /** Cross-repo handle for the producer repo. */
  readonly producerRepoUri: string;
  readonly producerRoute: string;
  readonly method: string;
  readonly path: string;
}

interface ConsumerEdgeRow {
  readonly consumerSymbol: string;
  readonly method: string;
  readonly path: string;
}

interface RouteRow {
  readonly nodeId: string;
  readonly method: string;
  readonly url: string;
}

/** Canonicalize a URL template so `:id`, `{id}`, trailing-slash variants
 *  collapse into a single key. */
function normalizePath(raw: string): string {
  return raw
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}")
    .replace(/\?.*$/, "")
    .replace(/\/+$/, "");
}

function parseUnresolvedTarget(target: string): { method: string; path: string } | undefined {
  if (!target.startsWith(UNRESOLVED_PREFIX)) return undefined;
  const rest = target.slice(UNRESOLVED_PREFIX.length);
  const colon = rest.indexOf(":");
  if (colon < 0) return undefined;
  const method = rest.slice(0, colon).toUpperCase();
  const path = rest.slice(colon + 1);
  return { method, path };
}

async function readConsumerEdges(graph: IGraphStore): Promise<readonly ConsumerEdgeRow[]> {
  const fetches = await graph.listEdgesByType("FETCHES");
  const sorted = [...fetches].sort((a, b) => {
    if (a.from !== b.from) return a.from < b.from ? -1 : 1;
    return a.to < b.to ? -1 : a.to > b.to ? 1 : 0;
  });
  const out: ConsumerEdgeRow[] = [];
  for (const e of sorted) {
    const parsed = parseUnresolvedTarget(e.to);
    if (parsed === undefined) continue;
    out.push({
      consumerSymbol: e.from,
      method: parsed.method,
      path: normalizePath(parsed.path),
    });
  }
  return out;
}

async function readProducerRoutes(graph: IGraphStore): Promise<readonly RouteRow[]> {
  const routes = await graph.listRoutes();
  const sorted = [...routes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: RouteRow[] = [];
  for (const r of sorted) {
    if (typeof r.url !== "string" || r.url.length === 0) continue;
    const method = (r.method ?? "GET").toUpperCase();
    out.push({ nodeId: r.id, method, url: r.url });
  }
  return out;
}

interface GroupContractsArgs {
  readonly groupName: string;
}

export async function runGroupContracts(
  ctx: ToolContext,
  args: GroupContractsArgs,
): Promise<ToolResult> {
  try {
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
    const sortedRepos = [...group.repos].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );

    const missing: string[] = [];
    const consumersByRepo = new Map<string, readonly ConsumerEdgeRow[]>();
    const producersByRepo = new Map<string, readonly RouteRow[]>();
    // Resolve `repo_uri` for every registered member so every
    // ContractRow carries `consumerRepoUri` / `producerRepoUri`.
    const repoUriByName = new Map<string, string>();

    for (const repo of sortedRepos) {
      const hit = registry[repo.name];
      if (!hit) {
        missing.push(repo.name);
        continue;
      }
      repoUriByName.set(repo.name, await repoUriForEntry(hit, ctx.pool));
      const repoPath = resolve(hit.path);
      const dbPath = resolveGraphPath(repoPath);
      const store = await ctx.pool.acquire(repoPath, dbPath).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to open graph store for ${repo.name}: ${msg}`);
      });
      try {
        const [consumers, producers] = await Promise.all([
          readConsumerEdges(store.graph),
          readProducerRoutes(store.graph),
        ]);
        consumersByRepo.set(repo.name, consumers);
        producersByRepo.set(repo.name, producers);
      } finally {
        await ctx.pool.release(repoPath);
      }
    }

    const contracts: ContractRow[] = [];
    for (const [consumerRepo, consumers] of consumersByRepo) {
      for (const consumer of consumers) {
        // Search every OTHER repo in the group for a Route matching
        // method + normalized path.
        for (const [producerRepo, producers] of producersByRepo) {
          if (producerRepo === consumerRepo) continue;
          for (const route of producers) {
            if (route.method !== consumer.method) continue;
            if (normalizePath(route.url) !== consumer.path) continue;
            // Both sides must be registered members (consumers/producers
            // were only populated for registered repos), so the uri map
            // has a hit — but guard with an empty-string fallback to
            // keep the type `string` not `string | undefined`.
            const consumerRepoUri = repoUriByName.get(consumerRepo) ?? "";
            const producerRepoUri = repoUriByName.get(producerRepo) ?? "";
            contracts.push({
              consumerRepo,
              consumerRepoUri,
              consumerSymbol: consumer.consumerSymbol,
              producerRepo,
              producerRepoUri,
              producerRoute: route.nodeId,
              method: consumer.method,
              path: consumer.path,
            });
          }
        }
      }
    }

    contracts.sort((a, b) => {
      if (a.consumerRepo !== b.consumerRepo) return a.consumerRepo < b.consumerRepo ? -1 : 1;
      if (a.consumerSymbol !== b.consumerSymbol)
        return a.consumerSymbol < b.consumerSymbol ? -1 : 1;
      if (a.method !== b.method) return a.method < b.method ? -1 : 1;
      if (a.path !== b.path) return a.path < b.path ? -1 : 1;
      if (a.producerRepo !== b.producerRepo) return a.producerRepo < b.producerRepo ? -1 : 1;
      return a.producerRoute < b.producerRoute ? -1 : 1;
    });

    // Secondary surface: the ContractRegistry persisted by `group_sync`.
    // When the file exists we expose its cross-links + contract hashes so
    // agents can browse HTTP, gRPC, and topic pairings without re-running
    // the extractors themselves.
    const persisted = await loadPersistedRegistry(group.name, ctx.home);
    const crossLinks = persisted?.crossLinks ?? [];

    const header = `Cross-repo contracts for group ${group.name}: ${contracts.length} DuckDB-backed HTTP edge(s), ${crossLinks.length} registry cross-link(s).`;
    const body =
      contracts.length === 0
        ? "(no FETCH-derived contracts — verify consumer repos ran the `fetches` phase and producer repos registered Route nodes)"
        : contracts
            .map(
              (c) =>
                `- [${c.consumerRepo}] ${c.consumerSymbol} → [${c.producerRepo}] ${c.method} ${c.path}`,
            )
            .join("\n");
    const crossLinkBody =
      crossLinks.length === 0
        ? ""
        : `\n\nCross-links (from group_sync registry):\n${crossLinks
            .slice(0, 50)
            .map(
              (l) =>
                `- [${l.producer.repo}] ${l.producer.type} "${l.producer.signature}" (${l.producer.file}:${l.producer.line}) ↔ [${l.consumer.repo}] ${l.consumer.type} (${l.consumer.file}:${l.consumer.line}) [${l.matchReason}]`,
            )
            .join("\n")}${crossLinks.length > 50 ? `\n… and ${crossLinks.length - 50} more` : ""}`;
    const warnLines =
      missing.length > 0
        ? `\n\nWarning: ${missing.length} repo reference(s) missing from registry: ${missing.join(", ")}. Run \`codehub analyze\` for each.`
        : "";
    const registryHint = persisted
      ? ""
      : `\n\nHint: call \`group_sync\` with groupName="${group.name}" to materialize HTTP / gRPC / topic cross-links under ~/.codehub/groups/${group.name}/contracts.json`;
    const next =
      contracts.length === 0 && crossLinks.length === 0
        ? [
            `call \`group_sync\` with groupName="${group.name}" to materialize cross-repo contracts`,
            `call \`group_status\` with groupName="${group.name}" to confirm all repos are fresh`,
          ]
        : contracts.length > 0
          ? [
              `call \`context\` with symbol="${contracts[0]?.consumerSymbol ?? ""}" and repo="${contracts[0]?.consumerRepo ?? ""}" to inspect the first contract`,
              `call \`group_sync\` with groupName="${group.name}" to refresh the cross-link registry`,
            ]
          : [
              `call \`group_sync\` with groupName="${group.name}" to refresh the cross-link registry`,
              `call \`group_query\` with groupName="${group.name}" to locate related code paths`,
            ];

    return toToolResult(
      withNextSteps(
        `${header}\n${body}${crossLinkBody}${warnLines}${registryHint}`,
        {
          groupName: group.name,
          contracts,
          crossLinks,
          registryComputedAt: persisted?.computedAt ?? null,
          registryPath: persisted ? resolveGroupContractsPath(group.name, ctx.home) : null,
        },
        next,
      ),
    );
  } catch (err) {
    return toToolResult(toolErrorFromUnknown(err));
  }
}

/**
 * Load `<home>/.codehub/groups/<name>/contracts.json`. Returns `null`
 * when the file does not exist or fails to parse — the tool still
 * succeeds on the DuckDB-backed surface when the persisted file is
 * missing.
 */
async function loadPersistedRegistry(
  groupName: string,
  home: string | undefined,
): Promise<ContractRegistry | null> {
  const path = resolveGroupContractsPath(groupName, home);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as ContractRegistry;
    return parsed;
  } catch {
    return null;
  }
}

export function registerGroupContractsTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "group_contracts",
    {
      title: "Cross-repo HTTP contracts + cross-links",
      description:
        "Two-part surface for cross-repo contract discovery. (1) Match unresolved FETCHES edges (consumer) against Route nodes (producer) across every repo in the group — this is the DuckDB-backed HTTP surface. (2) When `group_sync` has written a contracts.json under `<home>/.codehub/groups/<name>/`, surface its cross-links with signature + file + line for HTTP, gRPC, and topic pairings. Use this to audit cross-repo coupling after a schema change in a shared API or proto.",
      inputSchema: GroupContractsInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => fromToolResult(await runGroupContracts(ctx, args)),
  );
}
