/**
 * API surface renderer — a per-framework page describing Routes + OpenAPI
 * Operations plus cross-stack `FETCHES` traces.
 *
 * Output is sourced entirely from the graph: ProjectProfile for framework
 * discovery, `Route` / `Operation` nodes for the tables, and the `FETCHES`
 * relation for call traces.
 */

import type { IGraphStore } from "@opencodehub/storage";
import type { RenderedWikiPage } from "./architecture.js";
import {
  escapePipe,
  type FetchesRow,
  loadFetches,
  loadOperations,
  loadProjectProfile,
  loadRoutes,
  type OperationRow,
  type RouteRow,
} from "./shared.js";

export async function renderApiSurfacePages(
  store: IGraphStore,
): Promise<readonly RenderedWikiPage[]> {
  const [profile, routes, operations, fetches] = await Promise.all([
    loadProjectProfile(store),
    loadRoutes(store),
    loadOperations(store),
    loadFetches(store),
  ]);

  const frameworks = profile ? [...profile.frameworks] : [];
  const apiContracts = profile ? [...profile.apiContracts] : [];
  frameworks.sort((a, b) => a.localeCompare(b));
  apiContracts.sort((a, b) => a.localeCompare(b));

  const pages: RenderedWikiPage[] = [];

  if (routes.length === 0 && operations.length === 0 && fetches.length === 0) {
    pages.push({
      filename: "api-surface/index.md",
      content: renderEmptyIndex(),
    });
    return pages;
  }

  // A single "all" page is always emitted so there's a stable entry point.
  pages.push({
    filename: "api-surface/index.md",
    content: renderIndex({ frameworks, apiContracts, routes, operations, fetches }),
  });

  // Per-framework pages use the framework name as the slug; if no frameworks
  // are detected we emit a single "generic" page that covers all routes.
  const frameworkSlugs = frameworks.length > 0 ? frameworks : ["generic"];
  for (const fw of frameworkSlugs) {
    const slug = fw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    pages.push({
      filename: `api-surface/${slug}.md`,
      content: renderFrameworkPage({
        framework: fw,
        routes,
        operations,
        fetches,
      }),
    });
  }

  return pages.sort((a, b) => a.filename.localeCompare(b.filename));
}

function renderIndex(args: {
  readonly frameworks: readonly string[];
  readonly apiContracts: readonly string[];
  readonly routes: readonly RouteRow[];
  readonly operations: readonly OperationRow[];
  readonly fetches: readonly FetchesRow[];
}): string {
  const lines: string[] = [];
  lines.push("# API surface");
  lines.push("");
  lines.push(`- **Routes:** ${args.routes.length}`);
  lines.push(`- **Operations:** ${args.operations.length}`);
  lines.push(`- **Fetches:** ${args.fetches.length}`);
  if (args.frameworks.length > 0) {
    lines.push(`- **Frameworks:** ${args.frameworks.map((f) => `\`${f}\``).join(", ")}`);
  }
  if (args.apiContracts.length > 0) {
    lines.push(`- **API contracts:** ${args.apiContracts.map((c) => `\`${c}\``).join(", ")}`);
  }
  lines.push("");
  lines.push("## Pages");
  lines.push("");
  const targets = args.frameworks.length > 0 ? args.frameworks : ["generic"];
  for (const fw of targets) {
    const slug = fw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    lines.push(`- [${escapePipe(fw)}](./${slug}.md)`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderFrameworkPage(args: {
  readonly framework: string;
  readonly routes: readonly RouteRow[];
  readonly operations: readonly OperationRow[];
  readonly fetches: readonly FetchesRow[];
}): string {
  const lines: string[] = [];
  lines.push(`# ${args.framework}`);
  lines.push("");

  lines.push("## Routes");
  lines.push("");
  if (args.routes.length === 0) {
    lines.push("(no Route nodes found)");
  } else {
    lines.push("| Method | URL | Handler file |");
    lines.push("| --- | --- | --- |");
    for (const r of args.routes) {
      const method = r.method.length > 0 ? r.method : "-";
      const handler = r.handlerFilePath.length > 0 ? `\`${escapePipe(r.handlerFilePath)}\`` : "-";
      lines.push(`| ${escapePipe(method)} | \`${escapePipe(r.url)}\` | ${handler} |`);
    }
  }
  lines.push("");

  lines.push("## Operations");
  lines.push("");
  if (args.operations.length === 0) {
    lines.push("(no Operation nodes found — requires an OpenAPI contract)");
  } else {
    lines.push("| Method | Path | Summary | File |");
    lines.push("| --- | --- | --- | --- |");
    for (const op of args.operations) {
      const method = op.method.length > 0 ? op.method : "-";
      const summary = op.summary.length > 0 ? op.summary : "-";
      const file = op.filePath.length > 0 ? `\`${escapePipe(op.filePath)}\`` : "-";
      lines.push(
        `| ${escapePipe(method)} | \`${escapePipe(op.path)}\` | ${escapePipe(summary)} | ${file} |`,
      );
    }
  }
  lines.push("");

  lines.push("## Cross-stack fetches");
  lines.push("");
  if (args.fetches.length === 0) {
    lines.push("(no FETCHES edges found)");
  } else {
    lines.push("| Caller file | Caller name | Target URL |");
    lines.push("| --- | --- | --- |");
    for (const f of args.fetches) {
      const file = f.fromFilePath.length > 0 ? `\`${escapePipe(f.fromFilePath)}\`` : "-";
      const name = f.fromName.length > 0 ? f.fromName : "-";
      const url = f.toUrl.length > 0 ? `\`${escapePipe(f.toUrl)}\`` : "-";
      lines.push(`| ${file} | ${escapePipe(name)} | ${url} |`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function renderEmptyIndex(): string {
  return [
    "# API surface",
    "",
    "No Route, Operation, or FETCHES data in this graph.",
    "The `routes`, `openapi`, and `fetches` phases populate this page during `codehub analyze`.",
    "",
  ].join("\n");
}
