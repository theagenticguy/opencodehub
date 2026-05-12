/**
 * Lazy grammar loader.
 *
 * Imports the native tree-sitter grammar modules on demand — the first call
 * to `loadGrammar('python')` pulls in `tree-sitter-python`, subsequent calls
 * hit the in-process cache. This keeps the cold-start cost of the parse
 * subsystem low: importing `grammar-registry` alone does not load any grammar
 * `.node` file.
 *
 * Each grammar package exposes its tree-sitter `Language` object differently:
 *   - typescript: module has `.typescript` and `.tsx` properties
 *   - javascript/python/go/go/java/rust: module IS the Language
 *   - c-sharp: ESM default export IS the Language
 *   - c, cpp, ruby, kotlin, swift: module IS the Language (CJS require)
 *   - php: module has `.php` and `.php_only` — we load `.php_only` (pure PHP,
 *     no HTML template injection; better for static analysis)
 *   - dart: git-pinned CJS module that IS the Language
 *
 * This module abstracts those differences behind {@link loadGrammar}.
 *
 * ## Regex-provider escape hatch
 *
 * Some languages — COBOL is the first — have no maintained tree-sitter
 * grammar and ship via a pure-regex extractor instead. The registry encodes
 * that split with a {@link LanguageProviderSpec} discriminated union:
 *
 *   - `{ kind: "tree-sitter", package: string }` — the classic path; the
 *     grammar package is resolved lazily from npm and hashed into the
 *     parse-cache key via {@link getGrammarSha}.
 *   - `{ kind: "regex" }` — the escape hatch; {@link loadGrammar} refuses
 *     to build a `GrammarHandle`, {@link getGrammarSha} returns `null`
 *     (disables parse-cache keying), and upstream parse-phase code is
 *     expected to route the file through the language-specific regex
 *     extractor instead of the worker pool.
 *
 * This keeps every tree-sitter consumer of the registry working unchanged
 * while giving downstream code a typed way to detect regex-only languages.
 */

import { createRequire } from "node:module";
import { sha256Hex } from "@opencodehub/core-types";
import type { LanguageId } from "./types.js";
import { getUnifiedQuery } from "./unified-queries.js";

const requireFn = createRequire(import.meta.url);

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
 * `LanguageProvider` interface in `providers/types.ts` (which covers
 * extract-* hooks, MRO strategy, and other provider-wide behavior).
 */
export type LanguageProviderSpec =
  | { readonly kind: "tree-sitter"; readonly package: string }
  | { readonly kind: "regex" };

/**
 * Per-language provider spec. `satisfies Record<LanguageId, …>` keeps this
 * 1:1 with the `LanguageId` union at compile time — adding a new language
 * without an entry here fails the type check.
 *
 * Tree-sitter entries carry the npm grammar package name. The content-
 * addressed parse cache hashes `{ name, version }` from that package's
 * `package.json`, so a grammar version bump in the workspace lockfile
 * invalidates the cache cleanly.
 *
 * Regex entries (currently only `cobol`) carry no package reference —
 * {@link loadGrammar} and {@link getGrammarSha} treat them as a marker
 * that the caller must dispatch through the language's regex extractor.
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

/** Opaque wrapper holding everything a worker needs for one language. */
export interface GrammarHandle {
  readonly language: LanguageId;
  /** tree-sitter Language object (opaque to callers). */
  readonly tsLanguage: unknown;
  /** Unified S-expression query body for this language. */
  readonly queryText: string;
}

const cache = new Map<LanguageId, GrammarHandle>();
// De-dupe concurrent calls for the same language so we only require() once.
const inflight = new Map<LanguageId, Promise<GrammarHandle>>();

// Per-process memoization of grammar SHAs — the value is stable for the
// lifetime of the process (resolving + hashing a package.json is cheap but
// not free, and scan() calls this per-file).
const grammarShaCache = new Map<LanguageId, string | null>();

/**
 * Load and cache the tree-sitter grammar for a language.
 *
 * Thread/context note: the cache is per-module-instance, so in the
 * piscina worker model each worker has its own cache — which matches
 * tree-sitter's thread-safety rules (one Parser per worker_thread).
 *
 * Regex-provider languages (see {@link isRegexProviderLanguage}) throw
 * on entry: they have no tree-sitter grammar to load, and reaching this
 * function means the caller skipped the `kind === "regex"` dispatch
 * guard. That is a bug on the call site, not a runtime condition to
 * recover from.
 */
export async function loadGrammar(lang: LanguageId): Promise<GrammarHandle> {
  const spec = LANGUAGE_PROVIDERS[lang];
  if (spec.kind === "regex") {
    throw new Error(
      `loadGrammar: ${lang} is a regex-provider language and has no tree-sitter grammar; ` +
        `route the file through the language's regex extractor instead.`,
    );
  }
  const cached = cache.get(lang);
  if (cached !== undefined) {
    return cached;
  }
  const existing = inflight.get(lang);
  if (existing !== undefined) {
    return existing;
  }
  const p = doLoad(lang).then((handle) => {
    cache.set(lang, handle);
    inflight.delete(lang);
    return handle;
  });
  inflight.set(lang, p);
  return p;
}

/**
 * Preload a list of grammars in parallel. Useful as a warm-up hint during
 * indexing start-up, but not required — {@link loadGrammar} is safe to call
 * lazily during parsing.
 */
export async function preloadGrammars(langs: readonly LanguageId[]): Promise<void> {
  await Promise.all(langs.map((l) => loadGrammar(l)));
}

