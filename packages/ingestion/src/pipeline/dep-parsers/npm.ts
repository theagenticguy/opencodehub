/**
 * npm ecosystem manifest parser.
 *
 * Entry manifest path kinds we recognise:
 *   - `package-lock.json` — npm lockfile (v1, v2, v3)
 *   - `pnpm-lock.yaml` — pnpm lockfile (5.x, 6.x, 9.x)
 *   - `package.json` — fallback when no lockfile sits beside it
 *
 * We parse every lockfile shape natively rather than delegating to a
 * third-party resolver. What we need from a lockfile is exactly the flat
 * set of resolved `name@version` pairs (the `DependencyNode` graph keys on
 * that), and every modern lockfile already carries that set verbatim:
 *   - npm v2/v3 — the `packages` map keys each resolved install by its
 *     `node_modules/<name>` path with a concrete `version`.
 *   - npm v1 — the nested `dependencies` tree carries `version` per node.
 *   - pnpm 5/6/9 — the `packages:` (and v9 `snapshots:`) section keys each
 *     resolved package as `<name>@<version>` (or legacy `/<name>/<version>`).
 * Reading those directly drops a heavyweight transitive dependency tree
 * (snyk-nodejs-lockfile-parser pulled ~126 packages, including several
 * deprecated ones that surfaced as `npm install` warnings for CLI users)
 * and removes a runtime CJS graph that resisted bundling. License
 * harvesting already scanned the same raw lockfile, so the package list and
 * its licenses now come from one pass over one source of truth.
 *
 * For bare `package.json` (no lockfile), we parse top-level
 * `dependencies` + `devDependencies` directly — the version is the raw
 * semver specifier from the manifest (e.g. `^1.2.3`), which is the best
 * signal available without a resolver.
 *
 * Errors (malformed JSON/YAML) are captured and reported via `onWarn`; the
 * parser returns `[]` in that case.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { ParseDepsFn, ParsedDependency } from "./types.js";

const NPM_ECO = "npm" as const;

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
  // The sibling package.json is not needed to enumerate resolved packages
  // (the lockfile is self-contained), but we still require it to exist so a
  // stray lockfile with no project doesn't get parsed in isolation — this
  // mirrors the prior behaviour where the parser demanded a manifest.
  const { lockContents } = await readManifestAndLock(absPath, relPath, onWarn, "package-lock.json");
  if (lockContents === undefined) return [];

  let json: unknown;
  try {
    json = JSON.parse(lockContents);
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

  const licenses = harvestLicensesFromLockJson(lockContents);
  const pairs = collectNpmLockPairs(json);
  return pairsToDeps(pairs, relPath, licenses);
}

async function parsePnpmLock(
  absPath: string,
  relPath: string,
  onWarn: (m: string) => void,
): Promise<readonly ParsedDependency[]> {
  const { lockContents } = await readManifestAndLock(absPath, relPath, onWarn, "pnpm-lock.yaml");
  if (lockContents === undefined) return [];

  // pnpm v9+ lockfiles inline `resolution.integrity` + optionally
  // per-snapshot licenses — harvest what's present, best-effort.
  const licenses = harvestLicensesFromPnpmLockYaml(lockContents);
  const pairs = collectPnpmLockPairs(lockContents);
  if (pairs.size === 0) {
    // A well-formed pnpm lock always lists at least one package once any
    // dependency is installed; an empty set means either a deps-free project
    // or a shape we failed to recognise. Either way `[]` is the safe result,
    // but warn so a genuinely unparseable lock is visible.
    onWarn(`npm: ${relPath} yielded no resolved packages (empty or unrecognised pnpm-lock shape)`);
  }
  return pairsToDeps(pairs, relPath, licenses);
}

/**
 * Resolved `name@version` pairs from a parsed `package-lock.json`.
 *
 * v2/v3: the `packages` map keys each install by its `node_modules/<name>`
 * path (the root project is the `""` key, which we skip). v1: the nested
 * `dependencies` tree carries a `version` on every node. Modern npm writes
 * both `packages` and a legacy `dependencies` mirror, so preferring
 * `packages` when present avoids double-counting; we fall back to
 * `dependencies` only for true v1 locks.
 */
function collectNpmLockPairs(json: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const pkgs = json["packages"];
  if (isObject(pkgs)) {
    for (const [lockPath, entry] of Object.entries(pkgs)) {
      if (lockPath === "") continue; // root project, not a dependency
      if (!isObject(entry)) continue;
      const version = typeof entry["version"] === "string" ? entry["version"] : "";
      const name =
        typeof entry["name"] === "string" && entry["name"].length > 0
          ? entry["name"]
          : pathToPackageName(lockPath);
      if (name === undefined || version === "") continue;
      out.add(`${name}\x00${version}`);
    }
    if (out.size > 0) return out;
  }
  // Legacy v1 lockfile: walk the nested `dependencies` tree.
  const deps = json["dependencies"];
  if (isObject(deps)) collectV1LockPairs(deps, out);
  return out;
}

function collectV1LockPairs(deps: Record<string, unknown>, out: Set<string>): void {
  for (const [name, entry] of Object.entries(deps)) {
    if (!isObject(entry)) continue;
    const version = typeof entry["version"] === "string" ? entry["version"] : "";
    if (version !== "") out.add(`${name}\x00${version}`);
    const nested = entry["dependencies"];
    if (isObject(nested)) collectV1LockPairs(nested, out);
  }
}

