/**
 * `codehub project-profile` — return the ProjectProfile node for a repo.
 *
 * CLI sibling of the MCP `project_profile` tool. Reads the singleton
 * ProjectProfile node (`listNodesByKind("ProjectProfile", { limit: 1 })`)
 * and decodes each array field, preferring the structured framework view
 * (`name:variant`) when present.
 *
 * Mirrors `packages/mcp/src/tools/project-profile.ts`. Does NOT emit the MCP
 * next_steps / staleness envelope.
 */

import type { FrameworkDetection } from "@opencodehub/core-types";
import type { Store } from "@opencodehub/storage";
import { openStoreForCommand } from "./open-store.js";

export interface ProjectProfileOptions {
  readonly repo?: string;
  readonly home?: string;
  readonly json?: boolean;
  /** Test seam — inject a fake store. Production leaves this unset. */
  readonly storeFactory?: () => Promise<{ store: Store; repoPath: string }>;
}

interface ProjectProfilePayload {
  readonly languages: readonly string[];
  readonly frameworks: readonly string[];
  readonly frameworksDetected: readonly FrameworkDetection[];
  readonly iacTypes: readonly string[];
  readonly apiContracts: readonly string[];
  readonly manifests: readonly string[];
  readonly srcDirs: readonly string[];
}

export async function runProjectProfile(opts: ProjectProfileOptions = {}): Promise<void> {
  const factory = opts.storeFactory ?? (() => openStoreForCommand({ ...opts, readOnly: true }));
  const { store } = await factory();
  try {
    const nodes = await store.graph.listNodesByKind("ProjectProfile", { limit: 1 });
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

    if (opts.json) {
      console.log(JSON.stringify({ profile: payload }, null, 2));
      return;
    }

    if (profile === undefined) {
      console.warn(
        "project-profile: no ProjectProfile node found. Re-index with `codehub analyze --force` to populate.",
      );
      return;
    }

    if (payload.languages.length > 0) {
      console.log(`languages     (${payload.languages.length}): ${payload.languages.join(", ")}`);
    }
    if (payload.frameworks.length > 0) {
      const display =
        payload.frameworksDetected.length > 0
          ? payload.frameworksDetected.map((d) => (d.variant ? `${d.name}:${d.variant}` : d.name))
          : payload.frameworks;
      console.log(`frameworks    (${display.length}): ${display.join(", ")}`);
    }
    if (payload.iacTypes.length > 0) {
      console.log(`iacTypes      (${payload.iacTypes.length}): ${payload.iacTypes.join(", ")}`);
    }
    if (payload.apiContracts.length > 0) {
      console.log(
        `apiContracts  (${payload.apiContracts.length}): ${payload.apiContracts.join(", ")}`,
      );
    }
    if (payload.manifests.length > 0) {
      console.log(`manifests     (${payload.manifests.length}): ${payload.manifests.join(", ")}`);
    }
    if (payload.srcDirs.length > 0) {
      console.log(`srcDirs       (${payload.srcDirs.length}): ${payload.srcDirs.join(", ")}`);
    }
  } finally {
    await store.close();
  }
}
