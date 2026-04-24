/**
 * `group_sync` — rebuild the cross-repo contract registry for a named
 * group. Walks each registered repo, runs the HTTP / gRPC / topic
 * extractors, and writes the result to
 * `<home>/.codehub/groups/<name>/contracts.json`. The tool returns a
 * compact summary so agents can reason about pairing density before
 * jumping into the richer `group_contracts` tool.
 *
 * Annotations: writes a single file under the home directory — not
 * `readOnlyHint`. `openWorldHint: false` because the scan stays within
 * the registry.
 */
// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures

import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContractRegistry, SyncRepoInput } from "@opencodehub/analysis";
import { runGroupSync } from "@opencodehub/analysis";
import { z } from "zod";
import { toolError, toolErrorFromUnknown } from "../error-envelope.js";
import { readGroup } from "../group-resolver.js";
import { withNextSteps } from "../next-step-hints.js";
import { readRegistry } from "../repo-resolver.js";
import { fromToolResult, type ToolContext, type ToolResult, toToolResult } from "./shared.js";

const GroupSyncInput = {
  groupName: z.string().min(1).describe("Name of the group to sync."),
};

interface GroupSyncArgs {
  readonly groupName: string;
}

const CODEHUB_HOME_DIR = ".codehub";

/** Absolute path of `<home>/.codehub/groups/<name>/contracts.json`. */
export function resolveGroupContractsPath(groupName: string, home?: string): string {
  const root = home ?? homedir();
  return resolve(root, CODEHUB_HOME_DIR, "groups", groupName, "contracts.json");
}

export async function runGroupSyncTool(ctx: ToolContext, args: GroupSyncArgs): Promise<ToolResult> {
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
    const inputs: SyncRepoInput[] = [];
    const missing: string[] = [];
    for (const repo of sortedRepos) {
      const hit = registry[repo.name];
      if (!hit) {
        missing.push(repo.name);
        continue;
      }
      inputs.push({ name: repo.name, path: resolve(hit.path) });
    }

    const registryResult: ContractRegistry = await runGroupSync({ repos: inputs });
    const outPath = resolveGroupContractsPath(group.name, ctx.home);
    await mkdir(dirname(outPath), { recursive: true });
    const payload = `${JSON.stringify(registryResult, null, 2)}\n`;
    // Atomic write: stage at `.tmp` sibling, rename into place. Keeps
    // concurrent readers from seeing a torn write mid-flight.
    const tmp = `${outPath}.tmp`;
    await writeFile(tmp, payload, "utf8");
    await rename(tmp, outPath);

    const header = `group_sync: wrote ${registryResult.contracts.length} contract(s) and ${registryResult.crossLinks.length} cross-link(s) for ${group.name}.`;
    const body = [`Registry → ${outPath}`];
    if (missing.length > 0) {
      body.push(`Skipped ${missing.length} unregistered repo(s): ${missing.join(", ")}`);
    }
    const next =
      registryResult.crossLinks.length === 0
        ? [
            `call \`group_contracts\` with groupName="${group.name}" to inspect extracted contracts`,
            `confirm repos are freshly analyzed with \`group_status\` for ${group.name}`,
          ]
        : [
            `call \`group_contracts\` with groupName="${group.name}" to browse producer↔consumer pairs`,
          ];

    return toToolResult(
      withNextSteps(
        [header, ...body].join("\n"),
        {
          groupName: group.name,
          registryPath: outPath,
          contractCount: registryResult.contracts.length,
          crossLinkCount: registryResult.crossLinks.length,
          missingRepos: missing,
          repos: registryResult.repos,
        },
        next,
      ),
    );
  } catch (err) {
    return toToolResult(toolErrorFromUnknown(err));
  }
}

export function registerGroupSyncTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "group_sync",
    {
      title: "Rebuild cross-repo contract registry",
      description:
        "Walk every repo in a named group, run HTTP / gRPC / topic contract extractors, and write `<home>/.codehub/groups/<name>/contracts.json`. Returns a summary of extracted contracts + cross-links. Use this before calling `group_contracts` when you want the registry to reflect the current working tree.",
      inputSchema: GroupSyncInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => fromToolResult(await runGroupSyncTool(ctx, args)),
  );
}
