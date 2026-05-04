/**
 * Architecture renderer — one Markdown page per Community node.
 *
 * Each page surfaces the community label, member count, top 10 files, top 3
 * contributors (from OWNED_BY), and cohesion. Output is entirely derived from
 * the graph — no LLM calls, no clock, no network.
 */

import type { IGraphStore } from "@opencodehub/storage";
import {
  contributorDisplay,
  escapePipe,
  loadCommunities,
  loadCommunityTopContributors,
  loadCommunityTopFiles,
  shortHash,
  slugify,
} from "./shared.js";

export interface RenderedWikiPage {
  readonly filename: string;
  readonly content: string;
}

const TOP_FILES = 10;
const TOP_CONTRIBUTORS = 3;

export async function renderArchitecturePages(
  store: IGraphStore,
): Promise<readonly RenderedWikiPage[]> {
  const communities = await loadCommunities(store);
  const seenFilenames = new Set<string>();
  const pages: RenderedWikiPage[] = [];

  if (communities.length === 0) {
    pages.push({
      filename: "architecture/index.md",
      content: renderEmptyIndex(),
    });
    return pages;
  }

  const indexRows: {
    readonly label: string;
    readonly filename: string;
    readonly symbolCount: number;
    readonly cohesion: number;
  }[] = [];

  for (const community of communities) {
    const label = pageTitleFor(community.inferredLabel, community.name, community.id);
    const baseSlug = slugify(label);
    const slug = seenFilenames.has(`architecture/${baseSlug}.md`)
      ? `${baseSlug}-${shortHash(community.id)}`
      : baseSlug;
    const filename = `architecture/${slug}.md`;
    seenFilenames.add(filename);

    const [topFiles, topContributors] = await Promise.all([
      loadCommunityTopFiles(store, community.id, TOP_FILES),
      loadCommunityTopContributors(store, community.id, TOP_CONTRIBUTORS),
    ]);

    pages.push({
      filename,
      content: renderCommunityPage({
        label,
        community,
        topFiles,
        topContributors,
      }),
    });
    indexRows.push({
      label,
      filename,
      symbolCount: community.symbolCount,
      cohesion: community.cohesion,
    });
  }

  pages.push({
    filename: "architecture/index.md",
    content: renderIndex(indexRows),
  });

  return pages.sort((a, b) => a.filename.localeCompare(b.filename));
}

function pageTitleFor(inferredLabel: string, name: string, id: string): string {
  if (inferredLabel.length > 0) return inferredLabel;
  if (name.length > 0) return name;
  return id;
}

function cohesionPercent(cohesion: number): string {
  const clamped = Math.max(0, Math.min(1, cohesion));
  return `${(clamped * 100).toFixed(1)}%`;
}

function renderCommunityPage(args: {
  readonly label: string;
  readonly community: {
    readonly id: string;
    readonly symbolCount: number;
    readonly cohesion: number;
    readonly truckFactor: number | undefined;
  };
  readonly topFiles: readonly {
    readonly filePath: string;
    readonly memberCount: number;
  }[];
  readonly topContributors: readonly {
    readonly name: string;
    readonly emailPlain: string;
    readonly emailHash: string;
    readonly lineShare: number;
  }[];
}): string {
  const lines: string[] = [];
  lines.push(`# ${args.label}`);
  lines.push("");
  lines.push(`- **Community id:** \`${args.community.id}\``);
  lines.push(`- **Members:** ${args.community.symbolCount}`);
  lines.push(`- **Cohesion:** ${cohesionPercent(args.community.cohesion)}`);
  if (args.community.truckFactor !== undefined) {
    lines.push(`- **Truck factor:** ${args.community.truckFactor}`);
  }
  lines.push("");

  lines.push(`## Top ${TOP_FILES} files`);
  lines.push("");
  if (args.topFiles.length === 0) {
    lines.push("(no member files found)");
  } else {
    lines.push("| File | Member symbols |");
    lines.push("| --- | ---: |");
    for (const row of args.topFiles) {
      lines.push(`| \`${escapePipe(row.filePath)}\` | ${row.memberCount} |`);
    }
  }
  lines.push("");

  lines.push(`## Top ${TOP_CONTRIBUTORS} contributors`);
  lines.push("");
  if (args.topContributors.length === 0) {
    lines.push("(no ownership data — run the ownership phase via `codehub analyze`)");
  } else {
    lines.push("| Contributor | Line share |");
    lines.push("| --- | ---: |");
    for (const row of args.topContributors) {
      lines.push(`| ${escapePipe(contributorDisplay(row))} | ${row.lineShare.toFixed(3)} |`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function renderIndex(
  rows: readonly {
    readonly label: string;
    readonly filename: string;
    readonly symbolCount: number;
    readonly cohesion: number;
  }[],
): string {
  const lines: string[] = [];
  lines.push("# Architecture");
  lines.push("");
  lines.push("Communities detected by the ingestion pipeline, sorted by member count.");
  lines.push("");
  lines.push("| Community | Members | Cohesion |");
  lines.push("| --- | ---: | ---: |");
  const sorted = [...rows].sort((a, b) => {
    if (b.symbolCount !== a.symbolCount) return b.symbolCount - a.symbolCount;
    return a.label.localeCompare(b.label);
  });
  for (const row of sorted) {
    const link = `./${row.filename.replace(/^architecture\//, "")}`;
    lines.push(
      `| [${escapePipe(row.label)}](${link}) | ${row.symbolCount} | ${cohesionPercent(row.cohesion)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function renderEmptyIndex(): string {
  return [
    "# Architecture",
    "",
    "No Community nodes in this graph.",
    "Run `codehub analyze` to populate communities before regenerating the wiki.",
    "",
  ].join("\n");
}
