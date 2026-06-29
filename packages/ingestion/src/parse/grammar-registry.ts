/**
 * Lightweight grammar metadata registry.
 *
 * In the WASM-only world, the parse-worker resolves grammar `.wasm` blobs
 * directly from `vendor/wasms/` (see `wasm-runtime.ts`); there is no
 * native `Language` object to require() or cache. This module retains
 * three responsibilities:
 *
 *   1. Mark languages by provider kind (`tree-sitter` vs `regex`) so
 *      callers can route COBOL files through the regex extractor.
 *   2. Surface a tiny `GrammarHandle` carrying the unified S-expression
 *      query text used by the worker pool's secondary consumers (rare —
 *      most consumers go through `getUnifiedQuery` directly).
 *   3. Compute a stable per-grammar SHA from the package manifest pinned
 *      in `pnpm-lock.yaml`, used as a parse-cache key. The SHA still
 *      derives from the npm `tree-sitter-<lang>` package's `package.json`
 *      because that's the canonical version pin — the workspace keeps
 *      these as `devDependencies` so the manifests resolve in dev.
 *      Returns `null` when the package is not installed (e.g. on a
 *      consumer-of-the-published-package install path), which disables
 *      parse-cache keying for that language.
 *
 * ## Regex-provider escape hatch
 *
 * Some languages — COBOL is the first — have no maintained tree-sitter
 * grammar and ship via a pure-regex extractor instead. The registry encodes
 * that split with a {@link LanguageProviderSpec} discriminated union:
 *
 *   - `{ kind: "tree-sitter", package: string }` — the classic path; the
 *     grammar package name is used as the parse-cache fingerprint via
 *     {@link getGrammarSha}.
 *   - `{ kind: "regex" }` — the escape hatch; {@link loadGrammar} refuses
 *     to build a `GrammarHandle`, {@link getGrammarSha} returns `null`
 *     (disables parse-cache keying), and upstream parse-phase code is
 *     expected to route the file through the language-specific regex
 *     extractor instead of the worker pool.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Hex } from "@opencodehub/core-types";
import type { LanguageId } from "./types.js";
import { getUnifiedQuery } from "./unified-queries.js";
import { resolveVendorWasmsDir } from "./vendor-wasms.js";

// `vendor/wasms/manifest.json` is the canonical version pin for every grammar
// after native tree-sitter left the workspace. Resolved via the shared
// walk-up probe so it works from both the standalone ingestion build
// (`dist/parse/`) and the flat `@opencodehub/cli` bundle (`dist/` root) — a
// fixed two-up offset broke the latter (see `./vendor-wasms.ts`).
const MANIFEST_PATH = join(resolveVendorWasmsDir(import.meta.url), "manifest.json");

let manifestCache: Promise<Record<string, string> | null> | null = null;

async function loadManifestVersions(): Promise<Record<string, string> | null> {
  if (manifestCache) return manifestCache;
  manifestCache = (async () => {
    try {
      const text = await readFile(MANIFEST_PATH, "utf8");
      const json = JSON.parse(text) as { readonly grammars?: Record<string, string> };
      return json.grammars ?? null;
    } catch {
      return null;
    }
  })();
  return manifestCache;
}

/**
 * Provider spec for a single language. Discriminated on `kind`:
 *   - `"tree-sitter"` — the language has an npm-published tree-sitter
 *     grammar. `package` names the package whose `package.json` supplies
 *     the parse-cache fingerprint.
 *   - `"regex"` — the language has no tree-sitter grammar; the parse
 *     pipeline routes its files through a bespoke regex extractor. No
 *     grammar package to fingerprint, so parse-cache keying is disabled
 *     (see {@link getGrammarSha}).
 *
 * Named `LanguageProviderSpec` to avoid colliding with the broader
 * `LanguageProvider` interface in `providers/types.ts`.
 */
export type LanguageProviderSpec =
  | { readonly kind: "tree-sitter"; readonly package: string }
  | { readonly kind: "regex" };

/**
 * Per-language provider spec. `satisfies Record<LanguageId, …>` keeps this
 * 1:1 with the `LanguageId` union at compile time — adding a new language
 * without an entry here fails the type check.
 */
const LANGUAGE_PROVIDERS = {
  typescript: { kind: "tree-sitter", package: "tree-sitter-typescript" },
  tsx: { kind: "tree-sitter", package: "tree-sitter-typescript" },
  javascript: { kind: "tree-sitter", package: "tree-sitter-javascript" },
  python: { kind: "tree-sitter", package: "tree-sitter-python" },
  go: { kind: "tree-sitter", package: "tree-sitter-go" },
  rust: { kind: "tree-sitter", package: "tree-sitter-rust" },
  java: { kind: "tree-sitter", package: "tree-sitter-java" },
  csharp: { kind: "tree-sitter", package: "tree-sitter-c-sharp" },
  c: { kind: "tree-sitter", package: "tree-sitter-c" },
  cpp: { kind: "tree-sitter", package: "tree-sitter-cpp" },
  ruby: { kind: "tree-sitter", package: "tree-sitter-ruby" },
  kotlin: { kind: "tree-sitter", package: "tree-sitter-kotlin" },
  swift: { kind: "tree-sitter", package: "tree-sitter-swift" },
  php: { kind: "tree-sitter", package: "tree-sitter-php" },
  dart: { kind: "tree-sitter", package: "tree-sitter-dart" },
  // COBOL ships via the regex hot path (see `parse/cobol-regex.ts`).
  cobol: { kind: "regex" },
} as const satisfies Readonly<Record<LanguageId, LanguageProviderSpec>>;