/**
 * Resolved `name@version` pairs from raw `pnpm-lock.yaml` text.
 *
 * We scan the package keys instead of YAML-parsing the whole document — the
 * same string-scanning approach the license harvester already uses, which
 * keeps the (already-large) ingestion package free of a YAML dependency. The
 * key shapes across pnpm major versions:
 *   - v9:        `  '@scope/name@1.2.3':`  /  `  name@1.2.3:`   (under
 *                `packages:` and `snapshots:`)
 *   - v5/v6:     `  /@scope/name/1.2.3:`   /  `  /name/1.2.3:`  (leading
 *                slash, slash-separated version; may carry a `(peer)` suffix)
 * A version segment always starts with a digit, which disambiguates the
 * `@`/`/` that separates name from version from the `@` inside a scope.
 */
function collectPnpmLockPairs(lockContents: string): Set<string> {
  const out = new Set<string>();
  for (const rawLine of lockContents.split(/\r?\n/)) {
    // Only top-level map keys (two-space indent) under packages:/snapshots:.
    const m = /^ {2}['"]?(\/?[^'"\s]+?)['"]?:\s*(?:\{\s*\})?\s*$/.exec(rawLine);
    if (m === null) continue;
    const rawKey = m[1] ?? "";
    const pair = pnpmKeyToPair(rawKey);
    if (pair !== undefined) out.add(pair);
  }
  return out;
}

/**
 * Convert one pnpm package/snapshot key to a `name\x00version` pair, or
 * `undefined` if the line is not a package key. Handles both the modern
 * `name@version` and legacy `/name/version` shapes, scoped names, and the
 * `(peerHash)` / `_peer` suffixes pnpm appends to disambiguate peer installs.
 */
function pnpmKeyToPair(rawKey: string): string | undefined {
  let key = rawKey;
  if (key.startsWith("/")) {
    // Legacy v5/v6: `/name/1.2.3` or `/@scope/name/1.2.3`, optional `(peer)`.
    key = key.slice(1);
    const lastSlash = key.lastIndexOf("/");
    if (lastSlash <= 0) return undefined;
    const name = key.slice(0, lastSlash);
    const version = stripLegacyPeerSuffix(key.slice(lastSlash + 1));
    if (!startsWithDigit(version)) return undefined;
    return `${name}\x00${version}`;
  }
  // Modern v9: `name@1.2.3` or `@scope/name@1.2.3`, optional `(peerHash)`.
  // Strip the parenthetical peer suffix FIRST — it contains its own `@`
  // (e.g. `(react@18.2.0)`) that would otherwise win the version-`@` scan.
  // Only `(`-stripping here, never `_`: a modern package name can contain an
  // underscore, and the `_peer` form is legacy-only (handled above).
  const cleaned = stripParenSuffix(key);
  const at = lastVersionAt(cleaned);
  if (at <= 0) return undefined;
  const name = cleaned.slice(0, at);
  const version = cleaned.slice(at + 1);
  if (name.length === 0 || !startsWithDigit(version)) return undefined;
  return `${name}\x00${version}`;
}

/** Drop a trailing `(...)` peer-resolution suffix (pnpm v9 modern keys). */
function stripParenSuffix(s: string): string {
  const i = s.indexOf("(");
  return i >= 0 ? s.slice(0, i) : s;
}

/** Index of the `@` that separates name from version (its next char is a digit). */
function lastVersionAt(key: string): number {
  for (let i = key.length - 1; i > 0; i -= 1) {
    if (key.charCodeAt(i) === 64 /* @ */ && startsWithDigit(key.slice(i + 1))) return i;
  }
  return -1;
}

/**
 * Legacy v5/v6 pnpm appends `_react@18.0.0` (and sometimes a `(peer)` form)
 * to a slash-key version for peer-resolved installs. A version segment in the
 * legacy shape never contains a bare `_`, so cutting at the first `_` (or `(`)
 * is safe here — unlike the modern key path, where names may contain `_`.
 */
function stripLegacyPeerSuffix(version: string): string {
  const paren = version.indexOf("(");
  if (paren >= 0) return version.slice(0, paren);
  const underscore = version.indexOf("_");
  if (underscore >= 0) return version.slice(0, underscore);
  return version;
}

function startsWithDigit(s: string): boolean {
  if (s.length === 0) return false;
  const c = s.charCodeAt(0);
  return c >= 48 && c <= 57;
}

/**
 * Promote `name\x00version` pairs into `ParsedDependency` records, joining
 * the best-effort license map and de-duplicating on `name@version`.
 */
function pairsToDeps(
  pairs: ReadonlySet<string>,
  lockfileSource: string,
  licenses: ReadonlyMap<string, string>,
): readonly ParsedDependency[] {
  const out: ParsedDependency[] = [];
  for (const pair of pairs) {
    const sep = pair.indexOf("\x00");
    if (sep <= 0) continue;
    const name = pair.slice(0, sep);
    const version = pair.slice(sep + 1);
    if (!name || !version) continue;
    const license = licenses.get(`${name}@${version}`);
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

function collectLegacyLockLicenses(deps: Record<string, unknown>, out: Map<string, string>): void {
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

/**
 * Read the lockfile, requiring a sibling `package.json` to exist first. The
 * manifest contents themselves are no longer needed to enumerate resolved
 * packages (the lockfile is self-contained), but its presence still gates
 * parsing so a stray lockfile outside a real project isn't parsed alone —
 * preserving the prior parser's contract.
 */
async function readManifestAndLock(
  absPath: string,
  relPath: string,
  onWarn: (m: string) => void,
  lockLabel: string,
): Promise<{ lockContents?: string }> {
  const lockDir = path.dirname(absPath);
  const manifestPath = path.join(lockDir, "package.json");
  try {
    await fs.access(manifestPath);
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
  return { lockContents };
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
