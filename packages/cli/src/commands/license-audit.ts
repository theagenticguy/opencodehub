/**
 * `codehub license-audit` — classify Dependency nodes by license risk tier.
 *
 * CLI sibling of the MCP `license_audit` tool. Reads every Dependency node
 * (`store.graph.listDependencies()`), maps each row to a `DependencyRef`,
 * and runs `classifyDependencies` from `@opencodehub/analysis`.
 *
 * Mirrors `packages/mcp/src/tools/license-audit.ts`. Does NOT emit the MCP
 * next_steps / staleness envelope.
 */

import { classifyDependencies, type DependencyRef } from "@opencodehub/analysis";
import type { Store } from "@opencodehub/storage";
import { openStoreForCommand } from "./open-store.js";

export interface LicenseAuditOptions {
  readonly repo?: string;
  readonly home?: string;
  readonly json?: boolean;
  /** Test seam — inject a fake store. Production leaves this unset. */
  readonly storeFactory?: () => Promise<{ store: Store; repoPath: string }>;
}

export async function runLicenseAudit(opts: LicenseAuditOptions = {}): Promise<void> {
  const factory = opts.storeFactory ?? (() => openStoreForCommand({ ...opts, readOnly: true }));
  const { store } = await factory();
  try {
    const all = await store.graph.listDependencies();
    const deps: DependencyRef[] = all.map((d) => ({
      id: d.id,
      name: d.name,
      version: stringOr(d.version, "UNKNOWN"),
      ecosystem: stringOr(d.ecosystem, "unknown"),
      license: stringOr(d.license, "UNKNOWN"),
      lockfileSource: stringOr(d.lockfileSource, d.filePath),
    }));

    const result = classifyDependencies(deps);

    if (opts.json) {
      console.log(
        JSON.stringify(
          { tier: result.tier, flagged: result.flagged, summary: result.summary },
          null,
          2,
        ),
      );
      return;
    }

    console.warn(
      `license-audit: tier=${result.tier} (${result.summary.okCount}/${result.summary.total} ok, ${result.summary.flaggedCount} flagged)`,
    );
    if (result.flagged.copyleft.length > 0) {
      console.log(`Copyleft (${result.flagged.copyleft.length}):`);
      for (const d of result.flagged.copyleft) {
        console.log(`  - [${d.ecosystem}] ${d.name}@${d.version} — ${d.license}`);
      }
    }
    if (result.flagged.proprietary.length > 0) {
      console.log(`Proprietary (${result.flagged.proprietary.length}):`);
      for (const d of result.flagged.proprietary) {
        console.log(`  - [${d.ecosystem}] ${d.name}@${d.version} — ${d.license}`);
      }
    }
    if (result.flagged.unknown.length > 0) {
      console.log(`Unknown/missing (${result.flagged.unknown.length}):`);
      for (const d of result.flagged.unknown.slice(0, 25)) {
        console.log(`  - [${d.ecosystem}] ${d.name}@${d.version}`);
      }
      if (result.flagged.unknown.length > 25) {
        console.log(`  ... ${result.flagged.unknown.length - 25} more`);
      }
    }
    if (
      result.flagged.copyleft.length === 0 &&
      result.flagged.proprietary.length === 0 &&
      result.flagged.unknown.length === 0
    ) {
      console.log("All licenses cleared.");
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
