/**
 * Dependencies phase — materialises external packages as Dependency
 * nodes and links them to the manifest File node via DEPENDS_ON.
 *
 * Inputs: scan output (file list). We classify every scanned file by
 * basename (optionally extension) and dispatch to a per-ecosystem parser
 * (see `../dep-parsers/`). Each parser returns a list of
 * `ParsedDependency` tuples; the phase promotes them to `DependencyNode`
 * entries with the canonical id scheme
 *
 *     `Dependency:${ecosystem}:${name}@${version}`
 *
 * and adds DEPENDS_ON edges:
 *
 *     File(manifestPath) --DEPENDS_ON--> Dependency(...)
 *
 * This is intentionally coarse — v1.0 emits one DEPENDS_ON per
 * (manifest, dep) rather than per-importing-source-file. A later pass
 * can refine this to per-file once the parse phase exposes package
 * resolution data.
 *
 * Determinism:
 *   - Manifests visited in scan order (scan output is already sorted).
 *   - Dependencies sorted canonically by
 *     (ecosystem, name, version, lockfileSource) before graph insertion.
 *   - `skippedEcosystems` output is sorted ascending.
 *
 * The phase is tolerant: any parser error becomes a warning and the
 * offending manifest is skipped. Network access is forbidden.
 *
 * Phase dependency: `scan`. The phase is designed to eventually also
 * depend on the ProjectProfile phase — we only need the scan output
 * today, and the profile phase does not yet exist in default-set.
 */

import type { DependencyNode, KnowledgeGraph, NodeId } from "@opencodehub/core-types";
import { makeNodeId } from "@opencodehub/core-types";
import { parseGoDeps } from "../dep-parsers/go.js";
import {
  compareParsedDependency,
  dedupAndSort,
  type Ecosystem,
  type ParseDepsFn,
  type ParsedDependency,
} from "../dep-parsers/index.js";
import { parseMavenDeps } from "../dep-parsers/maven.js";
import { parseNpmDeps } from "../dep-parsers/npm.js";
import { parseNugetDeps } from "../dep-parsers/nuget.js";
import { parsePythonDeps } from "../dep-parsers/python.js";
import { parseRustDeps } from "../dep-parsers/rust.js";
import type { PipelineContext, PipelinePhase } from "../types.js";
import { PROFILE_PHASE_NAME } from "./profile.js";
import { SCAN_PHASE_NAME, type ScannedFile, type ScanOutput } from "./scan.js";

export const DEPENDENCIES_PHASE_NAME = "dependencies" as const;

export interface DependenciesOutput {
  readonly dependenciesEmitted: number;
  readonly manifestsScanned: number;
  /** Ecosystems with no discovered manifests (alphabetical). */
  readonly skippedEcosystems: readonly Ecosystem[];
}

interface ManifestDispatch {
  readonly ecosystem: Ecosystem;
  readonly parse: ParseDepsFn;
}

/**
 * Classify a scanned file by its basename + extension to decide which
 * ecosystem parser should receive it. Order of checks matters: `go.mod`
 * and `go.sum` must beat a generic `.mod` / `.sum` rule that does not
 * exist (we are explicit to stay deterministic).
 *
 * Returns `undefined` for files we don't care about.
 */
export function classifyManifest(relPath: string): ManifestDispatch | undefined {
  // Use forward-slash splitting; scan emits POSIX paths.
  const parts = relPath.split("/");
  const basename = parts[parts.length - 1] ?? relPath;

  // npm
  if (basename === "package-lock.json" || basename === "pnpm-lock.yaml") {
    return { ecosystem: "npm", parse: parseNpmDeps };
  }
  // Bare package.json (lockfile preferred when both are present — we
  // handle that at the phase level by skipping package.json when a
  // sibling lockfile is in the manifest set).
  if (basename === "package.json") {
    return { ecosystem: "npm", parse: parseNpmDeps };
  }

  // python
  if (basename === "pyproject.toml") {
    return { ecosystem: "pypi", parse: parsePythonDeps };
  }
  if (basename === "uv.lock") {
    return { ecosystem: "pypi", parse: parsePythonDeps };
  }
  if (basename === "requirements.txt" || /^requirements-.*\.txt$/.test(basename)) {
    return { ecosystem: "pypi", parse: parsePythonDeps };
  }

  // go
  if (basename === "go.mod" || basename === "go.sum") {
    return { ecosystem: "go", parse: parseGoDeps };
  }

  // rust
  if (basename === "Cargo.lock" || basename === "Cargo.toml") {
    return { ecosystem: "cargo", parse: parseRustDeps };
  }

  // maven
  if (basename === "pom.xml") {
    return { ecosystem: "maven", parse: parseMavenDeps };
  }

  // nuget
  if (
    basename === "packages.lock.json" ||
    basename.endsWith(".csproj") ||
    basename.endsWith(".fsproj") ||
    basename.endsWith(".vbproj")
  ) {
    return { ecosystem: "nuget", parse: parseNugetDeps };
  }

  return undefined;
}

