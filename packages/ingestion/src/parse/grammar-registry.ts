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
 */

import { createRequire } from "node:module";
import { sha256Hex } from "@opencodehub/core-types";
import type { LanguageId } from "./types.js";
import { getUnifiedQuery } from "./unified-queries.js";

const requireFn = createRequire(import.meta.url);

/**
 * Per-language tree-sitter grammar npm package. Used by
 * {@link getGrammarSha} to hash `{ name, version }` from the package's
 * `package.json`, which keys the content-addressed parse cache. A grammar
 * version bump in the workspace `package.json` therefore invalidates the
 * cache cleanly, satisfying thecache-key invariant.
 */
const GRAMMAR_PACKAGE_BY_LANGUAGE: Readonly<Record<LanguageId, string>> = {
  typescript: "tree-sitter-typescript",
  tsx: "tree-sitter-typescript",
  javascript: "tree-sitter-javascript",
  python: "tree-sitter-python",
  go: "tree-sitter-go",
  rust: "tree-sitter-rust",
  java: "tree-sitter-java",
  csharp: "tree-sitter-c-sharp",
  c: "tree-sitter-c",
  cpp: "tree-sitter-cpp",
  ruby: "tree-sitter-ruby",
  kotlin: "tree-sitter-kotlin",
  swift: "tree-sitter-swift",
  php: "tree-sitter-php",
  dart: "tree-sitter-dart",
};

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
 */
export async function loadGrammar(lang: LanguageId): Promise<GrammarHandle> {
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
      // tree-sitter-dart git-pinned to UserNobody14/tree-sitter-dart SHA
      // 0fc19c3a (2026-03-14). npm registry 1.0.0 is 3 years stale; we pin
      // via the `git+https://…#sha` URL in package.json. Module IS the
      // Language (CJS, uses legacy `nan` addon API).
      return requireFn("tree-sitter-dart");
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
  const pkgName = GRAMMAR_PACKAGE_BY_LANGUAGE[lang];
  const sha = await computeGrammarSha(pkgName);
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
