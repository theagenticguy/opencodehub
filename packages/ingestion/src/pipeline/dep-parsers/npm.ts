/**
 * npm ecosystem manifest parser.
 *
 * Entry manifest path kinds we recognise:
 *   - `package-lock.json` — npm lockfile (v1, v2, v3)
 *   - `pnpm-lock.yaml` — pnpm lockfile (5.x, 6.x, 9.x)
 *   - `package.json` — fallback when no lockfile sits beside it
 *
 * For lockfiles we lean on `snyk-nodejs-lockfile-parser` (Apache-2.0).
 * The top-level `buildDepTree` shim only supports the legacy v1
 * lockfile format; we therefore call the ecosystem-specific dep-graph
 * builders (`parseNpmLockV2Project`, `parsePnpmProject`) which handle
 * lockfileVersion 2/3 and modern pnpm layouts.
 *
 * For bare `package.json` (no lockfile), we parse top-level
 * `dependencies` + `devDependencies` directly — the version is the raw
 * semver specifier from the manifest (e.g. `^1.2.3`), which is the best
 * signal available without a resolver.
 *
 * Errors (malformed JSON/YAML, snyk parser throws) are captured and
 * reported via `onWarn`; the parser returns `[]` in that case.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  InvalidUserInputError,
  OutOfSyncError,
  parseNpmLockV2Project,
  parsePnpmProject,
} from "snyk-nodejs-lockfile-parser";
import type { ParseDepsFn, ParsedDependency } from "./types.js";

const NPM_ECO = "npm" as const;

/** Minimal shape we consume from the snyk DepGraph. */
interface DepGraphLike {
  getPkgs(): ReadonlyArray<{ name: string; version?: string }>;
}

/**
 * Dispatcher keyed on the final path segment.
 * `package.json` files are only parsed in "bare" mode when no lockfile
 * sits beside them; the phase passes only manifests that earned this.
 */
