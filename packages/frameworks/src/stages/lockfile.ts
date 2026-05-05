/**
 * Stage 2 — lockfile resolver.
 *
 * Parses 6 lockfile formats and emits a `{file, dep, version}` index the
 * detector consumes to resolve exact versions. Feeds into the existing
 * `versionKey` path on `FrameworkDetection` (when a manifest only declares a
 * semver range, the lockfile supplies the resolved version).
 *
 * Formats handled:
 *   - `package-lock.json`    npm v7+ (lockfileVersion 2 or 3)
 *   - `pnpm-lock.yaml`       pnpm v6+ (YAML)
 *   - `yarn.lock`            yarn classic (line-based) — opportunistic
 *   - `Gemfile.lock`         bundler (line-based)
 *   - `poetry.lock`          Python poetry (TOML, `[[package]]` tables)
 *   - `uv.lock`              Python uv (TOML, `[[package]]` tables)
 *   - `Cargo.lock`           Rust cargo (TOML, `[[package]]` tables)
 *
 * Pure and deterministic — no I/O (caller reads the file text and passes
 * it in), no network, no subprocess.
 */

import toml from "@iarna/toml";
import { parse as parseYaml } from "yaml";

/** Lockfile filename the parser knows how to handle. */
export type LockfileFile =
  | "package-lock.json"
  | "pnpm-lock.yaml"
  | "yarn.lock"
  | "Gemfile.lock"
  | "poetry.lock"
  | "uv.lock"
  | "Cargo.lock";

/** The subset of lockfile filenames the parser supports. Export for callers that want to pre-filter. */
export const KNOWN_LOCKFILES: readonly LockfileFile[] = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Gemfile.lock",
  "poetry.lock",
  "uv.lock",
  "Cargo.lock",
];

/**
 * A lockfile resolution — one entry per unique dep+version pair seen across
 * all parsed lockfiles. Callers look up by `dep` to resolve versions a
 * manifest only declares as a semver range.
 */
export interface LockfileResolution {
  /** Source filename that produced this resolution. */
  readonly file: LockfileFile;
  /** Dependency name as declared in the manifest (e.g. `react`, `fastapi`, `rails`). */
  readonly dep: string;
  /** Resolved exact version string (`18.3.1`, `0.110.0`, etc.). */
  readonly version: string;
}

/**
 * Parse a lockfile by filename. Malformed content returns an empty array
 * (FRM-UN-002 log-and-continue policy). Unknown filenames also return `[]`.
 */
export function parseLockfile(file: string, text: string): readonly LockfileResolution[] {
  switch (file) {
    case "package-lock.json":
      return parsePackageLock(text);
    case "pnpm-lock.yaml":
      return parsePnpmLock(text);
    case "yarn.lock":
      return parseYarnLock(text);
    case "Gemfile.lock":
      return parseGemfileLock(text);
    case "poetry.lock":
      return parseTomlPackages(text, "poetry.lock");
    case "uv.lock":
      return parseTomlPackages(text, "uv.lock");
    case "Cargo.lock":
      return parseTomlPackages(text, "Cargo.lock");
    default:
      return [];
  }
}

/**
 * Index a set of resolutions by dep name. Later entries win per dep — this
 * mirrors npm/pnpm hoisting where the top-level resolution is the one callers
 * of the tree observe.
 */
export function indexResolutions(
  resolutions: readonly LockfileResolution[],
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const r of resolutions) {
    out.set(r.dep, r.version);
  }
  return out;
}

// ---------------------------------------------------------------------------
// package-lock.json (npm v7+)
// ---------------------------------------------------------------------------

function parsePackageLock(text: string): readonly LockfileResolution[] {
  const out: LockfileResolution[] = [];
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return out;
  }
  if (typeof json !== "object" || json === null) return out;
  const rec = json as Record<string, unknown>;
  // lockfileVersion 2/3: resolutions under `packages` keyed by
  // relative install path (`""` = root, `"node_modules/react"`, etc.).
  const pkgs = rec["packages"];
  if (typeof pkgs === "object" && pkgs !== null) {
    for (const [key, value] of Object.entries(pkgs as Record<string, unknown>)) {
      if (key === "") continue;
      if (typeof value !== "object" || value === null) continue;
      const v = (value as Record<string, unknown>)["version"];
      const name = extractNpmName(key);
      if (name !== null && typeof v === "string") {
        out.push({ file: "package-lock.json", dep: name, version: v });
      }
    }
  }
  // lockfileVersion 1 fallback: resolutions under `dependencies`.
  const deps = rec["dependencies"];
  if (typeof deps === "object" && deps !== null) {
    for (const [name, value] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const v = (value as Record<string, unknown>)["version"];
      if (typeof v === "string") {
        out.push({ file: "package-lock.json", dep: name, version: v });
      }
    }
  }
  return out;
}

/** Strip the `node_modules/` prefix chain from a package-lock v2/v3 key. */
function extractNpmName(key: string): string | null {
  const idx = key.lastIndexOf("node_modules/");
  if (idx < 0) return null;
  const name = key.slice(idx + "node_modules/".length);
  return name.length > 0 ? name : null;
}

// ---------------------------------------------------------------------------
// pnpm-lock.yaml
// ---------------------------------------------------------------------------

