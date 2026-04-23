/**
 * `generateWiki` — emit a graph-only Markdown wiki under `outputDir`.
 *
 * Renders the 5 page families (architecture, api-surface, dependency-map,
 * ownership-map, risk-atlas) plus a top-level index. Output is deterministic:
 * two runs against the same graph produce byte-identical files.
 *
 * No LLM calls, no network, no timestamps in rendered content. Filenames are
 * sorted before writing so any external tool iterating the output directory
 * observes the same ordering.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { IGraphStore } from "@opencodehub/storage";
import wfa from "write-file-atomic";
import { renderApiSurfacePages } from "./wiki-render/api-surface.js";
import type { RenderedWikiPage } from "./wiki-render/architecture.js";
import { renderArchitecturePages } from "./wiki-render/architecture.js";
import { renderDependencyMapPages } from "./wiki-render/dependency-map.js";
import { renderOwnershipMapPages } from "./wiki-render/ownership-map.js";
import { renderRiskAtlasPages } from "./wiki-render/risk-atlas.js";

export interface WikiOptions {
  /** Absolute (or relative-to-cwd) path where pages are written. */
  readonly outputDir: string;
  /**
   * Optional repo root. When supplied, the risk-atlas page loads trend
   * snapshots from `<repoPath>/.codehub/history/`.
   */
  readonly repoPath?: string;
}

export interface WikiResult {
  readonly filesWritten: readonly string[];
  readonly totalBytes: number;
}

export async function generateWiki(store: IGraphStore, options: WikiOptions): Promise<WikiResult> {
  const outputDir = path.resolve(options.outputDir);
  const riskOpts = options.repoPath !== undefined ? { repoPath: options.repoPath } : {};
  const [architecture, apiSurface, dependencyMap, ownership, riskAtlas] = await Promise.all([
    renderArchitecturePages(store),
    renderApiSurfacePages(store),
    renderDependencyMapPages(store),
    renderOwnershipMapPages(store),
    renderRiskAtlasPages(store, riskOpts),
  ]);

  const allPages: RenderedWikiPage[] = [
    ...architecture,
    ...apiSurface,
    ...dependencyMap,
    ...ownership,
    ...riskAtlas,
  ];
  allPages.push({
    filename: "index.md",
    content: renderRootIndex(),
  });

  // Deterministic write order.
  allPages.sort((a, b) => a.filename.localeCompare(b.filename));

  const filesWritten: string[] = [];
  let totalBytes = 0;
  const createdDirs = new Set<string>();
  for (const page of allPages) {
    const absPath = path.join(outputDir, page.filename);
    const parent = path.dirname(absPath);
    if (!createdDirs.has(parent)) {
      await mkdir(parent, { recursive: true });
      createdDirs.add(parent);
    }
    const payload = page.content.endsWith("\n") ? page.content : `${page.content}\n`;
    await wfa(absPath, payload, { encoding: "utf8", fsync: true });
    filesWritten.push(absPath);
    totalBytes += Buffer.byteLength(payload, "utf8");
  }

  return { filesWritten, totalBytes };
}

function renderRootIndex(): string {
  return [
    "# OpenCodeHub wiki",
    "",
    "Graph-derived Markdown pages. Regenerate with `codehub wiki --output <dir>`.",
    "",
    "## Sections",
    "",
    "- [Architecture](./architecture/index.md)",
    "- [API surface](./api-surface/index.md)",
    "- [Dependency map](./dependency-map/index.md)",
    "- [Ownership map](./ownership-map/index.md)",
    "- [Risk atlas](./risk-atlas/index.md)",
    "",
  ].join("\n");
}