/**
 * Narrow a language's provider spec to its discriminated union. Exported so
 * upstream parse-phase code can branch on the provider kind without
 * re-implementing the registry lookup. Typical use:
 * `getLanguageProvider(lang).kind === "regex"` to guard the regex-dispatch
 * path.
 */
export function getLanguageProvider(lang: LanguageId): LanguageProviderSpec {
  return LANGUAGE_PROVIDERS[lang];
}

/** `true` iff `lang` ships via the regex hot path rather than tree-sitter. */
export function isRegexProviderLanguage(lang: LanguageId): boolean {
  return LANGUAGE_PROVIDERS[lang].kind === "regex";
}

/** Opaque wrapper holding the per-language metadata callers need. */
export interface GrammarHandle {
  readonly language: LanguageId;
  /** Unified S-expression query body for this language. */
  readonly queryText: string;
}

// Per-process memoization of grammar SHAs — the value is stable for the
// lifetime of the process (resolving + hashing a package.json is cheap but
// not free, and scan() calls this per-file).
const grammarShaCache = new Map<LanguageId, string | null>();

/**
 * Return a {@link GrammarHandle} for `lang`. After the WASM-only refactor
 * this is a thin object carrying just the language id and its unified
 * query text — there is no native `Language` to load. Refuses regex-only
 * languages so callers that should have routed through the regex extractor
 * see a hard error rather than a silently broken handle.
 */
export async function loadGrammar(lang: LanguageId): Promise<GrammarHandle> {
  const spec = LANGUAGE_PROVIDERS[lang];
  if (spec.kind === "regex") {
    throw new Error(
      `loadGrammar: ${lang} is a regex-provider language and has no tree-sitter grammar; ` +
        `route the file through the language's regex extractor instead.`,
    );
  }
  return { language: lang, queryText: getUnifiedQuery(lang) };
}

/**
 * Preload a list of grammars in parallel. Useful as a warm-up hint during
 * indexing start-up, but not required — {@link loadGrammar} is safe to call
 * lazily during parsing. Retained as a callable no-op-style API so existing
 * pipeline orchestration keeps working.
 */
export async function preloadGrammars(langs: readonly LanguageId[]): Promise<void> {
  await Promise.all(langs.map((l) => loadGrammar(l)));
}

/**
 * Compute a stable SHA for the grammar backing `lang`. The SHA is derived
 * from `sha256(JSON.stringify({ name, version }))` of the grammar's
 * `package.json` — bumping the grammar version in the workspace therefore
 * produces a new SHA, which is what the content-addressed parse cache
 * needs in its composite key.
 *
 * Returns `null` when:
 *   - the grammar package is not installed (e.g. on a consumer install
 *     path where the native packages are devDependencies of the source
 *     repo only), OR
 *   - the package.json could not be read/parsed.
 *
 * Result is memoized per-process. Idempotent across concurrent callers.
 */
export async function getGrammarSha(lang: LanguageId): Promise<string | null> {
  if (grammarShaCache.has(lang)) {
    return grammarShaCache.get(lang) ?? null;
  }
  const spec = LANGUAGE_PROVIDERS[lang];
  // Regex-provider languages have no npm grammar to fingerprint, so
  // parse-cache keying is disabled for those files (cache writes / reads
  // treat `null` as "uncacheable").
  const sha = spec.kind === "regex" ? null : await computeGrammarSha(spec.package);
  grammarShaCache.set(lang, sha);
  return sha;
}

async function computeGrammarSha(pkgName: string): Promise<string | null> {
  // The grammar version comes from the vendored manifest.json, which is
  // committed alongside the .wasm files and updated atomically by
  // scripts/build-vendor-wasms.sh. This avoids requiring the npm grammar
  // packages to be installed at runtime — they're not workspace deps.
  const versions = await loadManifestVersions();
  if (!versions) return null;
  const version = versions[pkgName];
  if (typeof version !== "string" || version === "") return null;
  // Canonical JSON-like form so the SHA does not depend on object key order.
  return sha256Hex(JSON.stringify({ name: pkgName, version }));
}

/**
 * The vendored grammar version pins, as `{ "<grammar-package>": "<version>" }`.
 *
 * Reads `vendor/wasms/manifest.json` (the same canonical pin
 * {@link getGrammarSha} fingerprints) via the shared walk-up resolver, so it
 * works from both the standalone build and the flat `@opencodehub/cli` bundle.
 * Returns an empty object when the manifest cannot be read — callers treat the
 * pins as best-effort provenance, never a hard dependency.
 */
export async function grammarVersions(): Promise<Readonly<Record<string, string>>> {
  return (await loadManifestVersions()) ?? {};
}

/** For tests: drop the cache so the next load() re-imports fresh. */
export function _resetGrammarCacheForTests(): void {
  grammarShaCache.clear();
}
