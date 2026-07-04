/**
 * `projectProfileCapability` — the shared reader behind the MCP
 * `project_profile` tool (and, once the CLI adopts it, `codehub profile`).
 *
 * Lifted verbatim from the body of `mcp/src/tools/project-profile.ts`: read the
 * singleton ProjectProfile node, decode every array column back into a plain
 * array, and report whether the node existed at all (so the surface can nudge
 * toward `codehub analyze --force`). The surface maps `ProjectProfileOutput`
 * into its own transport (text body + next_steps + staleness envelope).
 */

import type { FrameworkDetection } from "@opencodehub/core-types";
import type { Capability, CapabilityContext } from "../capability.js";

/**
 * The validated, plain input `projectProfileCapability.execute` consumes.
 * `repo`/`repo_uri` are resolved to a concrete store by the surface BEFORE
 * `execute` runs; they live on the input only so a surface can pass its parsed
 * args object through unchanged.
 */
export interface ProjectProfileInput {
  readonly repo?: string;
  readonly repo_uri?: string;
}

export interface ProjectProfilePayload {
  readonly languages: readonly string[];
  /** Flat-string framework view (backward-compat). */
  readonly frameworks: readonly string[];
  /** Structured framework detections with variant / version / confidence / parent. */
  readonly frameworksDetected: readonly FrameworkDetection[];
  readonly iacTypes: readonly string[];
  readonly apiContracts: readonly string[];
  readonly manifests: readonly string[];
  readonly srcDirs: readonly string[];
}

export interface ProjectProfileOutput {
  readonly repoName: string;
  /** Whether a ProjectProfile node was present (drives the surface's hint). */
  readonly profileExists: boolean;
  readonly profile: ProjectProfilePayload;
}

export const projectProfileCapability: Capability<ProjectProfileInput, ProjectProfileOutput> = {
  id: "project_profile",
  async execute(
    _input: ProjectProfileInput,
    ctx: CapabilityContext,
  ): Promise<ProjectProfileOutput> {
    const nodes = await ctx.store.graph.listNodesByKind("ProjectProfile", { limit: 1 });
    const profile = nodes[0];
    const payload: ProjectProfilePayload = {
      languages: profile?.languages ? [...profile.languages] : [],
      frameworks: profile?.frameworks ? [...profile.frameworks] : [],
      frameworksDetected: profile?.frameworksDetected ? [...profile.frameworksDetected] : [],
      iacTypes: profile?.iacTypes ? [...profile.iacTypes] : [],
      apiContracts: profile?.apiContracts ? [...profile.apiContracts] : [],
      manifests: profile?.manifests ? [...profile.manifests] : [],
      srcDirs: profile?.srcDirs ? [...profile.srcDirs] : [],
    };

    return { repoName: ctx.repoName, profileExists: profile !== undefined, profile: payload };
  },
};
