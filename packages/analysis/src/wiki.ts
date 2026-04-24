/**
 * `generateWiki` — emit a graph-only Markdown wiki under `outputDir`.
 *
 * Renders the 5 page families (architecture, api-surface, dependency-map,
 * ownership-map, risk-atlas) plus a top-level index. Output is deterministic
 * when `llm` is absent: two runs against the same graph produce byte-
 * identical files. With `llm.enabled`, a supplementary
 * `architecture/llm-overview.md` page is added containing per-module
 * narrative prose; the deterministic family pages remain byte-stable so
 * downstream diff tooling still works.
 *
 * No LLM calls, no network, no timestamps in rendered content in the default
 * (deterministic) mode. Filenames are sorted before writing so any external
 * tool iterating the output directory observes the same ordering.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { IGraphStore } from "@opencodehub/storage";
import wfa from "write-file-atomic";
import { renderApiSurfacePages } from "./wiki-render/api-surface.js";
import type { RenderedWikiPage } from "./wiki-render/architecture.js";
import { renderArchitecturePages } from "./wiki-render/architecture.js";
import { renderDependencyMapPages } from "./wiki-render/dependency-map.js";
import type { LlmModuleInput, LlmOverviewOptions } from "./wiki-render/llm-overview.js";
import { renderLlmOverviews } from "./wiki-render/llm-overview.js";
import { renderOwnershipMapPages } from "./wiki-render/ownership-map.js";
import { renderRiskAtlasPages } from "./wiki-render/risk-atlas.js";
import { loadCommunities, loadCommunityTopFiles, str } from "./wiki-render/shared.js";

export interface WikiLlmOptions {
  /**
   * Must be `true` to trigger any LLM activity. `false` (the default) keeps
   * generateWiki byte-identical to its pre-LLM output.
   */
  readonly enabled: boolean;
  /**
   * Cap on actual Bedrock calls. `0` enumerates candidate modules as a
   * dry-run without contacting Bedrock. Positive integers bound the number
   * of top-ranked modules that receive a real narrative.
   */
  readonly maxCalls: number;
  /** Optional override for the Bedrock model id passed to the summarizer. */
  readonly modelId?: string;
  /**
   * Test seam — skips the Bedrock SDK entirely. Matches the signature of
   * `@opencodehub/summarizer`'s `summarizeSymbol` (bound to a client).
   */
  readonly summarize?: LlmOverviewOptions["summarize"];
}

export interface WikiOptions {
  /** Absolute (or relative-to-cwd) path where pages are written. */
  readonly outputDir: string;
  /**
   * Optional repo root. When supplied, the risk-atlas page loads trend
   * snapshots from `<repoPath>/.codehub/history/`.
   */
  readonly repoPath?: string;
  /**
   * Opt-in LLM mode. When `enabled` is true, `generateWiki` also writes
   * `architecture/llm-overview.md` with per-module narrative prose. The
   * deterministic family pages are unchanged.
   */
  readonly llm?: WikiLlmOptions;
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

  if (options.llm?.enabled === true) {
    const llmPage = await renderLlmOverviewPage(store, options.llm);
    if (llmPage !== undefined) {
      allPages.push(llmPage);
    }
  }

  allPages.push({
    filename: "index.md",
    content: renderRootIndex(options.llm?.enabled === true),
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

function renderRootIndex(llmEnabled: boolean): string {
  const lines = [
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
  ];
  if (llmEnabled) {
    lines.push("- [Module narratives (LLM)](./architecture/llm-overview.md)");
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Render the optional `architecture/llm-overview.md` page. Returns undefined
 * when the graph has no Community nodes — the deterministic pipeline already
 * emits an empty-architecture page in that case and we do not need a
 * narrative shell.
 */
async function renderLlmOverviewPage(
  store: IGraphStore,
  llm: WikiLlmOptions,
): Promise<RenderedWikiPage | undefined> {
  const communities = await loadCommunities(store);
  if (communities.length === 0) return undefined;

  const TOP_FILES_PER_MODULE = 5;
  const moduleInputs: LlmModuleInput[] = [];
  for (const community of communities) {
    const topFilesRows = await loadCommunityTopFiles(store, community.id, TOP_FILES_PER_MODULE);
    const topFiles = topFilesRows.map((r) => r.filePath);
    const topSymbols = await loadCommunityTopSymbols(store, community.id, TOP_FILES_PER_MODULE);
    moduleInputs.push({
      communityId: community.id,
      label: community.inferredLabel.length > 0 ? community.inferredLabel : community.name,
      symbolCount: community.symbolCount,
      topFiles,
      topSymbols,
    });
  }

  const llmOptions: LlmOverviewOptions = {
    enabled: llm.enabled,
    maxCalls: llm.maxCalls,
    ...(llm.modelId !== undefined ? { modelId: llm.modelId } : {}),
    ...(llm.summarize !== undefined ? { summarize: llm.summarize } : {}),
  };
  const overviews = await renderLlmOverviews(moduleInputs, llmOptions);

  // Preserve deterministic file order: render in the ranking order the
  // llm-overview module used (symbolCount desc, label asc, id asc) so re-runs
  // with the same graph + maxCalls produce byte-identical content.
  const ranked = [...moduleInputs].sort((a, b) => {
    if (b.symbolCount !== a.symbolCount) return b.symbolCount - a.symbolCount;
    if (a.label !== b.label) return a.label.localeCompare(b.label);
    return a.communityId.localeCompare(b.communityId);
  });

  const lines: string[] = [];
  lines.push("# Module narratives");
  lines.push("");
  lines.push(
    "LLM-generated prose per community. Deterministic family pages under " +
      "`./` are unchanged; this page is additive.",
  );
  lines.push("");
  lines.push(`- **Modules ranked:** ${ranked.length}`);
  lines.push(`- **LLM calls cap:** ${llm.maxCalls === 0 ? "0 (dry-run)" : String(llm.maxCalls)}`);
  if (llm.modelId !== undefined) {
    lines.push(`- **Model:** \`${llm.modelId}\``);
  }
  lines.push("");

  for (const mod of ranked) {
    const overview = overviews.get(mod.communityId);
    if (overview === undefined) continue;
    lines.push(overview.markdown.trimEnd());
    lines.push("");
  }

  return {
    filename: "architecture/llm-overview.md",
    content: lines.join("\n"),
  };
}

/**
 * Top symbol names (functions / methods / classes) for a community, ranked
 * by kind priority then name. Used by the LLM overview page to feed key
 * symbols into each summarizer prompt.
 */
async function loadCommunityTopSymbols(
  store: IGraphStore,
  communityId: string,
  limit: number,
): Promise<readonly string[]> {
  try {
    const rows = await store.query(
      `SELECT n.name AS name
         FROM relations r
         JOIN nodes n ON n.id = r.from_id
        WHERE r.type = 'MEMBER_OF'
          AND r.to_id = ?
          AND n.kind IN ('Class', 'Function', 'Method')
          AND n.name IS NOT NULL
          AND n.name <> ''
        ORDER BY
          CASE n.kind WHEN 'Class' THEN 0 WHEN 'Function' THEN 1 ELSE 2 END,
          n.name ASC
        LIMIT ?`,
      [communityId, limit],
    );
    return rows.map((r) => str(r, "name")).filter((s) => s.length > 0);
  } catch {
    return [];
  }
}
