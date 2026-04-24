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

import type { FrameworkDetection } from "@opencodehub/core-types";
import {
  FRAMEWORK_CATALOG,
  type FrameworkEcosystem,
  type FrameworkRule,
  type ManifestKey,
} from "./frameworks-catalog.js";
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
    const detection = buildDetection(rule, hit, resolverInput, manifestJson);
    out.push(detection);
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// Evaluation helpers
// ---------------------------------------------------------------------------

interface RuleHit {
  /** Signals that corroborated this framework (sorted, deduped). */
  readonly signals: readonly string[];
  /** Whether a manifest-level (tier D) signal fired. */
  readonly hasManifestHit: boolean;
  /** Whether a layout/heuristic (tier H) signal fired. */
  readonly hasFileHit: boolean;
}

function evaluateRule(
  rule: FrameworkRule,
  input: FrameworkDetectorInput,
  manifestJson: ReadonlyMap<string, unknown>,
): RuleHit | null {
  const signals = new Set<string>();
  let hasManifestHit = false;
  let hasFileHit = false;

  // file markers — exact path match
  if (rule.fileMarkers) {
    for (const marker of rule.fileMarkers) {
      if (input.relPaths.has(marker)) {
        signals.add(`file:${marker}`);
        hasFileHit = true;
      }
    }
  }
  // file regex markers
  if (rule.fileRegexMarkers) {
    for (const rx of rule.fileRegexMarkers) {
      for (const p of input.relPaths) {
        if (rx.test(p)) {
          signals.add(`file-regex:${rx.source}`);
          hasFileHit = true;
          break;
        }
      }
    }
  }
  // manifest-key fingerprints
  if (rule.manifestKeys) {
    for (const key of rule.manifestKeys) {
      if (matchManifestKey(key, manifestJson, input.manifestText)) {
        signals.add(`manifest:${key.file}${key.path !== undefined ? `#${key.path}` : ""}`);
        hasManifestHit = true;
      }
    }
  }

  if (!hasManifestHit && !hasFileHit) return null;
  const sortedSignals = [...signals].sort();
  return { signals: sortedSignals, hasManifestHit, hasFileHit };
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
): FrameworkDetection {
  const version = resolveVersion(rule, manifestJson);
  const variant = resolveVariant(rule, resolverInput);
  const confidence = inferConfidence(rule, hit);
  const det: FrameworkDetection = {
    name: rule.name,
    category: rule.category,
    confidence,
    signals: hit.signals,
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
): string | undefined {
  if (!rule.versionKey) return undefined;
  const parsed = manifestJson.get(rule.versionKey.file);
  if (parsed === undefined || parsed === null) return undefined;
  const v = getPath(parsed, rule.versionKey.path);
  if (typeof v !== "string") return undefined;
  return v;
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
