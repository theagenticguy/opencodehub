/**
 * Manifest detection — linguist-style priority cascade.
 *
 * A manifest is a file at (or near) the repo root that declares the project's
 * dependencies and toolchain for a specific ecosystem. When two manifests
 * coexist for the same ecosystem (e.g. Python's `pyproject.toml` +
 * `requirements.txt`), we keep the stronger one — the modern build file —
 * rather than union.
 *
 * This module ONLY reads manifest files; lockfiles (`package-lock.json`,
 * `Gemfile.lock`, etc.) are intentionally excluded — those are parsed by the
 * dependency extractor pipeline stage (W2-I5), not here.
 *
 * Determinism: the returned list is lowercased by relPath and sorted
 * alphabetically so two runs on the same repo emit the same sequence.
 */

import type { ScannedFile } from "../phases/scan.js";

/**
 * Ecosystem → ordered list of manifest filenames to look for at the repo
 * root. The first match wins per ecosystem (priority cascade).
 *
 * The priority encodes "modern first": `pyproject.toml` beats
 * `requirements.txt`, `package.json` beats `bower.json`.
 */
const MANIFEST_PRIORITY: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["npm", ["package.json"]],
  ["python", ["pyproject.toml", "requirements.txt", "setup.py"]],
  ["go", ["go.mod"]],
  ["rust", ["Cargo.toml"]],
  ["java", ["pom.xml", "build.gradle.kts", "build.gradle"]],
  ["ruby", ["Gemfile"]],
  ["php", ["composer.json"]],
  ["dart", ["pubspec.yaml"]],
];

/** Detected .NET project files (globbed at repo root, not in a cascade). */
const DOTNET_MANIFEST_EXTS: ReadonlySet<string> = new Set([".csproj", ".fsproj", ".sln"]);

/**
 * Return the list of manifest filenames (relative paths) discovered in the
 * scan, honoring the priority cascade per ecosystem. `.NET` contributes
 * every `.csproj`/`.fsproj`/`.sln` file at the repo root (C# projects may
 * legitimately have multiple).
 */
export function detectManifests(files: readonly ScannedFile[]): readonly string[] {
  const rootFiles = new Set<string>();
  const dotnetFiles: string[] = [];

  for (const f of files) {
    // Root-only detection keeps us from treating every
    // `examples/my-app/package.json` as a repo-level manifest. We accept the
    // file iff its relPath has no `/` — it lives directly at the repo root.
    if (!f.relPath.includes("/")) {
      rootFiles.add(f.relPath);
      const lowered = f.relPath.toLowerCase();
      for (const ext of DOTNET_MANIFEST_EXTS) {
        if (lowered.endsWith(ext)) {
          dotnetFiles.push(f.relPath);
          break;
        }
      }
    }
  }

  const out = new Set<string>();
  for (const [, candidates] of MANIFEST_PRIORITY) {
    for (const name of candidates) {
      if (rootFiles.has(name)) {
        out.add(name);
        break; // linguist cascade — stop at first modern hit per ecosystem
      }
    }
  }
  for (const name of dotnetFiles) out.add(name);

  return [...out].sort();
}
