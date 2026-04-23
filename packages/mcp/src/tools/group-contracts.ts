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

import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDbStore } from "@opencodehub/storage";
import { resolveDbPath } from "@opencodehub/storage";
import { z } from "zod";
import { toolError, toolErrorFromUnknown } from "../error-envelope.js";
import { readGroup } from "../group-resolver.js";
import { withNextSteps } from "../next-step-hints.js";
import { readRegistry } from "../repo-resolver.js";
import type { ToolContext } from "./shared.js";

const UNRESOLVED_PREFIX = "fetches:unresolved:";

const GroupContractsInput = {
  groupName: z.string().min(1).describe("Name of the group to inspect."),
};

interface ContractRow {
  readonly consumerRepo: string;
  readonly consumerSymbol: string;
  readonly producerRepo: string;
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

async function readConsumerEdges(store: DuckDbStore): Promise<readonly ConsumerEdgeRow[]> {
  const rows = (await store.query(
    "SELECT from_id, to_id FROM relations WHERE type = 'FETCHES' ORDER BY from_id, to_id",
  )) as ReadonlyArray<Record<string, unknown>>;
  const out: ConsumerEdgeRow[] = [];
  for (const r of rows) {
    const to = String(r["to_id"] ?? "");
    const parsed = parseUnresolvedTarget(to);
    if (parsed === undefined) continue;
    const from = String(r["from_id"] ?? "");
    out.push({
      consumerSymbol: from,
      method: parsed.method,
      path: normalizePath(parsed.path),
    });
  }
  return out;
}

async function readProducerRoutes(store: DuckDbStore): Promise<readonly RouteRow[]> {
  const rows = (await store.query(
    "SELECT id, method, url FROM nodes WHERE kind = 'Route' ORDER BY id",
  )) as ReadonlyArray<Record<string, unknown>>;
  const out: RouteRow[] = [];
  for (const r of rows) {
    const url = r["url"];
    if (typeof url !== "string" || url.length === 0) continue;
    const method = String(r["method"] ?? "GET").toUpperCase();
    out.push({ nodeId: String(r["id"]), method, url });
  }
  return out;
}

export function registerGroupContractsTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "group_contracts",
    {
      title: "Cross-repo HTTP contracts",
      description:
        "For every repo in a named group, match unresolved outbound FETCHES edges (consumer side) against Route nodes in the other repos (producer side). Returns one contract row per resolved consumer→producer pair. Use this to audit cross-repo HTTP coupling after a schema change in a shared API.",
      inputSchema: GroupContractsInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const opts = ctx.home !== undefined ? { home: ctx.home } : {};
        const group = await readGroup(args.groupName, opts);
        if (!group) {
          return toolError(
            "NOT_FOUND",
            `Group ${args.groupName} is not defined.`,
            "Run `codehub group list` to see defined groups.",
          );
        }
        const registry = await readRegistry(opts);
        const sortedRepos = [...group.repos].sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        );

        const missing: string[] = [];
        const consumersByRepo = new Map<string, readonly ConsumerEdgeRow[]>();
        const producersByRepo = new Map<string, readonly RouteRow[]>();

        for (const repo of sortedRepos) {
          const hit = registry[repo.name];
          if (!hit) {
            missing.push(repo.name);
            continue;
          }
          const repoPath = resolve(hit.path);
          const dbPath = resolveDbPath(repoPath);
          const store = await ctx.pool.acquire(repoPath, dbPath).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`Failed to open DuckDB for ${repo.name}: ${msg}`);
          });
          try {
            const [consumers, producers] = await Promise.all([
              readConsumerEdges(store),
              readProducerRoutes(store),
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
                contracts.push({
                  consumerRepo,
                  consumerSymbol: consumer.consumerSymbol,
                  producerRepo,
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

        const header = `Cross-repo HTTP contracts for group ${group.name}: ${contracts.length} edge(s).`;
        const body =
          contracts.length === 0
            ? "(no contracts — verify consumer repos ran the `fetches` phase and producer repos registered Route nodes)"
            : contracts
                .map(
                  (c) =>
                    `- [${c.consumerRepo}] ${c.consumerSymbol} → [${c.producerRepo}] ${c.method} ${c.path}`,
                )
                .join("\n");
        const warnLines =
          missing.length > 0
            ? `\n\nWarning: ${missing.length} repo reference(s) missing from registry: ${missing.join(", ")}. Run \`codehub analyze\` for each.`
            : "";
        const next =
          contracts.length === 0
            ? [
                `call \`group_status\` with groupName="${group.name}" to confirm all repos are fresh`,
                "re-index consumer or producer repos with `codehub analyze` to refresh FETCHES / Route graphs",
              ]
            : [
                `call \`context\` with symbol="${contracts[0]?.consumerSymbol ?? ""}" and repo="${contracts[0]?.consumerRepo ?? ""}" to inspect the first contract`,
                `call \`group_query\` with groupName="${group.name}" to locate related code paths`,
              ];

        return withNextSteps(
          `${header}\n${body}${warnLines}`,
          { groupName: group.name, contracts },
          next,
        );
      } catch (err) {
        return toolErrorFromUnknown(err);
      }
    },
  );
}