export const dependenciesPhase: PipelinePhase<DependenciesOutput> = {
  name: DEPENDENCIES_PHASE_NAME,
  // Depends on `profile` so we only classify manifests the profile phase
  // already vetted — and so the dependency phase runs strictly after
  // ProjectProfile (this guarantees profile-driven ecosystem gating when
  // the profile's manifest list becomes a hard filter in v1.1).
  deps: [SCAN_PHASE_NAME, PROFILE_PHASE_NAME],
  async run(ctx) {
    const scan = ctx.phaseOutputs.get(SCAN_PHASE_NAME) as ScanOutput | undefined;
    if (scan === undefined) {
      throw new Error("dependencies: scan output missing from phase outputs");
    }
    return runDependencies(ctx, scan);
  },
};

async function runDependencies(
  ctx: PipelineContext,
  scan: ScanOutput,
): Promise<DependenciesOutput> {
  const classified = selectManifests(scan.files);

  const ecoWithDeps = new Set<Ecosystem>();
  const allParsed: ParsedDependency[] = [];
  let manifestsScanned = 0;

  for (const entry of classified) {
    manifestsScanned += 1;
    const deps = await entry.dispatch.parse({
      absPath: entry.file.absPath,
      relPath: entry.file.relPath,
      repoRoot: ctx.repoPath,
      onWarn: (m) => {
        ctx.onProgress?.({
          phase: DEPENDENCIES_PHASE_NAME,
          kind: "warn",
          message: m,
        });
      },
    });
    for (const d of deps) {
      allParsed.push(d);
      ecoWithDeps.add(d.ecosystem);
    }
  }

  // Dedup + canonical sort before emitting nodes/edges. Two manifests in
  // the same repo (e.g. package.json + package-lock.json) will typically
  // yield overlapping sets; dedup on
  // (ecosystem, name, version, lockfileSource) retains both sources'
  // edges while keeping a single node per coordinate.
  const deduped = dedupAndSort(allParsed);

  // Build Dependency nodes (one node per (ecosystem, name, version)
  // coordinate — lockfileSource is *not* part of node identity, but
  // remembered on the node via `lockfileSource` field using the first
  // source encountered in canonical order).
  const nodeById = new Map<NodeId, DependencyNode>();
  for (const d of deduped) {
    const id = depNodeId(d.ecosystem, d.name, d.version);
    const license = normalizeLicenseField(d.license);
    const existing = nodeById.get(id);
    if (existing === undefined) {
      const node: DependencyNode = {
        id,
        kind: "Dependency",
        name: d.name,
        filePath: d.lockfileSource,
        version: d.version,
        ecosystem: d.ecosystem,
        lockfileSource: d.lockfileSource,
        license,
      };
      nodeById.set(id, node);
    } else if (existing.license === "UNKNOWN" && license !== "UNKNOWN") {
      // Upgrade UNKNOWN when a later source for the same coordinate
      // carries a real license.
      nodeById.set(id, { ...existing, license });
    }
  }

  // Insert into graph in canonical order for byte-stable hashing.
  const nodes = [...nodeById.values()].sort(compareNodeByIdString);
  for (const n of nodes) {
    ctx.graph.addNode(n);
  }

  // DEPENDS_ON edges: File(manifestPath) --> Dependency(...).
  // Emit each edge at most once (same manifest referencing the same dep
  // across npm's package.json + package-lock.json would otherwise double).
  emitDependencyEdges(ctx.graph, deduped);

  const dependenciesEmitted = nodeById.size;
  const ALL_ECOS: readonly Ecosystem[] = ["npm", "pypi", "go", "cargo", "maven", "nuget"];
  const skippedEcosystems = ALL_ECOS.filter((e) => !ecoWithDeps.has(e)).sort();

  return {
    dependenciesEmitted,
    manifestsScanned,
    skippedEcosystems,
  };
}

