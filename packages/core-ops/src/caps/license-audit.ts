/**
 * `licenseAuditCapability` — the shared reader/classifier behind the MCP
 * `license_audit` tool (and, once the CLI adopts it, `codehub license-audit`).
 *
 * Lifted verbatim from the body of `mcp/src/tools/license-audit.ts`: read every
 * Dependency node, project each into a `DependencyRef` through the one canonical
 * `stringOr`, then hand the set to `classifyDependencies` (the pure tier logic in
 * `@opencodehub/analysis`). The surface maps `LicenseAuditOutput` into its own
 * transport (text body + next_steps + staleness envelope).
 */

import {
  classifyDependencies,
  type DependencyRef,
  type LicenseAuditResult,
} from "@opencodehub/analysis";
import type { Capability, CapabilityContext } from "../capability.js";
import { stringOr } from "../string-or.js";

/**
 * The validated, plain input `licenseAuditCapability.execute` consumes.
 * `repo`/`repo_uri` are resolved to a concrete store by the surface BEFORE
 * `execute` runs; they live on the input only so a surface can pass its parsed
 * args object through unchanged.
 */
export interface LicenseAuditInput {
  readonly repo?: string;
  readonly repo_uri?: string;
}

export interface LicenseAuditOutput {
  readonly repoName: string;
  readonly result: LicenseAuditResult;
}

export const licenseAuditCapability: Capability<LicenseAuditInput, LicenseAuditOutput> = {
  id: "license_audit",
  async execute(_input: LicenseAuditInput, ctx: CapabilityContext): Promise<LicenseAuditOutput> {
    const all = await ctx.store.graph.listDependencies();
    const deps: DependencyRef[] = all.map((d) => ({
      id: d.id,
      name: d.name,
      version: stringOr(d.version, "UNKNOWN"),
      ecosystem: stringOr(d.ecosystem, "unknown"),
      license: stringOr(d.license, "UNKNOWN"),
      lockfileSource: stringOr(d.lockfileSource, d.filePath),
    }));

    const result = classifyDependencies(deps);
    return { repoName: ctx.repoName, result };
  },
};
