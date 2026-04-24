/**
 * Profile phase — single-pass repo profiling.
 *
 * Consumes the scan phase output and emits one `ProjectProfile` node per
 * repo with six sorted arrays:
 *   - languages      — file-count-threshold filtered, sorted by count desc
 *   - frameworks     — evidence-based (file markers OR manifest deps)
 *   - iacTypes       — terraform / docker / kubernetes / cloudformation / …
 *   - apiContracts   — openapi / graphql / grpc / asyncapi
 *   - manifests      — linguist-style priority cascade per ecosystem
 *   - srcDirs        — top-level source directories (>10 code files)
 *
 * The phase runs after `scan`, has no outbound deps, and is a pure leaf:
 * downstream phases (scanners gated on ProjectProfile) will read the
 * profile node from the graph, not from the phase output.
 *
 * Determinism: every detector returns a sorted array; the profile node is a
 * singleton per repo, so its id uses a constant qualified name ("repo")
 * rather than a hash of the absolute path. This keeps the node id stable
 * across checkouts of the same repo on different paths / machines, which is
 * required for the graphHash determinism gate (two clones of the same
 * commit must produce byte-identical graphs). Two runs of the same repo at
 * the same commit produce byte-identical profile nodes.
 */

import type { ProjectProfileNode } from "@opencodehub/core-types";
import { makeNodeId } from "@opencodehub/core-types";
import { detectApiContracts } from "../profile-detectors/api-contracts.js";
import { detectFrameworks } from "../profile-detectors/frameworks.js";
import { detectIaCTypes } from "../profile-detectors/iac.js";
import { detectLanguages } from "../profile-detectors/languages.js";
import { detectManifests } from "../profile-detectors/manifests.js";
import { detectSrcDirs } from "../profile-detectors/src-dirs.js";
import type { PipelineContext, PipelinePhase } from "../types.js";
import { SCAN_PHASE_NAME, type ScanOutput } from "./scan.js";

export const PROFILE_PHASE_NAME = "profile" as const;

export interface ProfileOutput {
  readonly profileEmitted: boolean;
  readonly languagesDetected: number;
  readonly frameworksDetected: number;
}

export const profilePhase: PipelinePhase<ProfileOutput> = {
  name: PROFILE_PHASE_NAME,
  deps: [SCAN_PHASE_NAME],
  async run(ctx, deps) {
    const scan = deps.get(SCAN_PHASE_NAME) as ScanOutput | undefined;
    if (scan === undefined) {
      throw new Error("profile: scan output missing from dependency map");
    }
    return runProfile(ctx, scan);
  },
};

async function runProfile(ctx: PipelineContext, scan: ScanOutput): Promise<ProfileOutput> {
  const files = scan.files;

  // Manifests must be computed first: framework detection consults them to
  // know which manifest files exist before probing for declared deps.
  const manifests = detectManifests(files);
  const languages = detectLanguages(files);
  const [iacTypes, apiContracts, frameworks] = await Promise.all([
    detectIaCTypes(ctx.repoPath, files),
    detectApiContracts(ctx.repoPath, files),
    detectFrameworks({ repoRoot: ctx.repoPath, files, manifests }),
  ]);
  const srcDirs = detectSrcDirs(files);

  // Singleton per repo: use a constant qualified name so the id is stable
  // across clones of the same repo on different absolute paths. The graph
  // is already scoped to one repo, so uniqueness within the graph is
  // preserved without encoding the path. See the module JSDoc for the
  // determinism rationale.
  const id = makeNodeId("ProjectProfile", "", "repo");

  const node: ProjectProfileNode = {
    id,
    kind: "ProjectProfile",
    name: "project-profile",
    filePath: "",
    languages,
    frameworks,
    iacTypes,
    apiContracts,
    manifests,
    srcDirs,
  };
  ctx.graph.addNode(node);

  return {
    profileEmitted: true,
    languagesDetected: languages.length,
    frameworksDetected: frameworks.length,
  };
}
