/**
 * `dependenciesCapability` — the shared reader/filter/projection behind the MCP
 * `dependencies` tool (and, once the CLI adopts it, `codehub dependencies`).
 *
 * Lifted verbatim from the body of `mcp/src/tools/dependencies.ts`: the typed
 * `listDependencies({ecosystem?, limit})` finder, the TS `filePath` substring
 * post-filter over `lockfileSource ?? filePath`, and the row projection through
 * the one canonical `stringOr`. The surface maps `DependenciesOutput` into its
 * own transport (text body + next_steps + staleness envelope).
 */

import type { Capability, CapabilityContext } from "../capability.js";
import { stringOr } from "../string-or.js";

/**
 * The validated, plain input `dependenciesCapability.execute` consumes.
 * `repo`/`repo_uri` are resolved to a concrete store by the surface BEFORE
 * `execute` runs; they live on the input only so a surface can pass its parsed
 * args object through unchanged.
 */
export interface DependenciesInput {
  readonly repo?: string;
  readonly repo_uri?: string;
  readonly ecosystem?: "npm" | "pypi" | "go" | "cargo" | "maven" | "nuget";
  readonly filePath?: string;
  readonly limit?: number;
}

/**
 * One projected dependency row — the flat shape the surface renders. Kept as a
 * flat object so clients that only inspect `structuredContent` can grok it
 * without crawling the graph.
 */
export interface DependencyRow {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly ecosystem: string;
  readonly license: string;
  readonly lockfileSource: string;
}

/** The applied filters, echoed back so presenters can label the output. */
export interface DependenciesFilters {
  readonly ecosystem?: string;
  readonly filePath?: string;
}

export interface DependenciesOutput {
  readonly repoName: string;
  readonly dependencies: readonly DependencyRow[];
  readonly total: number;
  readonly filters: DependenciesFilters;
}

export const dependenciesCapability: Capability<DependenciesInput, DependenciesOutput> = {
  id: "dependencies",
  async execute(input: DependenciesInput, ctx: CapabilityContext): Promise<DependenciesOutput> {
    const limit = input.limit ?? 500;

    // Typed `listDependencies` finder reads the Dependency rows directly,
    // already rehydrated into the typed shape. The `filePath` substring
    // filter is applied in TS because the finder doesn't expose a LIKE
    // option — dependencies are bounded per repo so a TS filter is fine.
    const opts: { ecosystem?: string; limit?: number } = { limit };
    if (input.ecosystem !== undefined) opts.ecosystem = input.ecosystem;
    const all = await ctx.store.graph.listDependencies(opts);
    const filtered =
      input.filePath === undefined
        ? all
        : all.filter((d) => {
            const lf = d.lockfileSource ?? d.filePath;
            return lf.includes(input.filePath as string);
          });

    const dependencies: DependencyRow[] = filtered.map((d) => ({
      id: d.id,
      name: d.name,
      version: stringOr(d.version, "UNKNOWN"),
      ecosystem: stringOr(d.ecosystem, "unknown"),
      license: stringOr(d.license, "UNKNOWN"),
      lockfileSource: stringOr(d.lockfileSource, d.filePath),
    }));

    const filters: DependenciesFilters = {
      ...(input.ecosystem !== undefined ? { ecosystem: input.ecosystem } : {}),
      ...(input.filePath !== undefined ? { filePath: input.filePath } : {}),
    };

    return { repoName: ctx.repoName, dependencies, total: dependencies.length, filters };
  },
};
