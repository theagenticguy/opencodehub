/**
 * Go ecosystem manifest parser.
 *
 * Supported inputs:
 *   - `go.sum` — one module per line, format
 *       `<module> <version>[/go.mod] <h1:hash>`
 *     We consume only the 2-column (module, version) projection and skip
 *     the `/go.mod` discriminator so each module is emitted once.
 *   - `go.mod` — uses the text format specified at https://go.dev/ref/mod.
 *     We parse the `require` block (single- or multi-line form), capture
 *     `<module> <version>` pairs, and skip `replace` / `exclude` directives.
 *
 * The version is the raw Go module pseudo-version string (e.g.
 * `v1.2.3`, or `v0.0.0-20231201123456-abcdef012345`) exactly as it appears
 * in the source file.
 *
 * License detection: neither go.mod nor go.sum carries license metadata.
 * The canonical source is `pkg.go.dev` + the module's `LICENSE` file,
 * both of which live behind a network boundary this phase forbids.
 * Per-dep `license` therefore stays undefined and the dependencies
 * phase maps that to the `"UNKNOWN"` sentinel.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { ParseDepsFn, ParsedDependency } from "./types.js";

const GO_ECO = "go" as const;

export const parseGoDeps: ParseDepsFn = async (input) => {
  const basename = path.basename(input.relPath);
  try {
    if (basename === "go.sum") {
      return await parseGoSum(input.absPath, input.relPath, input.onWarn);
    }
    if (basename === "go.mod") {
      return await parseGoMod(input.absPath, input.relPath, input.onWarn);
    }
  } catch (err) {
    input.onWarn(
      `go: failed to parse ${input.relPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
  return [];
};

async function parseGoSum(
  absPath: string,
  relPath: string,
  onWarn: (m: string) => void,
): Promise<readonly ParsedDependency[]> {
  const raw = await safeRead(absPath, relPath, onWarn);
  if (raw === undefined) return [];

  const out: ParsedDependency[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // "<module> <version>[/go.mod] <h1:hash>" — we only need the first two.
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;
    const modulePart = parts[0];
    const rawVersion = parts[1];
    if (!modulePart || !rawVersion) continue;
    // Strip the `/go.mod` suffix that appears on the second occurrence of
    // every module so we don't emit it twice.
    const version = rawVersion.endsWith("/go.mod")
      ? rawVersion.slice(0, -"/go.mod".length)
      : rawVersion;
    out.push({
      ecosystem: GO_ECO,
      name: modulePart,
      version,
      lockfileSource: relPath,
    });
  }
  return out;
}

async function parseGoMod(
  absPath: string,
  relPath: string,
  onWarn: (m: string) => void,
): Promise<readonly ParsedDependency[]> {
  const raw = await safeRead(absPath, relPath, onWarn);
  if (raw === undefined) return [];

  const out: ParsedDependency[] = [];
  const lines = raw.split(/\r?\n/);
  let inRequireBlock = false;

  for (const rawLine of lines) {
    // Strip line comments ("// ...") but tolerate `//` inside module paths
    // (which is disallowed by the spec but we guard anyway).
    const commentIdx = rawLine.indexOf("//");
    const line = (commentIdx === -1 ? rawLine : rawLine.slice(0, commentIdx)).trim();
    if (line.length === 0) continue;

    if (inRequireBlock) {
      if (line === ")") {
        inRequireBlock = false;
        continue;
      }
      const dep = parseRequireLine(line);
      if (dep) {
        out.push({
          ecosystem: GO_ECO,
          name: dep.name,
          version: dep.version,
          lockfileSource: relPath,
        });
      }
      continue;
    }

    if (line === "require (" || line.startsWith("require (")) {
      inRequireBlock = true;
      continue;
    }
    if (line.startsWith("require ")) {
      const dep = parseRequireLine(line.slice("require ".length).trim());
      if (dep) {
        out.push({
          ecosystem: GO_ECO,
          name: dep.name,
          version: dep.version,
          lockfileSource: relPath,
        });
      }
    }
    // `replace` and `exclude` are intentionally ignored — they are either
    // redirection directives or explicit removals and do not add modules.
  }

  return out;
}

function parseRequireLine(line: string): { name: string; version: string } | undefined {
  // Strip the `// indirect` marker if present.
  const clean = line.replace(/\/\/.*$/, "").trim();
  if (clean.length === 0) return undefined;
  const parts = clean.split(/\s+/);
  if (parts.length < 2) return undefined;
  const name = parts[0];
  const version = parts[1];
  if (!name || !version) return undefined;
  return { name, version };
}

async function safeRead(
  absPath: string,
  relPath: string,
  onWarn: (m: string) => void,
): Promise<string | undefined> {
  try {
    return await fs.readFile(absPath, "utf8");
  } catch (err) {
    onWarn(`go: cannot read ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}
