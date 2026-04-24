/**
 * Python ecosystem manifest parser.
 *
 * Supported inputs:
 *   - `pyproject.toml` — PEP 621 `[project.dependencies]` + PEP 508
 *     requirement specifiers, plus the legacy `[tool.poetry.dependencies]`
 *     table for older Poetry projects.
 *   - `requirements.txt` — one requirement per line; tolerates `-e`
 *     (editable installs), `--hash=` lines, `#` comments, blank lines,
 *     and the `-r` / `-c` include directives (which we skip).
 *   - `uv.lock` — TOML with a top-level `package = [[...]]` array; each
 *     entry has `name` and `version`.
 *
 * Versions are captured verbatim from the source; v1.0 makes no attempt
 * to resolve `>=1.0` style ranges into concrete versions (that would
 * require a PyPI lookup which this phase forbids). Callers consuming
 * Dependency nodes for SBOM emission can treat "UNKNOWN" as unresolved.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import toml from "@iarna/toml";
import type { ParseDepsFn, ParsedDependency } from "./types.js";

const PYPI_ECO = "pypi" as const;

export const parsePythonDeps: ParseDepsFn = async (input) => {
  const basename = path.basename(input.relPath);
  try {
    if (basename === "pyproject.toml") {
      return await parsePyproject(input.absPath, input.relPath, input.onWarn);
    }
    if (basename === "requirements.txt" || /^requirements-.*\.txt$/.test(basename)) {
      return await parseRequirements(input.absPath, input.relPath, input.onWarn);
    }
    if (basename === "uv.lock") {
      return await parseUvLock(input.absPath, input.relPath, input.onWarn);
    }
  } catch (err) {
    input.onWarn(
      `python: failed to parse ${input.relPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
  return [];
};

async function parsePyproject(
  absPath: string,
  relPath: string,
  onWarn: (m: string) => void,
): Promise<readonly ParsedDependency[]> {
  const raw = await safeRead(absPath, relPath, onWarn, "python");
  if (raw === undefined) return [];
  let parsed: unknown;
  try {
    parsed = toml.parse(raw);
  } catch (err) {
    onWarn(
      `python: ${relPath} is not valid TOML: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
  if (!isObject(parsed)) return [];

  const out: ParsedDependency[] = [];

  // PEP 621 — [project].dependencies is an array of PEP 508 strings.
  const project = parsed["project"];
  if (isObject(project)) {
    const deps = project["dependencies"];
    if (Array.isArray(deps)) {
      for (const spec of deps) {
        if (typeof spec !== "string") continue;
        const parsedSpec = parsePep508(spec);
        if (!parsedSpec) continue;
        out.push({
          ecosystem: PYPI_ECO,
          name: parsedSpec.name,
          version: parsedSpec.version,
          lockfileSource: relPath,
        });
      }
    }
    // PEP 621 optional-dependencies is a table of arrays.
    const optional = project["optional-dependencies"];
    if (isObject(optional)) {
      for (const group of Object.values(optional)) {
        if (!Array.isArray(group)) continue;
        for (const spec of group) {
          if (typeof spec !== "string") continue;
          const parsedSpec = parsePep508(spec);
          if (!parsedSpec) continue;
          out.push({
            ecosystem: PYPI_ECO,
            name: parsedSpec.name,
            version: parsedSpec.version,
            lockfileSource: relPath,
          });
        }
      }
    }
  }

  // Legacy Poetry — [tool.poetry.dependencies] table of name => specifier/object.
  const tool = parsed["tool"];
  if (isObject(tool)) {
    const poetry = tool["poetry"];
    if (isObject(poetry)) {
      for (const field of ["dependencies", "dev-dependencies"] as const) {
        const bag = poetry[field];
        if (!isObject(bag)) continue;
        for (const [name, spec] of Object.entries(bag)) {
          if (name === "python") continue; // poetry convention: version of python itself
          const version = normalizePoetrySpec(spec);
          out.push({
            ecosystem: PYPI_ECO,
            name,
            version,
            lockfileSource: relPath,
          });
        }
      }
      // dependency-groups-style [tool.poetry.group.X.dependencies].
      const groups = poetry["group"];
      if (isObject(groups)) {
        for (const group of Object.values(groups)) {
          if (!isObject(group)) continue;
          const bag = group["dependencies"];
          if (!isObject(bag)) continue;
          for (const [name, spec] of Object.entries(bag)) {
            if (name === "python") continue;
            const version = normalizePoetrySpec(spec);
            out.push({
              ecosystem: PYPI_ECO,
              name,
              version,
              lockfileSource: relPath,
            });
          }
        }
      }
    }
  }

  return out;
}

async function parseRequirements(
  absPath: string,
  relPath: string,
  onWarn: (m: string) => void,
): Promise<readonly ParsedDependency[]> {
  const raw = await safeRead(absPath, relPath, onWarn, "python");
  if (raw === undefined) return [];

  const out: ParsedDependency[] = [];
  const lines = raw.split(/\r?\n/);
  for (const rawLine of lines) {
    // Full-line comment: drop it before touching anything else so that
    // URLs carrying `#egg=...` fragments survive to the URL handler.
    const trimmedLine = rawLine.trim();
    if (trimmedLine.length === 0 || trimmedLine.startsWith("#")) continue;
    // Strip inline comments only for non-URL lines. URL style specs use
    // `#` as a valid fragment indicator (`#egg=...`, `#subdirectory=`)
    // and must not be truncated.
    const stripped = looksLikeUrlSpec(trimmedLine)
      ? trimmedLine
      : stripInlineComment(trimmedLine).trim();
    if (stripped.length === 0) continue;
    // Skip include directives and flags we don't interpret.
    if (stripped.startsWith("-r") || stripped.startsWith("--requirement")) continue;
    if (stripped.startsWith("-c") || stripped.startsWith("--constraint")) continue;
    if (stripped.startsWith("--hash")) continue;
    if (stripped.startsWith("--index-url")) continue;
    if (stripped.startsWith("--extra-index-url")) continue;
    if (stripped.startsWith("--find-links") || stripped.startsWith("-f")) continue;
    if (stripped.startsWith("--no-index")) continue;
    if (stripped.startsWith("--trusted-host")) continue;

    // `-e` / `--editable` prefix: strip then parse whatever follows.
    let spec = stripped;
    if (spec.startsWith("-e ")) spec = spec.slice(3).trim();
    else if (spec.startsWith("--editable ")) spec = spec.slice("--editable ".length).trim();

    // Git/URL style refs — capture the egg fragment name if present.
    if (/^(git\+|https?:|file:|ssh:)/.test(spec)) {
      const egg = /[#&]egg=([A-Za-z0-9._-]+)/.exec(spec);
      if (egg?.[1]) {
        out.push({
          ecosystem: PYPI_ECO,
          name: egg[1],
          version: "UNKNOWN",
          lockfileSource: relPath,
        });
      }
      continue;
    }

    const parsed = parsePep508(spec);
    if (!parsed) continue;
    out.push({
      ecosystem: PYPI_ECO,
      name: parsed.name,
      version: parsed.version,
      lockfileSource: relPath,
    });
  }
  return out;
}

async function parseUvLock(
  absPath: string,
  relPath: string,
  onWarn: (m: string) => void,
): Promise<readonly ParsedDependency[]> {
  const raw = await safeRead(absPath, relPath, onWarn, "python");
  if (raw === undefined) return [];
  let parsed: unknown;
  try {
    parsed = toml.parse(raw);
  } catch (err) {
    onWarn(
      `python: ${relPath} is not valid TOML: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
  if (!isObject(parsed)) return [];

  const out: ParsedDependency[] = [];
  const packages = parsed["package"];
  if (Array.isArray(packages)) {
    for (const pkg of packages) {
      if (!isObject(pkg)) continue;
      const name = pkg["name"];
      const version = pkg["version"];
      if (typeof name !== "string" || typeof version !== "string") continue;
      out.push({
        ecosystem: PYPI_ECO,
        name,
        version,
        lockfileSource: relPath,
      });
    }
  }
  return out;
}

/**
 * Parse a PEP 508 requirement string into `{ name, version }`. The returned
 * `version` is the right-hand-side of the specifier (e.g. "1.2.3" from
 * "requests==1.2.3"; "UNKNOWN" when no specifier is present).
 */