interface ClassifiedManifest {
  readonly file: ScannedFile;
  readonly dispatch: ManifestDispatch;
}

/**
 * Walk the scan file list and pick the manifests we know how to parse.
 * npm has a prefer-lockfile rule: if a directory has
 * `package-lock.json`, we skip the sibling `package.json` to avoid
 * emitting two versions for the same tree (one specifier string, one
 * resolved version). Same for `pnpm-lock.yaml`.
 */
function selectManifests(files: readonly ScannedFile[]): readonly ClassifiedManifest[] {
  // Index of directory -> set of basenames (used for the prefer-lockfile rule).
  const dirBasenames = new Map<string, Set<string>>();
  for (const f of files) {
    const slash = f.relPath.lastIndexOf("/");
    const dir = slash === -1 ? "" : f.relPath.slice(0, slash);
    const base = slash === -1 ? f.relPath : f.relPath.slice(slash + 1);
    let set = dirBasenames.get(dir);
    if (!set) {
      set = new Set();
      dirBasenames.set(dir, set);
    }
    set.add(base);
  }

  const out: ClassifiedManifest[] = [];
  for (const f of files) {
    const dispatch = classifyManifest(f.relPath);
    if (!dispatch) continue;
    const slash = f.relPath.lastIndexOf("/");
    const dir = slash === -1 ? "" : f.relPath.slice(0, slash);
    const basename = slash === -1 ? f.relPath : f.relPath.slice(slash + 1);
    if (basename === "package.json") {
      const sib = dirBasenames.get(dir);
      if (sib && (sib.has("package-lock.json") || sib.has("pnpm-lock.yaml"))) {
        continue;
      }
    }
    if (basename === "Cargo.toml") {
      const sib = dirBasenames.get(dir);
      if (sib?.has("Cargo.lock")) continue;
    }
    if (basename === "go.mod") {
      // Prefer go.sum when present; it enumerates transitives explicitly
      // and dedups to the exact module graph.
      const sib = dirBasenames.get(dir);
      if (sib?.has("go.sum")) continue;
    }
    out.push({ file: f, dispatch });
  }
  return out;
}

function emitDependencyEdges(graph: KnowledgeGraph, deps: readonly ParsedDependency[]): void {
  // Sorted insertion matches the pre-dedup sort; confidence is a fixed
  // 1.0 because a lockfile is authoritative evidence of dependence.
  const sorted = [...deps].sort(compareParsedDependency);
  for (const d of sorted) {
    const fileId = makeNodeId("File", d.lockfileSource, d.lockfileSource);
    const depId = depNodeId(d.ecosystem, d.name, d.version);
    graph.addEdge({
      from: fileId,
      to: depId,
      type: "DEPENDS_ON",
      confidence: 1.0,
      reason: `manifest:${d.ecosystem}`,
    });
  }
}

function depNodeId(ecosystem: Ecosystem, name: string, version: string): NodeId {
  return makeNodeId("Dependency", ecosystem, `${name}@${version}`);
}

function compareNodeByIdString(a: DependencyNode, b: DependencyNode): number {
  const av = a.id as string;
  const bv = b.id as string;
  if (av === bv) return 0;
  return av < bv ? -1 : 1;
}

/**
 * Normalize a parser-supplied license value onto the DependencyNode.
 * Drops empty strings, collapses to `"UNKNOWN"` when the parser did not
 * find one, and leaves SPDX-normalisation to downstream callers that
 * need it (the `license_audit` tool does its own pass).
 */
function normalizeLicenseField(raw: string | undefined): string {
  if (raw === undefined) return "UNKNOWN";
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "UNKNOWN";
  return trimmed;
}