export const parseNpmDeps: ParseDepsFn = async (input) => {
  const basename = path.basename(input.relPath);
  try {
    if (basename === "package-lock.json") {
      return await parsePackageLock(input.absPath, input.relPath, input.onWarn);
    }
    if (basename === "pnpm-lock.yaml") {
      return await parsePnpmLock(input.absPath, input.relPath, input.onWarn);
    }
    if (basename === "package.json") {
      return await parseBarePackageJson(input.absPath, input.relPath, input.onWarn);
    }
  } catch (err) {
    input.onWarn(
      `npm: failed to parse ${input.relPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
  return [];
};

async function parsePackageLock(
  absPath: string,
  relPath: string,
  onWarn: (m: string) => void,
): Promise<readonly ParsedDependency[]> {
  const { manifestContents, lockContents } = await readManifestAndLock(
    absPath,
    relPath,
    onWarn,
    "package-lock.json",
  );
  if (manifestContents === undefined || lockContents === undefined) return [];

  let graph: DepGraphLike;
  try {
    graph = (await parseNpmLockV2Project(manifestContents, lockContents, {
      includeDevDeps: true,
      includeOptionalDeps: true,
      strictOutOfSync: false,
      pruneCycles: true,
    })) as unknown as DepGraphLike;
  } catch (err) {
    if (err instanceof InvalidUserInputError || err instanceof OutOfSyncError) {
      onWarn(`npm: ${relPath} parse error: ${err.message}`);
      return [];
    }
    onWarn(`npm: ${relPath} parse error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  const licenses = harvestLicensesFromLockJson(lockContents);
  return collectFromGraph(graph, relPath, licenses);
}

async function parsePnpmLock(
  absPath: string,
  relPath: string,
  onWarn: (m: string) => void,
): Promise<readonly ParsedDependency[]> {
  const { manifestContents, lockContents } = await readManifestAndLock(
    absPath,
    relPath,
    onWarn,
    "pnpm-lock.yaml",
  );
  if (manifestContents === undefined || lockContents === undefined) return [];

  let graph: DepGraphLike;
  try {
    graph = (await parsePnpmProject(manifestContents, lockContents, {
      includeDevDeps: true,
      includeOptionalDeps: true,
      strictOutOfSync: false,
      pruneWithinTopLevelDeps: true,
    })) as unknown as DepGraphLike;
  } catch (err) {
    if (err instanceof InvalidUserInputError || err instanceof OutOfSyncError) {
      onWarn(`npm: ${relPath} parse error: ${err.message}`);
      return [];
    }
    onWarn(`npm: ${relPath} parse error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  // pnpm v9+ lockfiles inline `resolution.integrity` + optionally
  // per-snapshot licenses — harvest what's present, best-effort.
  const licenses = harvestLicensesFromPnpmLockYaml(lockContents);
  return collectFromGraph(graph, relPath, licenses);
}

/**
 * Parse `pnpm-lock.yaml` text for `name@version → license` pairs.
 * Pure string scanning to avoid pulling in a YAML parser for a
 * best-effort field.
 */
function harvestLicensesFromPnpmLockYaml(lockContents: string): Map<string, string> {
  const out = new Map<string, string>();
  let currentKey: string | undefined;
  for (const rawLine of lockContents.split(/\r?\n/)) {
    // pnpm snapshot keys: `  '/foo@1.2.3':` or `  '/@scope/foo@1.2.3':`.
    const snapshot = /^\s+['"]?(\/?[^'"\s@]+(?:\/[^'"\s@]+)?@[^'"\s]+)['"]?:\s*$/.exec(rawLine);
    if (snapshot !== null) {
      currentKey = (snapshot[1] ?? "").replace(/^\//, "");
      continue;
    }
    const lic = /^\s+license:\s*(.+?)\s*$/.exec(rawLine);
    if (lic !== null && currentKey !== undefined) {
      const val = (lic[1] ?? "").replace(/^['"]|['"]$/g, "");
      if (val.length > 0) out.set(currentKey, val);
    }
  }
  return out;
}

/**
 * Scan `package-lock.json` / `pnpm-lock.yaml` contents for a
 * `name@version → license` map. Best-effort; returns an empty map on any
 * parse issue (licenses are optional metadata, not a pipeline invariant).
 */
function harvestLicensesFromLockJson(lockContents: string): Map<string, string> {
  const out = new Map<string, string>();
  let json: unknown;
  try {
    json = JSON.parse(lockContents);
  } catch {
    return out;
  }
  if (!isObject(json)) return out;
  // v2/v3 lockfile: `packages: { "node_modules/foo": { version, license } }`.
  const pkgs = json["packages"];
  if (isObject(pkgs)) {
    for (const [path, entry] of Object.entries(pkgs)) {
      if (path === "") continue;
      if (!isObject(entry)) continue;
      const version = typeof entry["version"] === "string" ? entry["version"] : "";
      const license = readLicenseField(entry["license"]);
      const name = pathToPackageName(path);
      if (name === undefined || version === "" || license === undefined) continue;
      out.set(`${name}@${version}`, license);
    }
  }
  // Legacy v1 lockfile: `dependencies: { foo: { version, license } }`.
  const deps = json["dependencies"];
  if (isObject(deps)) collectLegacyLockLicenses(deps, out);
  return out;
}

function pathToPackageName(lockPath: string): string | undefined {
  // `node_modules/foo` or `node_modules/@scope/name` — return the
  // rightmost `node_modules/<name>` segment. Nested forms follow the
  // same suffix shape so the same scan works.
  const idx = lockPath.lastIndexOf("node_modules/");
  if (idx < 0) return undefined;
  const tail = lockPath.slice(idx + "node_modules/".length);
  if (tail === "") return undefined;
  if (tail.startsWith("@")) {
    const parts = tail.split("/");
    if (parts.length < 2) return undefined;
    return `${parts[0]}/${parts[1]}`;
  }
  return tail.split("/")[0];
}

function collectLegacyLockLicenses(
  deps: Record<string, unknown>,
  out: Map<string, string>,
): void {
  for (const [name, entry] of Object.entries(deps)) {
    if (!isObject(entry)) continue;
    const version = typeof entry["version"] === "string" ? entry["version"] : "";
    const license = readLicenseField(entry["license"]);
    if (version !== "" && license !== undefined) out.set(`${name}@${version}`, license);
    const nested = entry["dependencies"];
    if (isObject(nested)) collectLegacyLockLicenses(nested, out);
  }
}

/** `license` may be a string, `{ type, url }`, or an array of those. */
function readLicenseField(raw: unknown): string | undefined {
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (isObject(raw)) {
    const t = raw["type"];
    if (typeof t === "string" && t.length > 0) return t;
  }
  if (Array.isArray(raw)) {
    const parts: string[] = [];
    for (const item of raw) {
      const got = readLicenseField(item);
      if (got !== undefined) parts.push(got);
    }
    if (parts.length > 0) return parts.join(" OR ");
  }
  return undefined;
}

async function parseBarePackageJson(
  absPath: string,
  relPath: string,
  onWarn: (m: string) => void,
): Promise<readonly ParsedDependency[]> {
  let raw: string;
  try {
    raw = await fs.readFile(absPath, "utf8");
  } catch (err) {
    onWarn(`npm: cannot read ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    onWarn(
      `npm: ${relPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
  if (!isObject(json)) {
    onWarn(`npm: ${relPath} top-level is not an object`);
    return [];
  }
  const out: ParsedDependency[] = [];
  for (const field of ["dependencies", "devDependencies"] as const) {
    const bag = json[field];
    if (!isObject(bag)) continue;
    for (const [name, version] of Object.entries(bag)) {
      if (typeof version !== "string") continue;
      out.push({
        ecosystem: NPM_ECO,
        name,
        version,
        lockfileSource: relPath,
      });
    }
  }
  return out;
}

async function readManifestAndLock(
  absPath: string,
  relPath: string,
  onWarn: (m: string) => void,
  lockLabel: string,
): Promise<{ manifestContents?: string; lockContents?: string }> {
  const lockDir = path.dirname(absPath);
  const manifestPath = path.join(lockDir, "package.json");
  let manifestContents: string;
  try {
    manifestContents = await fs.readFile(manifestPath, "utf8");
  } catch (err) {
    onWarn(
      `npm: ${lockLabel} at ${relPath} lacks sibling package.json (${err instanceof Error ? err.message : String(err)})`,
    );
    return {};
  }
  let lockContents: string;
  try {
    lockContents = await fs.readFile(absPath, "utf8");
  } catch (err) {
    onWarn(`npm: cannot read ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
  return { manifestContents, lockContents };
}

function collectFromGraph(
  graph: DepGraphLike,
  lockfileSource: string,
  licenses: ReadonlyMap<string, string> = new Map(),
): readonly ParsedDependency[] {
  const out: ParsedDependency[] = [];
  const seen = new Set<string>();
  const rootName = lockfileSource;
  for (const pkg of graph.getPkgs()) {
    const name = pkg.name;
    const version = pkg.version ?? "";
    if (!name || !version) continue;
    // `getPkgs` includes the root package keyed by the manifest's
    // declared name — drop it so the manifest itself doesn't appear as
    // its own dependency. We detect it by "no version" OR root-name
    // string; the former already short-circuits above, the latter is a
    // belt-and-suspenders extra check.
    if (name === rootName) continue;
    const key = `${name}@${version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const license = licenses.get(key);
    out.push({
      ecosystem: NPM_ECO,
      name,
      version,
      lockfileSource,
      ...(license !== undefined ? { license } : {}),
    });
  }
  return out;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
