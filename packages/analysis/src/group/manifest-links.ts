/**
 * Extract producer↔consumer hints from package manifests.
 *
 * The ContractRegistry resolver uses these hints to pair contracts that
 * cannot be matched on signature alone (e.g. gRPC client/server sharing
 * a published stub package, or a consumer repo depending on a shared
 * topic-contract library).
 *
 * Heuristic: a ManifestLink is emitted when repo A declares a dependency
 * with the same `name` that repo B declares as a workspace package / own
 * package (matched against `package.json`'s `name` field or a pyproject
 * `project.name`). We treat the repo publishing the name as the
 * `producerRepo` and the repo consuming it as `consumerRepo`. Type is
 * inferred heuristically from the package name (anything mentioning
 * "grpc", "proto", "stub", "schema" is gRPC; otherwise treated as http).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContractType } from "./types.js";

export interface RepoManifestSummary {
  readonly repo: string;
  /** Declared package name — from package.json `name` or pyproject project.name. */
  readonly packageName?: string;
  /** Packages this repo depends on (production + peer for JS, project.dependencies for py). */
  readonly dependencies: readonly string[];
}

export interface ManifestLink {
  readonly producerRepo: string;
  readonly consumerRepo: string;
  readonly contract: string;
  readonly type: ContractType;
}

async function readJsonIfExists(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** Very small, dependency-free pyproject extractor for `[project]` keys. */
function parsePyprojectTopLevel(raw: string): {
  name?: string;
  dependencies: string[];
} {
  const result: { name?: string; dependencies: string[] } = { dependencies: [] };
  const lines = raw.split(/\r?\n/);
  let section = "";
  let collectingDeps = false;
  const depBuffer: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      if (collectingDeps) {
        for (const entry of depBuffer) {
          const name = entry.trim().replace(/^['"]|['"]$/g, "");
          const bare = name.split(/[<>=!~\s[]/)[0] ?? "";
          if (bare.length > 0) result.dependencies.push(bare);
        }
        depBuffer.length = 0;
        collectingDeps = false;
      }
      section = trimmed.slice(1, -1);
      continue;
    }
    if (section === "project" && trimmed.startsWith("name")) {
      const eq = trimmed.indexOf("=");
      if (eq >= 0) {
        const value = trimmed.slice(eq + 1).trim();
        result.name = value.replace(/^['"]|['"]$/g, "");
      }
    }
    if (section === "project" && trimmed.startsWith("dependencies")) {
      // inline form: dependencies = ["a", "b"]  or block form across lines
      const eq = trimmed.indexOf("=");
      if (eq >= 0) {
        const rest = trimmed.slice(eq + 1).trim();
        if (rest.startsWith("[") && rest.endsWith("]")) {
          const inner = rest.slice(1, -1);
          inner.split(",").forEach((chunk) => {
            const n = chunk.trim().replace(/^['"]|['"]$/g, "");
            const bare = n.split(/[<>=!~\s[]/)[0] ?? "";
            if (bare.length > 0) result.dependencies.push(bare);
          });
        } else if (rest.startsWith("[")) {
          collectingDeps = true;
        }
      }
      continue;
    }
    if (collectingDeps) {
      if (trimmed.startsWith("]")) {
        for (const entry of depBuffer) {
          const name = entry.replace(/^['"]|['"]$/g, "");
          const bare = name.split(/[<>=!~\s[]/)[0] ?? "";
          if (bare.length > 0) result.dependencies.push(bare);
        }
        depBuffer.length = 0;
        collectingDeps = false;
        continue;
      }
      for (const chunk of trimmed.split(",")) {
        const stripped = chunk.trim();
        if (stripped.length === 0) continue;
        depBuffer.push(stripped);
      }
    }
  }
  if (collectingDeps) {
    for (const entry of depBuffer) {
      const name = entry.replace(/^['"]|['"]$/g, "");
      const bare = name.split(/[<>=!~\s[]/)[0] ?? "";
      if (bare.length > 0) result.dependencies.push(bare);
    }
  }
  return result;
}

/**
 * Read manifests at the repo root and return a uniform summary. Missing
 * files are treated as "no hints available" — callers never need to
 * branch on presence.
 */
export async function readRepoManifest(
  repo: string,
  repoPath: string,
): Promise<RepoManifestSummary> {
  const deps = new Set<string>();
  let packageName: string | undefined;

  const pkg = await readJsonIfExists(join(repoPath, "package.json"));
  if (pkg) {
    const name = pkg["name"];
    if (typeof name === "string") packageName = name;
    for (const key of ["dependencies", "devDependencies", "peerDependencies"] as const) {
      const block = pkg[key];
      if (block && typeof block === "object" && !Array.isArray(block)) {
        for (const dep of Object.keys(block as Record<string, unknown>)) {
          deps.add(dep);
        }
      }
    }
  }

  const toml = await readTextIfExists(join(repoPath, "pyproject.toml"));
  if (toml) {
    const parsed = parsePyprojectTopLevel(toml);
    if (parsed.name && !packageName) packageName = parsed.name;
    for (const d of parsed.dependencies) deps.add(d);
  }

  return {
    repo,
    ...(packageName !== undefined ? { packageName } : {}),
    dependencies: [...deps].sort(),
  };
}

function inferContractType(pkg: string): ContractType {
  const lower = pkg.toLowerCase();
  if (lower.includes("grpc") || lower.includes("proto") || lower.includes("stub")) {
    return "grpc_service";
  }
  if (
    lower.includes("kafka") ||
    lower.includes("sns") ||
    lower.includes("sqs") ||
    lower.includes("topic")
  ) {
    return "topic_producer";
  }
  return "http_route";
}

/**
 * Build manifest-derived links from a list of repo summaries. For every
 * `(producer, consumer)` pair where consumer depends on producer's
 * package name, emit a ManifestLink.
 */
export function buildManifestLinks(
  summaries: readonly RepoManifestSummary[],
): readonly ManifestLink[] {
  const out: ManifestLink[] = [];
  const byPackage = new Map<string, string>();
  for (const s of summaries) {
    if (s.packageName) byPackage.set(s.packageName, s.repo);
  }
  for (const consumer of summaries) {
    for (const dep of consumer.dependencies) {
      const producerRepo = byPackage.get(dep);
      if (!producerRepo) continue;
      if (producerRepo === consumer.repo) continue;
      out.push({
        producerRepo,
        consumerRepo: consumer.repo,
        contract: dep,
        type: inferContractType(dep),
      });
    }
  }
  return out.sort((a, b) => {
    if (a.producerRepo !== b.producerRepo) return a.producerRepo < b.producerRepo ? -1 : 1;
    if (a.consumerRepo !== b.consumerRepo) return a.consumerRepo < b.consumerRepo ? -1 : 1;
    if (a.contract !== b.contract) return a.contract < b.contract ? -1 : 1;
    return a.type < b.type ? -1 : a.type > b.type ? 1 : 0;
  });
}
