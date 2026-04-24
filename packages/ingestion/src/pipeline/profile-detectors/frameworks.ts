/**
 * Framework detection — backward-compatible wrapper around the structured
 * catalog dispatcher.
 *
 * This module is the v1.0 entrypoint that emits a flat `string[]` of
 * framework names. The v2.0 structured output (with variant / version /
 * confidence / parent relationships) lives on `FrameworkDetection` and is
 * emitted by `framework-detector.ts`. The profile phase calls both:
 * `detectFrameworksStructured` populates `ProjectProfileNode.frameworksDetected`
 * and this wrapper populates the legacy `ProjectProfileNode.frameworks`
 * alongside for backward compatibility.
 *
 * Determinism: the returned list is sorted alphabetically, identical to
 * the legacy behavior.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { ScannedFile } from "../phases/scan.js";
import { detectFrameworksStructured } from "./framework-detector.js";

export interface FrameworkDetectionInput {
  readonly repoRoot: string;
  readonly files: readonly ScannedFile[];
  readonly manifests: readonly string[];
  /**
   * Optional — languages detected for this repo. When supplied the
   * catalog dispatcher skips ecosystems whose language is absent, which
   * meaningfully shrinks work on mono-language repos. Defaults to "run
   * every ecosystem" when omitted (keeps the legacy contract).
   */
  readonly detectedLanguages?: readonly string[];
}

/**
 * List of manifest filenames the catalog wants to read at repo root (or
 * one level deep). Kept in sync with `frameworks-catalog.ts`.
 */
const MANIFEST_FILES: readonly string[] = [
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
  "Program.cs",
  "config/application.rb",
  "config/routes.rb",
  "src-tauri/tauri.conf.json",
  "src-tauri/tauri.conf.json5",
  "src-tauri/Tauri.toml",
];

/**
 * Pre-read every manifest we care about. Returns a map from relPath to
 * raw text. Unreadable / missing files are simply absent from the map.
 */
async function preReadManifests(
  repoRoot: string,
  relPaths: ReadonlySet<string>,
): Promise<ReadonlyMap<string, string>> {
  const out = new Map<string, string>();
  for (const name of MANIFEST_FILES) {
    if (!relPaths.has(name)) continue;
    try {
      const text = await fs.readFile(path.join(repoRoot, name), "utf8");
      out.set(name, text);
    } catch {
      // FRM-UN-002: malformed / unreadable → skip, never abort.
    }
  }
  return out;
}

/**
 * Legacy entrypoint — returns a sorted flat list of framework names.
 * Delegates to `detectFrameworksStructured` for the actual detection.
 */
export async function detectFrameworks(input: FrameworkDetectionInput): Promise<readonly string[]> {
  const relPaths = new Set(input.files.map((f) => f.relPath));
  const manifestText = await preReadManifests(input.repoRoot, relPaths);
  const detections = detectFrameworksStructured({
    relPaths,
    manifestText,
    detectedLanguages: input.detectedLanguages ?? [
      // Fallback: treat all ecosystems as active when the caller did not
      // profile-gate. Keeps the legacy "run every rule" contract.
      "javascript",
      "typescript",
      "python",
      "ruby",
      "go",
      "rust",
      "java",
      "kotlin",
      "php",
      "csharp",
    ],
  });
  return detections.map((d) => d.name);
}

/**
 * Structured entrypoint — returns the full `FrameworkDetection[]` the
 * profile phase persists on `ProjectProfileNode.frameworksDetected`.
 * Readers that want the flat-string view should call `detectFrameworks`
 * above.
 */
export async function detectFrameworksDetailed(
  input: FrameworkDetectionInput,
): Promise<ReturnType<typeof detectFrameworksStructured>> {
  const relPaths = new Set(input.files.map((f) => f.relPath));
  const manifestText = await preReadManifests(input.repoRoot, relPaths);
  return detectFrameworksStructured({
    relPaths,
    manifestText,
    detectedLanguages: input.detectedLanguages ?? [
      "javascript",
      "typescript",
      "python",
      "ruby",
      "go",
      "rust",
      "java",
      "kotlin",
      "php",
      "csharp",
    ],
  });
}
