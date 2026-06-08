/**
 * WASM parser opener (the only runtime).
 *
 * `web-tree-sitter` is the sole parser host as of 0.4.0. Native `tree-sitter`
 * was removed from the runtime install graph; grammar `.wasm` blobs are
 * vendored under `packages/ingestion/vendor/wasms/` and resolved by a single
 * declarative LanguageId-to-filename map.
 *
 * `openWasmParser(lang)` lazily initializes the web-tree-sitter runtime
 * once per process and resolves the grammar WASM from the vendored
 * directory. Per-grammar cache means repeated calls are O(1).
 *
 * Query execution uses the same unified S-expression bodies from
 * `unified-queries.ts`.
 */

import { createRequire } from "node:module";
import path from "node:path";
import type { LanguageId } from "./types.js";
import { resolveVendorWasmsDir } from "./vendor-wasms.js";

const requireFn = createRequire(import.meta.url);

// Resolve `vendor/wasms/` regardless of the emitted layout — the standalone
// ingestion build (`dist/parse/`), the flat `@opencodehub/cli` bundle
// (`dist/` root, no `parse/` subdir), the test build, or a source checkout.
// A fixed two-levels-up offset broke in the flat CLI bundle (see
// `./vendor-wasms.ts`), so this delegates to a walk-up probe. Computed once.
const VENDOR_WASMS_DIR = resolveVendorWasmsDir(import.meta.url);

// ---------------------------------------------------------------------------
// WASM runtime
// ---------------------------------------------------------------------------

/**
 * Minimal shape of what `openWasmParser` returns — enough to run the
 * same capture loop the native worker implements. Intentionally
 * decoupled from the `web-tree-sitter` types so test code can stub it.
 */
export interface WasmParserHandle {
  readonly language: LanguageId;
  /** Parse a source string and return the underlying tree. */
  parse(source: string): WasmTree;
  /**
   * Execute the unified query and return the flat capture list. Callers
   * translate into `ParseCapture` via the normal coordinate remapping
   * (1-indexed lines, 0-indexed columns).
   */
  runQuery(queryText: string, source: string): readonly WasmCapture[];
}

export interface WasmTree {
  readonly rootNode: WasmNode;
}

export interface WasmNode {
  readonly type: string;
  readonly text: string;
  readonly startPosition: { readonly row: number; readonly column: number };
  readonly endPosition: { readonly row: number; readonly column: number };
  readonly childCount: number;
  readonly namedChildCount?: number;
  child(i: number): WasmNode | null;
  namedChild?(i: number): WasmNode | null;
  childForFieldName?(name: string): WasmNode | null;
}

export interface WasmCapture {
  readonly name: string;
  readonly node: WasmNode;
}

/**
 * Per-LanguageId cache of WASM grammar handles. Populated lazily.
 * `null` entries mean "tried and failed" — we don't retry forever.
 */
const wasmCache = new Map<LanguageId, WasmParserHandle | null>();
let wasmRuntime: WasmRuntime | undefined;

interface WasmRuntime {
  Parser: WasmParserCtor;
  Query: WasmQueryCtor;
  Language: WasmLanguageStatic;
  initialized: boolean;
}

interface WasmParserCtor {
  new (): WasmParserInstance;
  init?: (opts?: Record<string, unknown>) => Promise<void>;
}

interface WasmParserInstance {
  setLanguage(lang: unknown): void;
  parse(source: string): WasmTree;
}

interface WasmQueryCtor {
  new (lang: unknown, source: string): WasmQueryInstance;
}

interface WasmQueryInstance {
  matches(node: WasmNode): readonly { readonly captures: readonly WasmCapture[] }[];
}

interface WasmLanguageStatic {
  load(source: string | Uint8Array): Promise<unknown>;
}

/**
 * Expose the (resolved) Language type for downstream consumers (the
 * complexity phase) that build their own `Parser` instances against a
 * specific grammar.
 */
export type WasmLanguage = unknown;

/**
 * Build a parser for `lang` directly against the vendored WASM. Used by
 * the complexity phase, which re-parses on the main thread to walk for
 * cyclomatic / nesting / Halstead.
 */
export async function buildParserForLanguage(
  lang: LanguageId,
): Promise<WasmParserInstance | undefined> {
  const runtime = await ensureWasmRuntime();
  if (runtime === undefined) return undefined;
  const wasmPath = resolveGrammarWasmPath(lang);
  if (wasmPath === undefined) return undefined;
  const tsLanguage = await runtime.Language.load(wasmPath);
  const ParserCtor = runtime.Parser as unknown as new () => WasmParserInstance;
  const parser = new ParserCtor();
  parser.setLanguage(tsLanguage);
  return parser;
}

/**
 * Attempt to open a WASM-backed parser for `lang`. Returns `null` when
 * either the `web-tree-sitter` runtime or the grammar's bundled `.wasm`
 * could not be resolved — callers log a debug note and skip that file.
 */
