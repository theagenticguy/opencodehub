/**
 * Framework detection — evidence-based (presence of a known file OR a
 * declared dependency).
 *
 * Two evidence sources:
 *   1. **File markers** — a specific file proves the framework (e.g.
 *      `next.config.js`, `manage.py`, `config/routes.rb`).
 *   2. **Manifest dependency** — the framework's package name appears in
 *      the ecosystem's manifest (package.json, pyproject.toml,
 *      requirements.txt, go.mod, pom.xml, Cargo.toml, Gemfile,
 *      composer.json, or a .csproj).
 *
 * This module explicitly avoids reading lockfiles (Gemfile.lock,
 * package-lock.json, poetry.lock…). Dependency parsing of lockfiles is the
 * job of the dependency extractor; here we only use manifest-level
 * declarations.
 *
 * Determinism: frameworks returned alphabetically.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { ScannedFile } from "../phases/scan.js";

export interface FrameworkDetectionInput {
  readonly repoRoot: string;
  readonly files: readonly ScannedFile[];
  readonly manifests: readonly string[];
}

interface FrameworkRule {
  readonly name: string;
  /** Files (relative paths, exact match) whose presence proves the framework. */
  readonly fileMarkers?: readonly string[];
  /** Regex patterns matched against file names for shell-style "Dockerfile.*". */
  readonly fileRegexMarkers?: readonly RegExp[];
  /**
   * Per-manifest dependency matchers. The matcher receives the raw manifest
   * text; it returns true if the dependency is declared.
   */
  readonly manifestMarkers?: ReadonlyArray<{
    readonly manifest: string;
    readonly matcher: (text: string) => boolean;
  }>;
}

// Cache reads — some manifests (package.json, pyproject.toml) are consulted
// by several detectors, and the detector phase should be idempotent / cheap.
type ManifestCache = Map<string, string | null>;

async function readManifestOnce(
  repoRoot: string,
  name: string,
  cache: ManifestCache,
): Promise<string | null> {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  try {
    const txt = await fs.readFile(path.join(repoRoot, name), "utf8");
    cache.set(name, txt);
    return txt;
  } catch {
    cache.set(name, null);
    return null;
  }
}

function hasPackageJsonDep(text: string, depName: string): boolean {
  // A parsed walk beats a stringy substring search: dep names can appear in
  // descriptions, scripts, etc. We parse JSON and look up every conventional
  // dep bucket.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const rec = parsed as Record<string, unknown>;
  for (const bucket of ["dependencies", "devDependencies", "peerDependencies"]) {
    const map = rec[bucket];
    if (typeof map === "object" && map !== null && !Array.isArray(map)) {
      if (Object.hasOwn(map as Record<string, unknown>, depName)) return true;
    }
  }
  return false;
}

