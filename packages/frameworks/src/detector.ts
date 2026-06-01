/**
 * Framework detection dispatcher.
 *
 * Walks the `FRAMEWORK_CATALOG` once, profile-gated on ecosystem, and
 * emits a sorted, deterministic list of `FrameworkDetection` objects.
 *
 * Pipeline (per catalog entry):
 *   1. Skip entry if its ecosystem gate is not met (no matching language
 *      detected).
 *   2. Evaluate `fileMarkers`, `fileRegexMarkers`, and `manifestKeys` —
 *      any hit counts as a "manifest-level" match.
 *   3. If a hit was recorded, resolve the version (when `versionKey`
 *      points at a parseable JSON path) and every variant axis.
 *   4. Emit a single `FrameworkDetection` with tiered confidence
 *      (`deterministic` for tier D/C hits backed by a manifest or file
 *      marker, `heuristic` for tier H hits from layout alone, `composite`
 *      when a tier C entry required two signals to fire).
 *
 * Mutual exclusion (FRM-UN-001) is enforced implicitly: Next.js carries
 * `parent: "react"`, so downstream consumers know Next.js wraps React.
 * Both are emitted; the `parentName` link preserves the relationship
 * without dropping signal.
 *
 * Determinism: output is sorted alphabetically by `name`.
 */

import type { Evidence, FrameworkDetection } from "@opencodehub/core-types";
import {
  FRAMEWORK_CATALOG,
  type FrameworkEcosystem,
  type FrameworkRule,
  type ManifestKey,
} from "./catalog.js";
import {
  VARIANT_RESOLVERS,
  type VariantResolveInput,
  type VariantResolver,
} from "./variant-detectors.js";

/** Input to the dispatcher. */
export interface FrameworkDetectorInput {
  /** Every scanned relPath (posix). */
  readonly relPaths: ReadonlySet<string>;
  /** Raw text of each manifest file we pre-read; keyed by relPath. */
  readonly manifestText: ReadonlyMap<string, string>;
  /**
   * Detected languages from `ProjectProfile.languages`. Used to profile-
   * gate the catalog so we skip entries for absent ecosystems.
   */
  readonly detectedLanguages: readonly string[];
  /**
   * Stage 2 — per-dep exact-version resolutions from parsed lockfiles
   * (`package-lock.json`, `pnpm-lock.yaml`, `Gemfile.lock`, `poetry.lock`,
   * `uv.lock`, `Cargo.lock`). When a rule's `versionKey` points at a
   * dep whose manifest declaration is a semver range, the detector
   * substitutes the lockfile's pinned version. Absent for legacy callers.
   */
  readonly lockfileVersions?: ReadonlyMap<string, string>;
}

/** Mapping language → ecosystem. Covers the tree-sitter languages OpenCodeHub indexes. */
const LANGUAGE_TO_ECOSYSTEM: Readonly<Record<string, FrameworkEcosystem>> = {
  javascript: "js",
  typescript: "js",
  python: "python",
  ruby: "ruby",
  go: "go",
  rust: "rust",
  java: "java",
  kotlin: "java",
  php: "php",
  csharp: "csharp",
};

/**
 * Run the dispatcher.
 */