export async function openWasmParser(lang: LanguageId): Promise<WasmParserHandle | null> {
  const cached = wasmCache.get(lang);
  if (cached !== undefined) return cached;
  try {
    const runtime = await ensureWasmRuntime();
    if (runtime === undefined) {
      wasmCache.set(lang, null);
      return null;
    }
    const wasmPath = resolveGrammarWasmPath(lang);
    if (wasmPath === undefined) {
      wasmCache.set(lang, null);
      return null;
    }
    const tsLanguage = await runtime.Language.load(wasmPath);
    const ParserCtor = runtime.Parser as unknown as new () => WasmParserInstance;
    const parser = new ParserCtor();
    parser.setLanguage(tsLanguage);

    const handle: WasmParserHandle = {
      language: lang,
      parse: (source: string) => parser.parse(source),
      runQuery: (queryText: string, source: string) => {
        // Fresh Query per call so state stays clean between bodies.
        // Query construction is cheap relative to the parse itself.
        const q = new runtime.Query(tsLanguage, queryText);
        const tree = parser.parse(source);
        const out: WasmCapture[] = [];
        for (const m of q.matches(tree.rootNode)) {
          for (const cap of m.captures) out.push(cap);
        }
        return out;
      },
    };
    wasmCache.set(lang, handle);
    return handle;
  } catch {
    wasmCache.set(lang, null);
    return null;
  }
}

/**
 * Load the web-tree-sitter runtime on demand and initialize it. Returns
 * `undefined` when the package isn't installed or the runtime refuses to
 * init (sandboxed, missing WebAssembly, etc.).
 *
 * The runtime WASM (`web-tree-sitter.wasm`) is also vendored — we point
 * Emscripten at it via `locateFile` so global installs don't have to find
 * it inside a `node_modules` shape that may not exist.
 */
export async function ensureWasmRuntime(): Promise<WasmRuntime | undefined> {
  if (wasmRuntime?.initialized === true) return wasmRuntime;
  let mod: { Parser: WasmParserCtor; Query: WasmQueryCtor; Language: WasmLanguageStatic };
  try {
    mod = requireFn("web-tree-sitter") as {
      Parser: WasmParserCtor;
      Query: WasmQueryCtor;
      Language: WasmLanguageStatic;
    };
  } catch {
    return undefined;
  }
  try {
    if (typeof mod.Parser.init === "function") {
      const runtimeWasm = path.resolve(VENDOR_WASMS_DIR, "web-tree-sitter.wasm");
      await mod.Parser.init({
        locateFile: () => runtimeWasm,
      });
    }
  } catch {
    return undefined;
  }
  wasmRuntime = {
    Parser: mod.Parser,
    Query: mod.Query,
    Language: mod.Language,
    initialized: true,
  };
  return wasmRuntime;
}

/**
 * Resolve the `.wasm` grammar asset for `lang` from the vendored
 * directory. The vendor build script (`scripts/build-vendor-wasms.sh`)
 * keeps this in sync with the grammar versions pinned in
 * `pnpm-lock.yaml`; `prepublishOnly` (`scripts/verify-vendor-wasms.mjs`)
 * fails the publish if any expected file is missing, mismatched, or has
 * invalid WASM magic bytes.
 *
 * Returns `undefined` for languages with no tree-sitter grammar (cobol,
 * which routes through the regex extractor).
 */
function resolveGrammarWasmPath(lang: LanguageId): string | undefined {
  const fname = LANGUAGE_WASM_FILES[lang];
  if (fname === undefined) return undefined;
  return path.resolve(VENDOR_WASMS_DIR, fname);
}

/**
 * LanguageId → filename in `vendor/wasms/`. The C# grammar lives at
 * `tree-sitter-c_sharp.wasm` (underscore, not hyphen) and PHP uses the
 * `php_only` variant (pure PHP, no HTML template injection) to match
 * the prior native-loader behavior. Cobol is intentionally absent — it
 * has no tree-sitter grammar and routes through the regex extractor.
 */
const LANGUAGE_WASM_FILES: Partial<Record<LanguageId, string>> = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  go: "tree-sitter-go.wasm",
  rust: "tree-sitter-rust.wasm",
  java: "tree-sitter-java.wasm",
  csharp: "tree-sitter-c_sharp.wasm",
  c: "tree-sitter-c.wasm",
  cpp: "tree-sitter-cpp.wasm",
  ruby: "tree-sitter-ruby.wasm",
  php: "tree-sitter-php_only.wasm",
  kotlin: "tree-sitter-kotlin.wasm",
  swift: "tree-sitter-swift.wasm",
  dart: "tree-sitter-dart.wasm",
};

/**
 * Test hook: clear the per-process WASM parser cache. Never call in
 * production paths — it would force a re-init of every grammar.
 */
export function _resetWasmCacheForTests(): void {
  wasmCache.clear();
  wasmRuntime = undefined;
}

/**
 * Test hook: expose the grammar-path resolver so unit tests can assert
 * the LanguageId-to-vendor-file mapping is exhaustive. Not part of the
 * public API — callers in production paths must go through
 * `openWasmParser`.
 */
export function _resolveGrammarWasmPathForTests(lang: LanguageId): string | undefined {
  return resolveGrammarWasmPath(lang);
}
