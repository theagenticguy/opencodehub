/**
 * Ownership-map renderer — per-Community contributor rankings with line-share
 * and last-seen-days signal.
 *
 * Rankings are derived from OWNED_BY edges attached to the Community's File
 * members. `topContributorLastSeenDays` on the member File rows gives us a
 * last-seen signal; the page surfaces the max across the community's files so
 * we don't over-claim freshness based on a single recent touch.
 */

import type { IGraphStore } from "@opencodehub/storage";
import type { RenderedWikiPage } from "./architecture.js";
import {
  contributorDisplay,
  escapePipe,
  loadCommunities,
  loadCommunityTopContributors,
  maybeNum,
  shortHash,
  slugify,
} from "./shared.js";

const TOP_N = 10;

export async function renderOwnershipMapPages(
  store: IGraphStore,
): Promise<readonly RenderedWikiPage[]> {
  const communities = await loadCommunities(store);
  const seen = new Set<string>();
  const pages: RenderedWikiPage[] = [];

  if (communities.length === 0) {
    pages.push({
      filename: "ownership-map/index.md",
      content: renderEmptyIndex(),
    });
    return pages;
  }

  const indexRows: {
    readonly label: string;
    readonly filename: string;
    readonly contributorCount: number;
    readonly staleMaxDays: number | undefined;
  }[] = [];

  for (const community of communities) {
    const label =
      community.inferredLabel.length > 0
        ? community.inferredLabel
        : community.name.length > 0
          ? community.name
          : community.id;
    const baseSlug = slugify(label);
    const slug = seen.has(`ownership-map/${baseSlug}.md`)
      ? `${baseSlug}-${shortHash(community.id)}`
      : baseSlug;
    const filename = `ownership-map/${slug}.md`;
    seen.add(filename);

    const [contributors, lastSeen] = await Promise.all([
      loadCommunityTopContributors(store, community.id, TOP_N),
      loadCommunityLastSeen(store, community.id),
    ]);

    pages.push({
      filename,
      content: renderCommunityPage({
        label,
        communityId: community.id,
        contributors,
        lastSeenDays: lastSeen,
      }),
    });
    indexRows.push({
      label,
      filename,
      contributorCount: contributors.length,
      staleMaxDays: lastSeen,
    });
  }

  pages.push({
    filename: "ownership-map/index.md",
    content: renderIndex(indexRows),
  });

  return pages.sort((a, b) => a.filename.localeCompare(b.filename));
}

async function loadCommunityLastSeen(
  store: IGraphStore,
  communityId: string,
): Promise<number | undefined> {
  try {
    const rows = await store.query(
      `SELECT MAX(f.top_contributor_last_seen_days) AS max_days
         FROM relations m
         JOIN nodes f ON f.id = m.from_id AND f.kind = 'File'
        WHERE m.type = 'MEMBER_OF' AND m.to_id = ?`,
      [communityId],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    const n = maybeNum(row, "max_days");
    return n === undefined ? undefined : n;
  } catch {
    return undefined;
  }
}

function renderCommunityPage(args: {
  readonly label: string;
  readonly communityId: string;
  readonly contributors: readonly {
    readonly name: string;
    readonly emailHash: string;
    readonly emailPlain: string;
    readonly lineShare: number;
  }[];
  readonly lastSeenDays: number | undefined;
}): string {
  const lines: string[] = [];
  lines.push(`# ${args.label} — ownership`);
  lines.push("");
  lines.push(`- **Community id:** \`${args.communityId}\``);
  if (args.lastSeenDays !== undefined) {
    lines.push(`- **Max top-contributor last-seen:** ${args.lastSeenDays} days`);
  }
  lines.push("");

  if (args.contributors.length === 0) {
    lines.push("(no OWNED_BY edges — run `codehub analyze` on a git repository)");
    lines.push("");
    return lines.join("\n");
  }

  lines.push("| Rank | Contributor | Line share |");
  lines.push("| ---: | --- | ---: |");
  let rank = 1;
  for (const c of args.contributors) {
    lines.push(`| ${rank} | ${escapePipe(contributorDisplay(c))} | ${c.lineShare.toFixed(3)} |`);
    rank += 1;
  }
  lines.push("");
  return lines.join("\n");
}

function renderIndex(
  rows: readonly {
    readonly label: string;
    readonly filename: string;
    readonly contributorCount: number;
    readonly staleMaxDays: number | undefined;
  }[],
): string {
  const lines: string[] = [];
  lines.push("# Ownership map");
  lines.push("");
  lines.push("Per-community contributor rankings derived from `OWNED_BY` edges.");
  lines.push("");
  lines.push("| Community | Contributors | Max last-seen (days) |");
  lines.push("| --- | ---: | ---: |");
  const sorted = [...rows].sort((a, b) => a.label.localeCompare(b.label));
  for (const row of sorted) {
    const link = `./${row.filename.replace(/^ownership-map\//, "")}`;
    const stale = row.staleMaxDays === undefined ? "-" : row.staleMaxDays.toString();
    lines.push(`| [${escapePipe(row.label)}](${link}) | ${row.contributorCount} | ${stale} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderEmptyIndex(): string {
  return [
    "# Ownership map",
    "",
    "No Community nodes available. Ensure `codehub analyze` has run over a git",
    "repository with enough history for the ownership + communities phases.",
    "",
  ].join("\n");
}