export function detectFrameworksStructured(
  input: FrameworkDetectorInput,
): readonly FrameworkDetection[] {
  const activeEcosystems = ecosystemsFromLanguages(input.detectedLanguages);
  const manifestJson = parseManifestJson(input.manifestText);
  const resolverInput: VariantResolveInput = {
    relPaths: input.relPaths,
    manifestJson,
    manifestText: input.manifestText,
  };

  const out: FrameworkDetection[] = [];
  for (const rule of FRAMEWORK_CATALOG) {
    if (rule.ecosystem !== "any" && !activeEcosystems.has(rule.ecosystem)) continue;
    const hit = evaluateRule(rule, input, manifestJson);
    if (hit === null) continue;
    const detection = buildDetection(
      rule,
      hit,
      resolverInput,
      manifestJson,
      input.lockfileVersions,
    );
    out.push(detection);
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// Evaluation helpers
// ---------------------------------------------------------------------------

interface RuleHit {
  /**
   * Structured evidence entries (stages 1+4) that corroborated this
   * framework. Deduped by (stage, source, detail). Sorted deterministically.
   */
  readonly evidence: readonly Evidence[];
  /** Whether a manifest-level (stage 1, tier D) signal fired. */
  readonly hasManifestHit: boolean;
  /** Whether a layout/heuristic (stage 4, tier H) signal fired. */
  readonly hasFileHit: boolean;
}

function evidenceKey(e: Evidence): string {
  return `${e.stage}\x00${e.source}\x00${e.detail}`;
}

function evaluateRule(
  rule: FrameworkRule,
  input: FrameworkDetectorInput,
  manifestJson: ReadonlyMap<string, unknown>,
): RuleHit | null {
  const evidenceSeen = new Map<string, Evidence>();
  let hasManifestHit = false;
  let hasFileHit = false;

  const push = (e: Evidence): void => {
    const key = evidenceKey(e);
    if (!evidenceSeen.has(key)) evidenceSeen.set(key, e);
  };

  // Stage 4 — file markers (exact path match).
  if (rule.fileMarkers) {
    for (const marker of rule.fileMarkers) {
      if (input.relPaths.has(marker)) {
        push({ stage: 4, source: marker, detail: `file marker: ${marker}` });
        hasFileHit = true;
      }
    }
  }
  // Stage 4 — file regex markers.
  if (rule.fileRegexMarkers) {
    for (const rx of rule.fileRegexMarkers) {
      for (const p of input.relPaths) {
        if (rx.test(p)) {
          push({ stage: 4, source: p, detail: `file regex: ${rx.source}` });
          hasFileHit = true;
          break;
        }
      }
    }
  }
  // Stage 1 — manifest-key fingerprints.
  if (rule.manifestKeys) {
    for (const key of rule.manifestKeys) {
      if (matchManifestKey(key, manifestJson, input.manifestText)) {
        const detail =
          key.path !== undefined
            ? `manifest key: ${key.file}#${key.path}`
            : `manifest present: ${key.file}`;
        push({ stage: 1, source: key.file, detail });
        hasManifestHit = true;
      }
    }
  }

  if (!hasManifestHit && !hasFileHit) return null;
  const sorted = [...evidenceSeen.values()].sort((a, b) => {
    if (a.stage !== b.stage) return a.stage - b.stage;
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    return a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0;
  });
  return { evidence: sorted, hasManifestHit, hasFileHit };
}

function matchManifestKey(
  key: ManifestKey,
  manifestJson: ReadonlyMap<string, unknown>,
  manifestText: ReadonlyMap<string, string>,
): boolean {
  const parsed = manifestJson.get(key.file);
  if (key.path !== undefined && parsed !== undefined && parsed !== null) {
    if (getPath(parsed, key.path) !== undefined) return true;
  }
  if (key.textMatch !== undefined) {
    const text = manifestText.get(key.file);
    if (text !== undefined && key.textMatch.test(text)) return true;
  }
  return false;
}

function buildDetection(
  rule: FrameworkRule,
  hit: RuleHit,
  resolverInput: VariantResolveInput,
  manifestJson: ReadonlyMap<string, unknown>,
  lockfileVersions: ReadonlyMap<string, string> | undefined,
): FrameworkDetection {
  const version = resolveVersion(rule, manifestJson, lockfileVersions);
  const variant = resolveVariant(rule, resolverInput);
  const confidence = inferConfidence(rule, hit);
  const det: FrameworkDetection = {
    name: rule.name,
    category: rule.category,
    confidence,
    evidence: hit.evidence,
    ...(variant !== undefined ? { variant } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(rule.parent !== undefined ? { parentName: rule.parent } : {}),
  };
  return det;
}

function inferConfidence(rule: FrameworkRule, hit: RuleHit): FrameworkDetection["confidence"] {
  if (rule.tier === "C") return "composite";
  if (hit.hasManifestHit) return "deterministic";
  // tier D/H with only file-level hits → heuristic.
  return "heuristic";
}

function resolveVariant(
  rule: FrameworkRule,
  resolverInput: VariantResolveInput,
): string | undefined {
  if (!rule.variants || rule.variants.length === 0) return undefined;
  // All variants on one rule share a discriminator. Use the first entry's
  // discriminator to pick the resolver; the resolver itself returns the
  // label.
  const discriminator = rule.variants[0]?.discriminator;
  if (discriminator === undefined) return undefined;
  const resolver: VariantResolver | undefined = VARIANT_RESOLVERS.get(discriminator);
  if (resolver === undefined) return undefined;
  const label = resolver(resolverInput);
  if (label === null || label === undefined) return undefined;
  // Validate the returned label against the declared variant set. If the
  // resolver returned an unknown label we drop it (defense-in-depth).
  const known = rule.variants.some((v) => v.value === label);
  return known ? label : undefined;
}

function resolveVersion(
  rule: FrameworkRule,
  manifestJson: ReadonlyMap<string, unknown>,
  lockfileVersions: ReadonlyMap<string, string> | undefined,
): string | undefined {
  if (!rule.versionKey) return undefined;
  // Stage 2: prefer the lockfile-resolved exact version when present. The
  // versionKey.path is dot-delimited — the last segment is the dep name
  // (`dependencies.react` → `react`, `require.laravel/framework` →
  // `laravel/framework`). Lockfile entries use the bare dep name, so we
  // match on the last segment.
  if (lockfileVersions !== undefined) {
    const depName = lastPathSegment(rule.versionKey.path);
    if (depName !== null) {
      const pinned = lockfileVersions.get(depName);
      if (pinned !== undefined) return pinned;
    }
  }
  // Fallback to the manifest-declared range.
  const parsed = manifestJson.get(rule.versionKey.file);
  if (parsed === undefined || parsed === null) return undefined;
  // Try the declared versionKey.path first, then the sibling dependency
  // bucket. Many rules declare `manifestKeys` for BOTH `dependencies.<dep>`
  // and `devDependencies.<dep>` (e.g. vite, electron, jest, vitest,
  // playwright) but pin `versionKey` to a single bucket. Without this
  // fallback a project that declares the dep in the *other* bucket is
  // detected but reports `version: undefined`. We probe both common
  // buckets so the version is resolved regardless of which one carries it.
  for (const candidate of versionKeyCandidates(rule.versionKey.path)) {
    const v = getPath(parsed, candidate);
    if (typeof v === "string") return v;
  }
  return undefined;
}

/**
 * Yield the declared version path plus its sibling dependency bucket. A
 * path of `dependencies.vite` also tries `devDependencies.vite` and vice
 * versa; paths that don't name a dependency bucket are returned as-is.
 */
function versionKeyCandidates(path: string): readonly string[] {
  if (path.startsWith("dependencies.")) {
    return [path, `devDependencies.${path.slice("dependencies.".length)}`];
  }
  if (path.startsWith("devDependencies.")) {
    return [path, `dependencies.${path.slice("devDependencies.".length)}`];
  }
  return [path];
}

function lastPathSegment(path: string): string | null {
  const idx = path.lastIndexOf(".");
  if (idx < 0) return path.length > 0 ? path : null;
  const seg = path.slice(idx + 1);
  return seg.length > 0 ? seg : null;
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function ecosystemsFromLanguages(langs: readonly string[]): ReadonlySet<FrameworkEcosystem> {
  const out = new Set<FrameworkEcosystem>();
  for (const lang of langs) {
    const eco = LANGUAGE_TO_ECOSYSTEM[lang];
    if (eco !== undefined) out.add(eco);
  }
  return out;
}

function parseManifestJson(
  manifestText: ReadonlyMap<string, string>,
): ReadonlyMap<string, unknown> {
  const JSON_MANIFESTS = new Set([
    "package.json",
    "composer.json",
    "src-tauri/tauri.conf.json",
    "src-tauri/tauri.conf.json5",
  ]);
  const out = new Map<string, unknown>();
  for (const [name, text] of manifestText) {
    if (!JSON_MANIFESTS.has(name)) continue;
    try {
      out.set(name, JSON.parse(text));
    } catch {
      // Malformed manifest — FRM-UN-002: log-and-continue policy is
      // enforced by the caller; we just skip it here.
    }
  }
  return out;
}

/**
 * Dot-path lookup with `.` as the separator. Keys with a literal dot
 * (e.g. `@angular/core` or `laravel/framework`) are handled by greedy
 * matching: we try the longest match at each step first.
 */
function getPath(obj: unknown, path: string): unknown {
  if (typeof obj !== "object" || obj === null) return undefined;
  let current: unknown = obj;
  let remaining = path;
  while (remaining.length > 0) {
    if (typeof current !== "object" || current === null) return undefined;
    const rec = current as Record<string, unknown>;
    // Greedy match: try the whole remaining path as a single key first,
    // then progressively shorter prefixes. This lets keys containing
    // literal dots (`@nestjs/core`, `spring-boot`) resolve correctly.
    let matched = false;
    // Walk candidate-end positions from longest to shortest.
    const firstDot = remaining.indexOf(".");
    if (firstDot === -1) {
      // Single segment — direct look-up.
      if (Object.hasOwn(rec, remaining)) {
        return rec[remaining];
      }
      return undefined;
    }
    // Multi-segment — but some dependency keys like "laravel/framework"
    // don't carry dots at all, so the normal case is a simple segment-
    // by-segment walk. We keep the literal-dot-in-key case for future
    // use; right now `path` never embeds a dot itself.
    const head = remaining.slice(0, firstDot);
    if (Object.hasOwn(rec, head)) {
      current = rec[head];
      remaining = remaining.slice(firstDot + 1);
      matched = true;
    }
    if (!matched) return undefined;
  }
  return current;
}