function parsePep508(raw: string): { name: string; version: string } | undefined {
  let s = raw.trim();
  if (s.length === 0) return undefined;
  // Strip environment markers ("; python_version < '3.10'")
  const semi = s.indexOf(";");
  if (semi !== -1) s = s.slice(0, semi).trim();
  // Strip optional extras specifier "pkg[extra1,extra2]"
  s = s.replace(/\[[^\]]*\]/, "");

  // PEP 440 URL-style "name @ https://..."
  const atUrl = /^([A-Za-z0-9._-]+)\s*@\s*(\S+)/.exec(s);
  if (atUrl) {
    const name = atUrl[1];
    const version = atUrl[2];
    if (!name || !version) return undefined;
    return { name, version };
  }

  // Match `name<op><version>` allowing chained specifiers. We keep only
  // the first specifier's pinned value; for "requests>=2,<3" the version
  // becomes ">=2,<3" (stored verbatim) to preserve operator fidelity.
  const m = /^([A-Za-z0-9._-]+)\s*(.*)$/.exec(s);
  if (!m) return undefined;
  const name = m[1];
  const rest = (m[2] ?? "").trim();
  if (!name) return undefined;
  if (rest.length === 0) return { name, version: "UNKNOWN" };
  // Collapse internal whitespace so the stored version is stable.
  return { name, version: rest.replace(/\s+/g, "") };
}

function normalizePoetrySpec(spec: unknown): string {
  if (typeof spec === "string") return spec;
  if (isObject(spec)) {
    const v = spec["version"];
    if (typeof v === "string") return v;
    const g = spec["git"];
    if (typeof g === "string") return `git:${g}`;
    const p = spec["path"];
    if (typeof p === "string") return `path:${p}`;
    const u = spec["url"];
    if (typeof u === "string") return `url:${u}`;
  }
  return "UNKNOWN";
}

function stripInlineComment(line: string): string {
  const idx = line.indexOf("#");
  if (idx === -1) return line;
  return line.slice(0, idx);
}

function looksLikeUrlSpec(line: string): boolean {
  // `-e` / `--editable` preserve their URLs after the prefix; include
  // those variants when sniffing for URL-bearing lines.
  const stripped = line.replace(/^(?:-e|--editable)\s+/, "");
  return /^(?:git\+|https?:|file:|ssh:)/.test(stripped);
}

async function safeRead(
  absPath: string,
  relPath: string,
  onWarn: (m: string) => void,
  tag: string,
): Promise<string | undefined> {
  try {
    return await fs.readFile(absPath, "utf8");
  } catch (err) {
    onWarn(`${tag}: cannot read ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
