/**
 * Maven ecosystem manifest parser.
 *
 * Supported input:
 *   - `pom.xml` — XML manifest with a top-level `<dependencies>` element
 *     plus `<dependencyManagement><dependencies>` shape. Each dependency
 *     carries `<groupId>`, `<artifactId>`, `<version>`, and an optional
 *     `<scope>`.
 *
 * The v1.0 parser only walks direct dependencies; full transitive
 * resolution requires a Maven resolver runtime and is out of scope (see
 * research-scanners.yaml §dependency_parsers.maven.pom_xml.complexity).
 *
 * Scopes "test" and "provided" are dropped (per-spec requirement) because
 * they contribute no production dependency the graph should reason about.
 *
 * Version interpolation (e.g. `${spring.version}`) is NOT resolved.
 * The raw placeholder is written through verbatim so downstream tools
 * can still detect the dependency, and callers know the value is
 * unresolved.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import type { ParseDepsFn, ParsedDependency } from "./types.js";

const MAVEN_ECO = "maven" as const;
const EXCLUDED_SCOPES: ReadonlySet<string> = new Set(["test", "provided", "system"]);

interface MavenDependency {
  readonly groupId?: string;
  readonly artifactId?: string;
  readonly version?: string;
  readonly scope?: string;
}

export const parseMavenDeps: ParseDepsFn = async (input) => {
  const basename = path.basename(input.relPath);
  try {
    if (basename === "pom.xml") {
      return await parsePom(input.absPath, input.relPath, input.onWarn);
    }
  } catch (err) {
    input.onWarn(
      `maven: failed to parse ${input.relPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
  return [];
};

async function parsePom(
  absPath: string,
  relPath: string,
  onWarn: (m: string) => void,
): Promise<readonly ParsedDependency[]> {
  let raw: string;
  try {
    raw = await fs.readFile(absPath, "utf8");
  } catch (err) {
    onWarn(`maven: cannot read ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
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
      `maven: ${relPath} is not valid XML: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }

  if (!isObject(parsed)) return [];
  const project = parsed["project"];
  if (!isObject(project)) return [];

  const out: ParsedDependency[] = [];

  // Direct dependencies.
  collectDependencies(project["dependencies"], out, relPath);
  // dependencyManagement -> dependencies (defaults for child poms).
  const mgmt = project["dependencyManagement"];
  if (isObject(mgmt)) {
    collectDependencies(mgmt["dependencies"], out, relPath);
  }

  return out;
}

function collectDependencies(bag: unknown, out: ParsedDependency[], lockfileSource: string): void {
  if (!isObject(bag)) return;
  const raw = bag["dependency"];
  const list: unknown[] = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  for (const item of list) {
    const dep = toMavenDependency(item);
    if (!dep) continue;
    if (dep.scope !== undefined && EXCLUDED_SCOPES.has(dep.scope)) continue;
    if (!dep.groupId || !dep.artifactId) continue;
    const version = dep.version ?? "UNKNOWN";
    out.push({
      ecosystem: MAVEN_ECO,
      name: `${dep.groupId}:${dep.artifactId}`,
      version,
      lockfileSource,
    });
  }
}

function toMavenDependency(item: unknown): MavenDependency | undefined {
  if (!isObject(item)) return undefined;
  const groupId = toText(item["groupId"]);
  const artifactId = toText(item["artifactId"]);
  const version = toText(item["version"]);
  const scope = toText(item["scope"]);
  return {
    ...(groupId !== undefined ? { groupId } : {}),
    ...(artifactId !== undefined ? { artifactId } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(scope !== undefined ? { scope } : {}),
  };
}

function toText(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
