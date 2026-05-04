/**
 * Dependency-map renderer — alphabetical table of external dependencies with
 * license, ecosystem, and usage count (distinct files that DEPENDS_ON the
 * dependency).
 */

import type { IGraphStore } from "@opencodehub/storage";
import type { RenderedWikiPage } from "./architecture.js";
import { escapePipe, loadDependencies } from "./shared.js";

export async function renderDependencyMapPages(
  store: IGraphStore,
): Promise<readonly RenderedWikiPage[]> {
  const deps = await loadDependencies(store);
  return [
    {
      filename: "dependency-map/index.md",
      content: renderPage(deps),
    },
  ];
}

function renderPage(
  deps: readonly {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly ecosystem: string;
    readonly license: string;
    readonly lockfileSource: string;
    readonly usageCount: number;
  }[],
): string {
  const lines: string[] = [];
  lines.push("# Dependency map");
  lines.push("");
  lines.push(`Total dependencies: **${deps.length}**.`);
  lines.push("");
  if (deps.length === 0) {
    lines.push(
      "(no Dependency nodes found — enable the `dependencies` phase in `codehub analyze` to populate this page)",
    );
    lines.push("");
    return lines.join("\n");
  }

  lines.push("| Name | Version | Ecosystem | License | Lockfile | Usages |");
  lines.push("| --- | --- | --- | --- | --- | ---: |");
  const sorted = [...deps].sort((a, b) => {
    if (a.name !== b.name) return a.name.localeCompare(b.name);
    if (a.version !== b.version) return a.version.localeCompare(b.version);
    return a.id.localeCompare(b.id);
  });
  for (const d of sorted) {
    const license = d.license.length > 0 ? d.license : "-";
    const lockfile = d.lockfileSource.length > 0 ? `\`${escapePipe(d.lockfileSource)}\`` : "-";
    const ecosystem = d.ecosystem.length > 0 ? d.ecosystem : "-";
    const name = d.name.length > 0 ? d.name : d.id;
    const version = d.version.length > 0 ? d.version : "-";
    lines.push(
      `| \`${escapePipe(name)}\` | ${escapePipe(version)} | ${escapePipe(ecosystem)} | ${escapePipe(license)} | ${lockfile} | ${d.usageCount} |`,
    );
  }
  lines.push("");

  // Ecosystem + license rollups for quick scanning.
  const ecosystemCounts = new Map<string, number>();
  const licenseCounts = new Map<string, number>();
  for (const d of deps) {
    const eco = d.ecosystem.length > 0 ? d.ecosystem : "(unknown)";
    ecosystemCounts.set(eco, (ecosystemCounts.get(eco) ?? 0) + 1);
    const lic = d.license.length > 0 ? d.license : "(unknown)";
    licenseCounts.set(lic, (licenseCounts.get(lic) ?? 0) + 1);
  }

  lines.push("## By ecosystem");
  lines.push("");
  lines.push("| Ecosystem | Count |");
  lines.push("| --- | ---: |");
  for (const [eco, count] of [...ecosystemCounts.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    lines.push(`| ${escapePipe(eco)} | ${count} |`);
  }
  lines.push("");

  lines.push("## By license");
  lines.push("");
  lines.push("| License | Count |");
  lines.push("| --- | ---: |");
  for (const [lic, count] of [...licenseCounts.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    lines.push(`| ${escapePipe(lic)} | ${count} |`);
  }
  lines.push("");

  return lines.join("\n");
}
