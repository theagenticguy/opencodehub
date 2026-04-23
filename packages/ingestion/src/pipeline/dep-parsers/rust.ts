/**
 * Rust ecosystem manifest parser.
 *
 * Supported inputs:
 *   - `Cargo.lock` — TOML document with a `[[package]]` array. Each entry
 *     carries `name`, `version`, and optional `source` + `checksum`. We
 *     emit one `ParsedDependency` per `[[package]]` entry, preserving the
 *     full `(name, version)` tuple so multi-version fan-out (e.g. two
 *     different majors of `syn`) yields two distinct Dependency nodes.
 *   - `Cargo.toml` — direct `[dependencies]` / `[dev-dependencies]` /
 *     `[build-dependencies]` tables. Falls back to this when there is no
 *     sibling `Cargo.lock`.
 *
 * Versions captured verbatim; we never normalize semver ranges.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import toml from "@iarna/toml";
import type { ParseDepsFn, ParsedDependency } from "./types.js";

const CARGO_ECO = "cargo" as const;

export const parseRustDeps: ParseDepsFn = async (input) => {
  const basename = path.basename(input.relPath);
  try {
    if (basename === "Cargo.lock") {
      return await parseCargoLock(input.absPath, input.relPath, input.onWarn);
    }
    if (basename === "Cargo.toml") {
      return await parseCargoToml(input.absPath, input.relPath, input.onWarn);
    }
  } catch (err) {
    input.onWarn(
      `rust: failed to parse ${input.relPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
  return [];
};

async function parseCargoLock(
  absPath: string,
  relPath: string,
  onWarn: (m: string) => void,
): Promise<readonly ParsedDependency[]> {
  const raw = await safeRead(absPath, relPath, onWarn);
  if (raw === undefined) return [];
  let parsed: unknown;
  try {
    parsed = toml.parse(raw);
  } catch (err) {
    onWarn(
      `rust: ${relPath} is not valid TOML: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
  if (!isObject(parsed)) return [];

  const out: ParsedDependency[] = [];
  const pkgs = parsed["package"];
  if (Array.isArray(pkgs)) {
    for (const pkg of pkgs) {
      if (!isObject(pkg)) continue;
      const name = pkg["name"];
      const version = pkg["version"];
      if (typeof name !== "string" || typeof version !== "string") continue;
      out.push({
        ecosystem: CARGO_ECO,
        name,
        version,
        lockfileSource: relPath,
      });
    }
  }
  return out;
}

async function parseCargoToml(
  absPath: string,
  relPath: string,
  onWarn: (m: string) => void,
): Promise<readonly ParsedDependency[]> {
  const raw = await safeRead(absPath, relPath, onWarn);
  if (raw === undefined) return [];
  let parsed: unknown;
  try {
    parsed = toml.parse(raw);
  } catch (err) {
    onWarn(
      `rust: ${relPath} is not valid TOML: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
  if (!isObject(parsed)) return [];

  const out: ParsedDependency[] = [];
  for (const table of ["dependencies", "dev-dependencies", "build-dependencies"] as const) {
    const bag = parsed[table];
    if (!isObject(bag)) continue;
    for (const [name, spec] of Object.entries(bag)) {
      const version = normalizeCargoSpec(spec);
      out.push({
        ecosystem: CARGO_ECO,
        name,
        version,
        lockfileSource: relPath,
      });
    }
  }
  return out;
}

function normalizeCargoSpec(spec: unknown): string {
  if (typeof spec === "string") return spec;
  if (isObject(spec)) {
    const v = spec["version"];
    if (typeof v === "string") return v;
    const g = spec["git"];
    if (typeof g === "string") return `git:${g}`;
    const p = spec["path"];
    if (typeof p === "string") return `path:${p}`;
  }
  return "UNKNOWN";
}

async function safeRead(
  absPath: string,
  relPath: string,
  onWarn: (m: string) => void,
): Promise<string | undefined> {
  try {
    return await fs.readFile(absPath, "utf8");
  } catch (err) {
    onWarn(`rust: cannot read ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
