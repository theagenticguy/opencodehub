/**
 * `group_cross_repo_links` — sourced cross-repo link graph for Phase E.
 *
 * The `codehub-document` skill calls this during its Phase E assembler
 * (group mode) and embeds the returned `links[]` verbatim into the
 * `.docmeta.json` v2 `cross_repo_links[]` field. The skill does the
 * Markdown rendering; this tool only emits data.
 *
 * Data path: loads the persisted ContractRegistry written by `group_sync`
 * (at `<home>/.codehub/groups/<name>/contracts.json`), maps each
 * repo name to its stable `repo_uri` via `deriveRepoUri`, and hands off
 * to the pure analysis helper `computeCrossRepoLinks`. The helper does
 * the sort + dedup + relation inference; the tool only wires I/O.
 *
 * Annotations: readOnlyHint, idempotentHint, openWorldHint:false — the
 * tool reads two files (group descriptor + persisted registry) and
 * computes from them. Never writes.
 */

import { readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContractRegistry, CrossRepoLink } from "@opencodehub/analysis";
import { computeCrossRepoLinks } from "@opencodehub/analysis";
import { z } from "zod";
import { toolError, toolErrorFromUnknown } from "../error-envelope.js";
import { readGroup } from "../group-resolver.js";
import { withNextSteps } from "../next-step-hints.js";
import { deriveRepoUri, readRegistry } from "../repo-resolver.js";
import { resolveGroupContractsPath } from "./group-sync.js";
import { fromToolResult, type ToolContext, type ToolResult, toToolResult } from "./shared.js";

const GroupCrossRepoLinksInput = {
  groupName: z.string().min(1).describe("Name of the group to compute links for."),
  docPathScheme: z
    .enum(["default", "per-repo-landing-only"])
    .optional()
    .describe(
      "Doc-path scheme. Defaults to `per-repo-landing-only` (one link per repo-pair pointing at the target repo's architecture landing page).",
    ),
};

interface GroupCrossRepoLinksArgs {
  readonly groupName: string;
  readonly docPathScheme?: "default" | "per-repo-landing-only" | undefined;
}

/**
 * Load `<home>/.codehub/groups/<name>/contracts.json`. Returns `null`
 * when the file does not exist or fails to parse. Callers surface a
 * friendly hint to run `group_sync` in that case.
 */
async function loadPersistedRegistry(
  groupName: string,
  home: string | undefined,
): Promise<ContractRegistry | null> {
  const path = resolveGroupContractsPath(groupName, home);
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as ContractRegistry;
  } catch {
    return null;
  }
}

export async function runGroupCrossRepoLinks(
  ctx: ToolContext,
  args: GroupCrossRepoLinksArgs,
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

    const persisted = await loadPersistedRegistry(args.groupName, ctx.home);
    if (!persisted) {
      return toToolResult(
        withNextSteps(
          `No persisted contract registry for group ${args.groupName}. Run \`group_sync\` first — no cross-repo links can be computed until the registry materializes.`,
          {
            groupName: args.groupName,
            links: [] as readonly CrossRepoLink[],
            registryPath: null,
            registryComputedAt: null,
          },
          [
            `call \`group_sync\` with groupName="${args.groupName}" to materialize the cross-link registry`,
            `after \`group_sync\`, call \`group_cross_repo_links\` with groupName="${args.groupName}" again`,
          ],
        ),
      );
    }

    // Build repo → repo_uri map from the registry. Repos that are in the
    // group descriptor but not in the registry are silently skipped — the
    // helper treats "unknown repo" as "drop from graph" so the output stays
    // consistent even when a group member is not yet indexed.
    const registry = await readRegistry(opts);
    const repoUriByName = new Map<string, string>();
    for (const repo of group.repos) {
      const entry = registry[repo.name];
      if (!entry) continue;
      repoUriByName.set(repo.name, deriveRepoUri(entry));
    }

    const links = computeCrossRepoLinks({
      groupName: args.groupName,
      crossLinks: persisted.crossLinks,
      repoUriByName,
      ...(args.docPathScheme !== undefined ? { docPathScheme: args.docPathScheme } : {}),
    });

    const header = `group_cross_repo_links: ${links.length} sourced link(s) across ${group.repos.length} repo(s) in ${group.name}.`;
    const body =
      links.length === 0
        ? "(no cross-repo links — either no contracts matched or repos are unregistered)"
        : links
            .slice(0, 50)
            .map(
              (l) =>
                `- [${l.source_repo_uri}] ${l.source_doc_path} → [${l.target_repo_uri}] ${l.target_doc_path} (${l.relation})`,
            )
            .join("\n");
    const tail = links.length > 50 ? `\n… and ${links.length - 50} more` : "";

    const next =
      links.length === 0
        ? [
            `call \`group_contracts\` with groupName="${group.name}" to inspect producer↔consumer pairs`,
            `call \`group_sync\` with groupName="${group.name}" to refresh the cross-link registry`,
          ]
        : [
            `embed the \`links\` array verbatim into .docmeta.json \`cross_repo_links[]\` (schema v2)`,
            `call \`group_contracts\` with groupName="${group.name}" to see the underlying contract rows`,
          ];

    return toToolResult(
      withNextSteps(
        `${header}\n${body}${tail}`,
        {
          groupName: group.name,
          links,
          registryPath: resolveGroupContractsPath(group.name, ctx.home),
          registryComputedAt: persisted.computedAt,
        },
        next,
      ),
    );
  } catch (err) {
    return toToolResult(toolErrorFromUnknown(err));
  }
}

export function registerGroupCrossRepoLinksTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "group_cross_repo_links",
    {
      title: "Sourced cross-repo link graph for `.docmeta.json` v2",
      description:
        "Emit the sourced, alpha-sorted cross-repo link graph for a named group. Loads the persisted ContractRegistry from `group_sync` and emits a `CrossRepoLink[]` with `depends_on` (consumer → producer) and `consumer_of` (producer → consumer) relations per matched contract. The `codehub-document` skill embeds this array verbatim into `.docmeta.json` v2's `cross_repo_links[]` field during Phase E; the skill also renders the `## See also (other repos in group)` footer from it. If `group_sync` has not run, `links` is empty and the hint directs the caller to run it first.",
      inputSchema: GroupCrossRepoLinksInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => fromToolResult(await runGroupCrossRepoLinks(ctx, args)),
  );
}
