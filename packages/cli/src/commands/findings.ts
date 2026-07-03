/**
 * `codehub findings` — enumerate SARIF Finding nodes for an indexed repo.
 *
 * CLI sibling of the MCP `list_findings` tool. The shared reader/filter/
 * projection now lives in `@opencodehub/core-ops` `findingsCapability` — this
 * command is the thin CLI adapter: open the store, run the capability, render
 * to stdout (text or `--json`). Does NOT emit the MCP next_steps / staleness
 * envelope — that is MCP-only.
 */

import { type FindingsInput, findingsCapability } from "@opencodehub/core-ops";
import type { Store } from "@opencodehub/storage";
import { openStoreForCommand } from "./open-store.js";

export interface FindingsOptions {
  readonly repo?: string;
  readonly home?: string;
  readonly json?: boolean;
  readonly severity?: "error" | "warning" | "note" | "none";
  readonly scanner?: string;
  readonly ruleId?: string;
  readonly filePath?: string;
  readonly limit?: number;
  /** Test seam — inject a fake store. Production leaves this unset. */
  readonly storeFactory?: () => Promise<{ store: Store; repoPath: string }>;
}

export async function runFindings(opts: FindingsOptions = {}): Promise<void> {
  const factory = opts.storeFactory ?? (() => openStoreForCommand({ ...opts, readOnly: true }));
  const { store, repoPath } = await factory();
  try {
    const input: FindingsInput = {
      ...(opts.severity !== undefined ? { severity: opts.severity } : {}),
      ...(opts.scanner !== undefined ? { scanner: opts.scanner } : {}),
      ...(opts.ruleId !== undefined ? { ruleId: opts.ruleId } : {}),
      ...(opts.filePath !== undefined ? { filePath: opts.filePath } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    };
    const out = await findingsCapability.execute(input, {
      store,
      repoName: opts.repo ?? repoPath,
    });

    if (opts.json) {
      console.log(JSON.stringify({ findings: out.findings, total: out.total }, null, 2));
      return;
    }

    if (out.total === 0) {
      console.warn(
        "findings: no findings matched — run `codehub scan` or `codehub ingest-sarif <log>` to populate Finding nodes",
      );
      return;
    }
    for (const f of out.findings) {
      const loc = f.startLine !== undefined ? `:${f.startLine}` : "";
      const msg = f.message ? ` — ${f.message}` : "";
      console.log(`[${f.severity}] ${f.scanner}:${f.ruleId} at ${f.filePath}${loc}${msg}`);
    }
  } finally {
    await store.close();
  }
}