async function doLoad(lang: LanguageId): Promise<GrammarHandle> {
  const tsLanguage = await loadLanguageObject(lang);
  return {
    language: lang,
    tsLanguage,
    queryText: getUnifiedQuery(lang),
  };
}

/**
 * Resolve the Language object for each grammar, handling per-package quirks.
 * Returned value is passed straight into `parser.setLanguage()`.
 */
async function loadLanguageObject(lang: LanguageId): Promise<unknown> {
  switch (lang) {
    case "typescript": {
      const mod = requireFn("tree-sitter-typescript") as {
        typescript: unknown;
        tsx: unknown;
      };
      return mod.typescript;
    }
    case "tsx": {
      const mod = requireFn("tree-sitter-typescript") as {
        typescript: unknown;
        tsx: unknown;
      };
      return mod.tsx;
    }
    case "javascript":
      return requireFn("tree-sitter-javascript");
    case "python":
      return requireFn("tree-sitter-python");
    case "go":
      return requireFn("tree-sitter-go");
    case "rust":
      return requireFn("tree-sitter-rust");
    case "java":
      return requireFn("tree-sitter-java");
    case "csharp": {
      // tree-sitter-c-sharp is ESM-only; use dynamic import. The default
      // export is the Language binding.
      const mod = (await import("tree-sitter-c-sharp")) as { default: unknown };
      return mod.default;
    }
    case "c":
      // tree-sitter-c 0.24.1 — canonical tree-sitter-org CJS grammar, ships
      // prebuilds for 6 platforms. Module IS the Language.
      return requireFn("tree-sitter-c");
    case "cpp":
      // tree-sitter-cpp 0.23.4 — extends tree-sitter-c; prebuilds shipped.
      return requireFn("tree-sitter-cpp");
    case "ruby":
      // tree-sitter-ruby 0.23.1 — prebuilds shipped. Module IS the Language.
      return requireFn("tree-sitter-ruby");
    case "kotlin":
      // tree-sitter-kotlin 0.3.8 (fwcd) — NO prebuilds on npm; install-time
      // node-gyp build is expected. If the native binary is missing on an
      // exotic platform, require() throws and callers surface the error.
      return requireFn("tree-sitter-kotlin");
    case "swift":
      // tree-sitter-swift 0.7.1 (alex-pinkus) — ships prebuilds but also has
      // a postinstall rebuild (~30s one-time). Runtime-transparent.
      return requireFn("tree-sitter-swift");
    case "php": {
      // tree-sitter-php 0.24.2 ships TWO grammars in one package:
      //   - `.php`: pure PHP with HTML injection (for .blade.php, .phtml etc.)
      //   - `.php_only`: pure PHP without HTML injection
      // We load `.php_only` — static analysis cares about PHP code, not HTML.
      const mod = requireFn("tree-sitter-php") as {
        php: unknown;
        php_only: unknown;
      };
      return mod.php_only;
    }
    case "dart":
      // Dart is WASM-only on the public package — see vendor/wasms/.
      // Removed the git-pinned tree-sitter-dart dependency in 0.2.x because
      // npm consumers couldn't `npm install -g @opencodehub/cli` (npm tries
      // to git-clone + node-gyp the pin and fails on machines without a
      // C++ toolchain). Native opt-in (`OCH_NATIVE_PARSER=1`) is unsupported
      // for Dart on the registry build; clear the env var to use the WASM
      // path that ships with the published package.
      throw new Error(
        "tree-sitter-dart is not bundled as a native binding in published builds; " +
          "Dart parsing uses the vendored WASM grammar. " +
          "Unset OCH_NATIVE_PARSER (or omit --native-parser) to use the WASM path.",
      );
    case "cobol":
      // Guarded at the `loadGrammar` entry point via the provider-kind
      // discriminator; a direct call to `loadLanguageObject("cobol")`
      // indicates a caller bypassed that guard. Keep the branch so
      // TypeScript's exhaustiveness check passes.
      throw new Error(
        "loadLanguageObject: cobol is a regex-provider language (no tree-sitter grammar)",
      );
  }
}

/**
 * Compute a stable SHA for the grammar backing `lang`. The SHA is derived
 * from `sha256(JSON.stringify({ name, version }))` of the grammar's
 * `package.json` — bumping the grammar version in the workspace therefore
 * produces a new SHA, which is what the content-addressed parse cache
 * needs in its composite key.
 *
 * Returns `null` when:
 *   - the grammar package is not installed (e.g. languages whose provider
 *     track has not landed yet), OR
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
  // `require.resolve('<pkg>/package.json')` returns the absolute path of the
  // package's manifest without executing any of its bindings — safe to call
  // even for grammars that fail to build natively at install time.
  let manifestPath: string;
  try {
    manifestPath = requireFn.resolve(`${pkgName}/package.json`);
  } catch {
    return null;
  }
  let manifest: { readonly name?: unknown; readonly version?: unknown };
  try {
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(manifestPath, "utf8");
    manifest = JSON.parse(text) as { readonly name?: unknown; readonly version?: unknown };
  } catch {
    return null;
  }
  const name = typeof manifest.name === "string" ? manifest.name : pkgName;
  const version = typeof manifest.version === "string" ? manifest.version : "";
  if (version === "") return null;
  // Canonical JSON-like form so the SHA does not depend on object key order.
  return sha256Hex(JSON.stringify({ name, version }));
}

/** For tests: drop the cache so the next load() re-imports fresh. */
export function _resetGrammarCacheForTests(): void {
  cache.clear();
  inflight.clear();
  grammarShaCache.clear();
}