function hasPyDepInText(text: string, normalizedName: string): boolean {
  // Match a dep name in either pyproject TOML (dependencies = [...]) or a
  // requirements.txt line. We lowercase both sides and allow the Python PEP
  // 503 alias rule: `_` and `.` behave like `-`.
  const want = normalizedName.toLowerCase().replace(/[_.]/g, "-");
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    // Strip quotes/brackets/commas so a TOML list entry like `"fastapi>=0.1",`
    // becomes `  fastapi>=0.1 `. Then split on whitespace and version
    // operators, and take the first NON-EMPTY token (leading whitespace
    // would otherwise yield an empty first element).
    const stripped = line
      .replace(/['"[\],]/g, " ")
      .trim()
      .split(/[\s;<>=!~]+/)[0];
    if (stripped === undefined || stripped === "") continue;
    // Strip a PEP 508 extra `pkg[extra]` → `pkg`.
    const justName = stripped.replace(/\[.*$/, "");
    const normalized = justName.toLowerCase().replace(/[_.]/g, "-");
    if (normalized === want) return true;
  }
  return false;
}

function hasGoModDep(text: string, modulePath: string): boolean {
  // A go.mod dependency line looks like:
  //   require (
  //     github.com/gin-gonic/gin v1.9.1
  //   )
  // Or the single-form `require github.com/...`.
  const needle = modulePath.toLowerCase();
  const lowered = text.toLowerCase();
  return lowered.includes(needle);
}

function hasPomXmlDep(text: string, artifactId: string): boolean {
  // A loose but effective check: `<artifactId>foo</artifactId>` appears in
  // a pom somewhere. The false-positive risk is low because these strings
  // rarely show up in human prose.
  const re = new RegExp(`<artifactId>\\s*${escapeRegex(artifactId)}\\s*</artifactId>`, "i");
  return re.test(text);
}

function hasCsprojPackageRef(text: string, includeValue: string): boolean {
  // <PackageReference Include="Microsoft.AspNetCore" Version="..." />
  const re = new RegExp(
    `<PackageReference\\s+[^>]*Include="${escapeRegex(includeValue)}[^"]*"`,
    "i",
  );
  return re.test(text);
}

function hasCargoTomlDep(text: string, crateName: string): boolean {
  // Accept either `foo = "1.2"` or `[dependencies] foo = ...`. A simple
  // line-start anchor catches both since dependencies live in their own
  // sections.
  const re = new RegExp(`^\\s*${escapeRegex(crateName)}\\s*=`, "m");
  return re.test(text);
}

function hasGemfileDep(text: string, gemName: string): boolean {
  const re = new RegExp(`^\\s*gem\\s+['"]${escapeRegex(gemName)}['"]`, "m");
  return re.test(text);
}

function hasComposerDep(text: string, packageName: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const rec = parsed as Record<string, unknown>;
  for (const bucket of ["require", "require-dev"]) {
    const map = rec[bucket];
    if (typeof map === "object" && map !== null && !Array.isArray(map)) {
      if (Object.hasOwn(map as Record<string, unknown>, packageName)) return true;
    }
  }
  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Note: Spring Boot is identified by the `<parent>` element's artifactId in
// pom.xml. The generic `hasPomXmlDep` covers it because the artifact id
// appears inside that element.
const FRAMEWORK_RULES: readonly FrameworkRule[] = [
  {
    name: "nextjs",
    fileMarkers: ["next.config.js", "next.config.ts", "next.config.mjs", "next.config.cjs"],
    manifestMarkers: [{ manifest: "package.json", matcher: (t) => hasPackageJsonDep(t, "next") }],
  },
  {
    name: "express",
    manifestMarkers: [
      { manifest: "package.json", matcher: (t) => hasPackageJsonDep(t, "express") },
    ],
  },
  {
    name: "nestjs",
    manifestMarkers: [
      { manifest: "package.json", matcher: (t) => hasPackageJsonDep(t, "@nestjs/core") },
    ],
  },
  {
    name: "django",
    fileMarkers: ["manage.py"],
    manifestMarkers: [
      { manifest: "pyproject.toml", matcher: (t) => hasPyDepInText(t, "django") },
      { manifest: "requirements.txt", matcher: (t) => hasPyDepInText(t, "django") },
    ],
  },
  {
    name: "flask",
    manifestMarkers: [
      { manifest: "pyproject.toml", matcher: (t) => hasPyDepInText(t, "flask") },
      { manifest: "requirements.txt", matcher: (t) => hasPyDepInText(t, "flask") },
    ],
  },
  {
    name: "fastapi",
    manifestMarkers: [
      { manifest: "pyproject.toml", matcher: (t) => hasPyDepInText(t, "fastapi") },
      { manifest: "requirements.txt", matcher: (t) => hasPyDepInText(t, "fastapi") },
    ],
  },
  {
    name: "gin",
    manifestMarkers: [
      { manifest: "go.mod", matcher: (t) => hasGoModDep(t, "github.com/gin-gonic/gin") },
    ],
  },
  {
    name: "spring-boot",
    manifestMarkers: [
      { manifest: "pom.xml", matcher: (t) => hasPomXmlDep(t, "spring-boot-starter-parent") },
    ],
  },
  {
    name: "aspnet",
    // .csproj detection is done separately across every .csproj file.
  },
  {
    name: "axum",
    manifestMarkers: [{ manifest: "Cargo.toml", matcher: (t) => hasCargoTomlDep(t, "axum") }],
  },
  {
    name: "actix",
    manifestMarkers: [{ manifest: "Cargo.toml", matcher: (t) => hasCargoTomlDep(t, "actix-web") }],
  },
  {
    name: "rails",
    fileMarkers: ["config/routes.rb"],
    manifestMarkers: [{ manifest: "Gemfile", matcher: (t) => hasGemfileDep(t, "rails") }],
  },
  {
    name: "laravel",
    manifestMarkers: [
      { manifest: "composer.json", matcher: (t) => hasComposerDep(t, "laravel/framework") },
    ],
  },
];

export async function detectFrameworks(input: FrameworkDetectionInput): Promise<readonly string[]> {
  const { repoRoot, files, manifests } = input;
  const relPaths = new Set(files.map((f) => f.relPath));
  const manifestSet = new Set(manifests);
  const cache: ManifestCache = new Map();
  const out = new Set<string>();

  for (const rule of FRAMEWORK_RULES) {
    if (rule.fileMarkers) {
      for (const marker of rule.fileMarkers) {
        if (relPaths.has(marker)) {
          out.add(rule.name);
          break;
        }
      }
    }
    if (rule.fileRegexMarkers) {
      for (const rx of rule.fileRegexMarkers) {
        for (const rp of relPaths) {
          if (rx.test(rp)) {
            out.add(rule.name);
            break;
          }
        }
        if (out.has(rule.name)) break;
      }
    }
    if (rule.manifestMarkers) {
      for (const m of rule.manifestMarkers) {
        if (!manifestSet.has(m.manifest)) continue;
        const txt = await readManifestOnce(repoRoot, m.manifest, cache);
        if (txt === null) continue;
        if (m.matcher(txt)) {
          out.add(rule.name);
          break;
        }
      }
    }
  }

  // ASP.NET — walk every .csproj in the scan and check for the
  // Microsoft.AspNetCore PackageReference.
  for (const f of files) {
    if (!f.relPath.toLowerCase().endsWith(".csproj")) continue;
    try {
      const txt = await fs.readFile(path.join(repoRoot, f.relPath), "utf8");
      if (hasCsprojPackageRef(txt, "Microsoft.AspNetCore")) {
        out.add("aspnet");
        break;
      }
    } catch {
      // Unreadable .csproj — skip silently.
    }
  }

  return [...out].sort();
}