function parsePnpmLock(text: string): readonly LockfileResolution[] {
  const out: LockfileResolution[] = [];
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return out;
  }
  if (typeof doc !== "object" || doc === null) return out;
  const rec = doc as Record<string, unknown>;
  // pnpm v9+: `importers.<path>.dependencies[name].version` OR
  // `packages[<id>]` keyed by `/name@version(meta)`. We walk `packages`
  // because it carries every pinned version regardless of importer.
  const packages = rec["packages"];
  if (typeof packages === "object" && packages !== null) {
    for (const key of Object.keys(packages as Record<string, unknown>)) {
      const parsed = parsePnpmPackageKey(key);
      if (parsed !== null) {
        out.push({ file: "pnpm-lock.yaml", dep: parsed.name, version: parsed.version });
      }
    }
  }
  // Fallback for v6+: top-level importers also carry resolutions.
  const importers = rec["importers"];
  if (typeof importers === "object" && importers !== null) {
    for (const importer of Object.values(importers as Record<string, unknown>)) {
      if (typeof importer !== "object" || importer === null) continue;
      for (const bucket of ["dependencies", "devDependencies"]) {
        const deps = (importer as Record<string, unknown>)[bucket];
        if (typeof deps === "object" && deps !== null) {
          for (const [name, info] of Object.entries(deps as Record<string, unknown>)) {
            if (typeof info !== "object" || info === null) continue;
            const v = (info as Record<string, unknown>)["version"];
            if (typeof v === "string") {
              out.push({ file: "pnpm-lock.yaml", dep: name, version: stripPnpmMeta(v) });
            }
          }
        }
      }
    }
  }
  return out;
}

/** Parse pnpm v9 `packages` key `/name@version(meta)` or `name@version`. */
function parsePnpmPackageKey(key: string): { name: string; version: string } | null {
  // Strip leading slash if present (v6/v7 style).
  const body = key.startsWith("/") ? key.slice(1) : key;
  // Strip trailing `(…)` meta blob.
  const paren = body.indexOf("(");
  const core = paren >= 0 ? body.slice(0, paren) : body;
  const at = core.lastIndexOf("@");
  if (at <= 0) return null;
  return { name: core.slice(0, at), version: core.slice(at + 1) };
}

/** Strip `(peer@1)` style metadata pnpm appends to resolved versions. */
function stripPnpmMeta(v: string): string {
  const paren = v.indexOf("(");
  return paren >= 0 ? v.slice(0, paren) : v;
}

// ---------------------------------------------------------------------------
// yarn.lock (yarn classic — v1)
// ---------------------------------------------------------------------------

function parseYarnLock(text: string): readonly LockfileResolution[] {
  // Yarn classic lockfile format:
  //   "react@^18.0.0":
  //     version "18.3.1"
  //     …
  const out: LockfileResolution[] = [];
  const entryRe = /^"?([^"\s@][^"\s]*)@[^"\n]*"?:\s*$/;
  const versionRe = /^\s+version\s+"([^"]+)"/;
  const lines = text.split("\n");
  let currentName: string | null = null;
  for (const line of lines) {
    const entryMatch = entryRe.exec(line);
    if (entryMatch !== null) {
      currentName = entryMatch[1] ?? null;
      continue;
    }
    const vm = versionRe.exec(line);
    if (vm !== null && currentName !== null) {
      out.push({ file: "yarn.lock", dep: currentName, version: vm[1] ?? "" });
      currentName = null;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gemfile.lock (bundler)
// ---------------------------------------------------------------------------

function parseGemfileLock(text: string): readonly LockfileResolution[] {
  // Gemfile.lock format under the GEM section:
  //   GEM
  //     remote: https://rubygems.org/
  //     specs:
  //       rails (7.1.3)
  //       actionview (= 7.1.3)
  //   PLATFORMS
  //     …
  // We match the 2-indent `name (version)` lines.
  const out: LockfileResolution[] = [];
  const re = /^ {4}([a-zA-Z0-9][\w-]*)\s+\(([^)]+)\)\s*$/;
  for (const line of text.split("\n")) {
    const m = re.exec(line);
    if (m !== null) {
      const name = m[1];
      const version = m[2];
      if (name !== undefined && version !== undefined) {
        out.push({ file: "Gemfile.lock", dep: name, version });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// poetry.lock / uv.lock / Cargo.lock (TOML `[[package]]` arrays)
// ---------------------------------------------------------------------------

function parseTomlPackages(
  text: string,
  file: "poetry.lock" | "uv.lock" | "Cargo.lock",
): readonly LockfileResolution[] {
  const out: LockfileResolution[] = [];
  let doc: unknown;
  try {
    doc = toml.parse(text);
  } catch {
    return out;
  }
  if (typeof doc !== "object" || doc === null) return out;
  const packages = (doc as Record<string, unknown>)["package"];
  if (!Array.isArray(packages)) return out;
  for (const p of packages) {
    if (typeof p !== "object" || p === null) continue;
    const rec = p as Record<string, unknown>;
    const name = rec["name"];
    const version = rec["version"];
    if (typeof name === "string" && typeof version === "string") {
      out.push({ file, dep: name, version });
    }
  }
  return out;
}
