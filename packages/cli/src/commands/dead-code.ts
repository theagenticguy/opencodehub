/**
 * `codehub dead-code` — enumerate dead and unreachable-export symbols.
 *
 * CLI sibling of the MCP `list_dead_code` tool. Reuses `classifyDeadness`
 * from `@opencodehub/analysis`, then applies the same file-path-substring
 * filter, `includeUnreachableExports` toggle, and `limit` slice.
 *
 * Mirrors `packages/mcp/src/tools/list-dead-code.ts`. Does NOT emit the MCP
 * next_steps / staleness envelope.
 */

import { classifyDeadness, type DeadSymbol } from "@opencodehub/analysis";
import type { Store } from "@opencodehub/storage";
import { openStoreForCommand } from "./open-store.js";

export interface DeadCodeOptions {
  readonly repo?: string;
  readonly home?: string;
  readonly json?: boolean;
  readonly filePathPattern?: string;
  readonly includeUnreachableExports?: boolean;
  readonly limit?: number;
  /** Test seam — inject a fake store. Production leaves this unset. */
  readonly storeFactory?: () => Promise<{ store: Store; repoPath: string }>;
}

export async function runDeadCode(opts: DeadCodeOptions = {}): Promise<void> {
  const limit = opts.limit ?? 100;
  const includeUnreachable = opts.includeUnreachableExports ?? false;
  const pattern = opts.filePathPattern;
  const factory = opts.storeFactory ?? (() => openStoreForCommand({ ...opts, readOnly: true }));
  const { store } = await factory();
  try {
    const result = await classifyDeadness(store.graph);

    const filterByPath = (s: DeadSymbol): boolean =>
      pattern === undefined || s.filePath.includes(pattern);

    const dead = result.dead.filter(filterByPath);
    const unreachable = result.unreachableExports.filter(filterByPath);

    const combined: DeadSymbol[] = includeUnreachable ? [...dead, ...unreachable] : [...dead];
    const truncated = combined.slice(0, limit);

    const summary = {
      dead: result.dead.length,
      unreachableExports: result.unreachableExports.length,
      ghostCommunities: result.ghostCommunities.length,
    };

    if (opts.json) {
      console.log(
        JSON.stringify(
          { summary, symbols: truncated, ghostCommunities: [...result.ghostCommunities] },
          null,
          2,
        ),
      );
      return;
    }

    console.warn(
      `dead-code: ${summary.dead} dead · ${summary.unreachableExports} unreachable exports · ${summary.ghostCommunities} ghost communities.`,
    );
    if (truncated.length === 0) {
      console.log("(no non-live symbols match the filter)");
    } else {
      console.log(
        `Showing ${truncated.length} of ${combined.length}${pattern ? ` · filePath~${pattern}` : ""}:`,
      );
      for (const s of truncated) {
        console.log(`  • [${s.deadness}] ${s.name} [${s.kind}] — ${s.filePath}:${s.startLine}`);
      }
    }
    if (result.ghostCommunities.length > 0) {
      console.log(`Ghost communities (${result.ghostCommunities.length}):`);
      for (const c of result.ghostCommunities.slice(0, 20)) {
        console.log(`  ⊿ ${c}`);
      }
    }
  } finally {
    await store.close();
  }
}
