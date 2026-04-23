/**
 * NuGet ecosystem manifest parser.
 *
 * Supported inputs:
 *   - `*.csproj` / `*.fsproj` / `*.vbproj` — MSBuild XML containing
 *     `<PackageReference Include="..." Version="..." />` entries inside
 *     `<ItemGroup>` blocks.
 *   - `packages.lock.json` — JSON emitted by
 *     `dotnet restore --use-lock-file`; direct + transitive deps keyed by
 *     framework.
 *
 * The direct-dependency version is captured verbatim from the manifest.
 * For packages.lock.json we emit every package regardless of whether it
 * was declared `Direct` or `Transitive` — the SBOM needs the full set.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import type { ParseDepsFn, ParsedDependency } from "./types.js";

const NUGET_ECO = "nuget" as const;
const MSBUILD_EXTS: ReadonlySet<string> = new Set([".csproj", ".fsproj", ".vbproj"]);

export const parseNugetDeps: ParseDepsFn = async (input) => {
  const basename = path.basename(input.relPath);
  const ext = path.extname(basename).toLowerCase();
  try {
    if (MSBUILD_EXTS.has(ext)) {
      return await parseMsbuildProject(input.absPath, input.relPath, input.onWarn);
    }
    if (basename === "packages.lock.json") {
      return await parsePackagesLock(input.absPath, input.relPath, input.onWarn);
    }
  } catch (err) {
    input.onWarn(
      `nuget: failed to parse ${input.relPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
  return [];
};

async function parseMsbuildProject(
  absPath: string,
  relPath: string,
  onWarn: (m: string) => void,
): Promise<readonly ParsedDependency[]> {
  let raw: string;
  try {
    raw = await fs.readFile(absPath, "utf8");
  } catch (err) {
    onWarn(`nuget: cannot read ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    allowBooleanAttributes: true,
    parseTagValue: true,
    trimValues: true,
  });
  let parsed: unknown;
  try {
    parsed = parser.parse(raw);
  } catch (err) {
    onWarn(
      `nuget: ${relPath} is not valid XML: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }

  if (!isObject(parsed)) return [];
  const project = parsed["Project"];
  if (!isObject(project)) return [];

  const out: ParsedDependency[] = [];

  const itemGroupRaw = project["ItemGroup"];
  const itemGroups: unknown[] = Array.isArray(itemGroupRaw)
    ? itemGroupRaw
    : itemGroupRaw === undefined
      ? []
      : [itemGroupRaw];
  for (const group of itemGroups) {
    if (!isObject(group)) continue;
    const refRaw = group["PackageReference"];
    const refs: unknown[] = Array.isArray(refRaw) ? refRaw : refRaw === undefined ? [] : [refRaw];
    for (const ref of refs) {
      const { name, version } = extractPackageRef(ref);
      if (!name) continue;
      out.push({
        ecosystem: NUGET_ECO,
        name,
        version: version ?? "UNKNOWN",
        lockfileSource: relPath,
      });
    }
  }
  return out;
}

async function parsePackagesLock(
  absPath: string,
  relPath: string,
  onWarn: (m: string) => void,
): Promise<readonly ParsedDependency[]> {
  let raw: string;
  try {
    raw = await fs.readFile(absPath, "utf8");
  } catch (err) {
    onWarn(`nuget: cannot read ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    onWarn(
      `nuget: ${relPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
  if (!isObject(json)) return [];
  const deps = json["dependencies"];
  if (!isObject(deps)) return [];

  const out: ParsedDependency[] = [];
  for (const framework of Object.values(deps)) {
    if (!isObject(framework)) continue;
    for (const [name, entry] of Object.entries(framework)) {
      if (!isObject(entry)) continue;
      const resolved = entry["resolved"];
      if (typeof resolved !== "string") continue;
      out.push({
        ecosystem: NUGET_ECO,
        name,
        version: resolved,
        lockfileSource: relPath,
      });
    }
  }
  return out;
}

function extractPackageRef(ref: unknown): { name?: string; version?: string } {
  if (!isObject(ref)) return {};
  const includeAttr = ref["@_Include"];
  const versionAttr = ref["@_Version"];
  // Version may also be supplied as a child element <Version>.
  const versionChild = ref["Version"];
  const name = typeof includeAttr === "string" ? includeAttr.trim() : undefined;
  let version: string | undefined;
  if (typeof versionAttr === "string") version = versionAttr.trim();
  else if (typeof versionAttr === "number") version = String(versionAttr);
  else if (typeof versionChild === "string") version = versionChild.trim();
  else if (typeof versionChild === "number") version = String(versionChild);
  return {
    ...(name !== undefined ? { name } : {}),
    ...(version !== undefined ? { version } : {}),
  };
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
