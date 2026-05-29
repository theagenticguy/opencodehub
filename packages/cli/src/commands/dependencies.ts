/**
 * `codehub dependencies` — enumerate Dependency nodes for an indexed repo.
 *
 * CLI sibling of the MCP `dependencies` tool and of `license-audit`. Reads
 * `store.graph.listDependencies()` (optionally narrowed by ecosystem) and
 * applies the same `filePath` substring post-filter, then renders a table.
 *
 * Mirrors `packages/mcp/src/tools/dependencies.ts`. Does NOT emit the MCP
 * next_steps / staleness envelope.
 */

import type { Store } from "@opencodehub/storage";
import { openStoreForCommand } from "./open-store.js";

export interface DependenciesOptions {
  readonly repo?: string;
  readonly home?: string;
  readonly json?: boolean;
  readonly filePath?: string;
  readonly ecosystem?: "npm" | "pypi" | "go" | "cargo" | "maven" | "nuget";
  readonly limit?: number;
  /** Test seam — inject a fake store. Production leaves this unset. */
  readonly storeFactory?: () => Promise<{ store: Store; repoPath: string }>;
}

interface DependencyRow {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly ecosystem: string;
  readonly license: string;
  readonly lockfileSource: string;
}

export async function runDependencies(opts: DependenciesOptions = {}): Promise<void> {
  const limit = opts.limit ?? 500;
  const factory = opts.storeFactory ?? (() => openStoreForCommand({ ...opts, readOnly: true }));
  const { store } = await factory();
  try {
    const listOpts: { ecosystem?: string; limit?: number } = { limit };
    if (opts.ecosystem !== undefined) listOpts.ecosystem = opts.ecosystem;
    const all = await store.graph.listDependencies(listOpts);
    const filtered =
      opts.filePath === undefined
        ? all
        : all.filter((d) => {
            const lf = d.lockfileSource ?? d.filePath;
            return lf.includes(opts.filePath as string);
          });

    const rows: DependencyRow[] = filtered.map((d) => ({
      id: d.id,
      name: d.name,
      version: stringOr(d.version, "UNKNOWN"),
      ecosystem: stringOr(d.ecosystem, "unknown"),
      license: stringOr(d.license, "UNKNOWN"),
      lockfileSource: stringOr(d.lockfileSource, d.filePath),
    }));

    if (opts.json) {
      console.log(JSON.stringify({ dependencies: rows, total: rows.length }, null, 2));
      return;
    }

    if (rows.length === 0) {
      console.warn(
        "dependencies: no dependencies found — index the repo with `codehub analyze` and verify the `dependencies` phase ran",
      );
      return;
    }
    for (const d of rows) {
      console.log(
        `[${d.ecosystem}] ${d.name}@${d.version}  (${d.lockfileSource}, license=${d.license})`,
      );
    }
  } finally {
    await store.close();
  }
}

function stringOr(v: unknown, fallback: string): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}
