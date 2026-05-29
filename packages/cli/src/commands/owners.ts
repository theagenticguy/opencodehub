/**
 * `codehub owners <target>` — ranked OWNED_BY contributors for a node.
 *
 * CLI sibling of the MCP `owners` tool. Both surfaces call the shared
 * `listOwners` fn from `@opencodehub/analysis`, which walks the OWNED_BY
 * edges in confidence-descending order (with a `.to` ASC tiebreak), slices
 * to `limit` BEFORE the Contributor join, then joins for display metadata.
 *
 * Mirrors `packages/mcp/src/tools/owners.ts`. Does NOT emit the MCP
 * next_steps / staleness envelope.
 */

import { listOwners } from "@opencodehub/analysis";
import type { Store } from "@opencodehub/storage";
import { openStoreForCommand } from "./open-store.js";

export interface OwnersOptions {
  readonly repo?: string;
  readonly home?: string;
  readonly json?: boolean;
  readonly limit?: number;
  /** Test seam — inject a fake store. Production leaves this unset. */
  readonly storeFactory?: () => Promise<{ store: Store; repoPath: string }>;
}

export async function runOwners(target: string, opts: OwnersOptions = {}): Promise<void> {
  const limit = opts.limit ?? 20;
  const factory = opts.storeFactory ?? (() => openStoreForCommand({ ...opts, readOnly: true }));
  const { store } = await factory();
  try {
    const owners = await listOwners(store.graph, target, limit);

    if (opts.json) {
      console.log(JSON.stringify({ owners, total: owners.length }, null, 2));
      return;
    }

    console.warn(`owners: ${target} (${owners.length}):`);
    if (owners.length === 0) {
      console.log(
        "(no OWNED_BY edges for this target — either the target id is unknown or the ownership phase has not run. Re-index with `codehub analyze --force`.)",
      );
      return;
    }
    for (const o of owners) {
      const id = o.email.length > 0 ? o.email : `sha256:${o.emailHash.slice(0, 10)}…`;
      const name = o.name.length > 0 ? o.name : "unknown";
      console.log(`- ${name} <${id}>  weight=${o.weight.toFixed(3)}`);
    }
  } finally {
    await store.close();
  }
}
