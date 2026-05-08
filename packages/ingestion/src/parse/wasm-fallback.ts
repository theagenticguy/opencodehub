/**
 * WASM parser opener (default runtime) + native-availability probe.
 *
 * WASM is the default parse runtime as of Node 24 / M5. The native
 * `tree-sitter` N-API addon is still fully supported and is opt-in via
 * `OCH_NATIVE_PARSER=1` (or `--native-parser` on the CLI) — useful on
 * Node 22 developer boxes where native parsing is measurably faster.
 * Exotic environments (musl-libc Alpine, Cloudflare Workers, sandboxed
 * Electron renderers, AWS Lambda ARM64 custom runtimes, restricted CI)
 * can't load `.node` addons at all; on those hosts the default WASM
 * path Just Works and `isNativeAvailable()` returns false.
 *
 * `openWasmParser(lang)` lazily initializes the web-tree-sitter runtime
 * once per process and resolves the grammar WASM from the installed
 * `tree-sitter-<lang>` package. Per-grammar cache means repeated calls
 * are O(1).
 *
 * Query execution uses the same unified S-expression bodies from
 * `unified-queries.ts`; the parse-phase consumer receives byte-
 * identical ParseCapture output whether the runtime was native or WASM
 * (asserted by the parity test in `wasm-parity.test.ts`).
 */

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LanguageId } from "./types.js";

const requireFn = createRequire(import.meta.url);

// Resolve packages/ingestion/vendor/wasms/ relative to this module regardless
// of whether we're running from src/ (ts-node-style) or dist/ (compiled).
// `vendor/` lives at the package root, so we walk up from the file's dirname
// until we find it. Computed once at module load.
const VENDOR_WASMS_DIR = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src → <pkg>/src/parse; dist → <pkg>/dist/parse — both 2 levels up
  return path.resolve(here, "..", "..", "vendor", "wasms");
})();

let cached: boolean | undefined;

/**
 * Returns true when `require('tree-sitter')` succeeds in the current process.
 * Result is cached — subsequent calls are O(1).
 *
 * Call this at worker startup rather than on every parse.
 */
export function isNativeAvailable(): boolean {
  if (cached !== undefined) {
    return cached;
  }
  try {
    requireFn("tree-sitter");
    cached = true;
  } catch {
    cached = false;
  }
  return cached;
}

/**
 * For tests and diagnostics: reset the cached detection result.
 */
export function resetNativeAvailabilityCache(): void {
  cached = undefined;
}

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
    const Parser = runtime.Parser as unknown as new () => WasmParserInstance;
    const parser = new Parser();
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
 */
async function ensureWasmRuntime(): Promise<WasmRuntime | undefined> {
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
      await mod.Parser.init();
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
 * Resolve the `.wasm` grammar asset for `lang`. Two-stage cascade:
 *
 * 1. Per-grammar-package lookup — for the 11 languages whose
 *    `tree-sitter-<lang>` npm package ships its own `.wasm` alongside
 *    the `.node` addon (typescript, tsx, javascript, python, go, rust,
 *    java, csharp, c, cpp, ruby, php).
 * 2. Vendored-WASM fallback — for kotlin, swift, and dart, whose
 *    per-grammar packages do NOT ship a `.wasm`. We build these once
 *    from the same grammar sources npm pins (zero drift) and commit
 *    them to `packages/ingestion/vendor/wasms/`. See
 *    `scripts/build-vendor-wasms.sh` and `vendor/wasms/README.md`.
 *
 * Returns `undefined` when neither stage resolves (package not
 * installed, or language not in either table).
 */
function resolveGrammarWasmPath(lang: LanguageId): string | undefined {
  const direct = tryPerGrammarPackage(lang);
  if (direct !== undefined) return direct;
  return tryVendoredWasm(lang);
}

/**
 * Stage 1: resolve a `.wasm` that ships inside the per-grammar
 * `tree-sitter-<lang>` npm package. Returns `undefined` when the
 * language has no entry in this table or the package is not installed.
 */
function tryPerGrammarPackage(lang: LanguageId): string | undefined {
  // `tree-sitter-typescript` ships two wasms in one package — select by
  // language variant.
  if (lang === "typescript" || lang === "tsx") {
    const pkgDir = resolvePackageDir("tree-sitter-typescript");
    if (pkgDir === undefined) return undefined;
    const fname = lang === "typescript" ? "tree-sitter-typescript.wasm" : "tree-sitter-tsx.wasm";
    return path.join(pkgDir, fname);
  }
  const mapping: Partial<Record<LanguageId, { pkg: string; file: string }>> = {
    javascript: { pkg: "tree-sitter-javascript", file: "tree-sitter-javascript.wasm" },
    python: { pkg: "tree-sitter-python", file: "tree-sitter-python.wasm" },
    go: { pkg: "tree-sitter-go", file: "tree-sitter-go.wasm" },
    rust: { pkg: "tree-sitter-rust", file: "tree-sitter-rust.wasm" },
    java: { pkg: "tree-sitter-java", file: "tree-sitter-java.wasm" },
    // c-sharp publishes `tree-sitter-c_sharp.wasm` (underscore, not hyphen).
    csharp: { pkg: "tree-sitter-c-sharp", file: "tree-sitter-c_sharp.wasm" },
    c: { pkg: "tree-sitter-c", file: "tree-sitter-c.wasm" },
    cpp: { pkg: "tree-sitter-cpp", file: "tree-sitter-cpp.wasm" },
    ruby: { pkg: "tree-sitter-ruby", file: "tree-sitter-ruby.wasm" },
    // Use php_only (pure PHP, no HTML template injection) to match native loader (grammar-registry.ts:244-254).
    php: { pkg: "tree-sitter-php", file: "tree-sitter-php_only.wasm" },
  };
  const entry = mapping[lang];
  if (entry === undefined) return undefined;
  const pkgDir = resolvePackageDir(entry.pkg);
  if (pkgDir === undefined) return undefined;
  return path.join(pkgDir, entry.file);
}

/**
 * Stage 2: resolve from the vendored WASM directory at
 * `packages/ingestion/vendor/wasms/`. Only opted-in for languages whose
 * per-grammar npm package does NOT ship a `.wasm` — kotlin, swift, dart.
 *
 * These are built once from the same grammar sources our package.json
 * pins (zero version drift vs native) and committed to the repo. The
 * upstream `tree-sitter-wasms` catalog can't be used because its 0.1.13
 * artifacts were built with tree-sitter-cli 0.20.x and ship the legacy
 * `dylink` section, which web-tree-sitter 0.26+ refuses to load (it
 * requires the standardized `dylink.0` section).
 *
 * Keep this table minimal — adding a language here is a deliberate
 * architectural choice. See `scripts/build-vendor-wasms.sh`.
 */
function tryVendoredWasm(lang: LanguageId): string | undefined {
  const catalog: Partial<Record<LanguageId, string>> = {
    kotlin: "tree-sitter-kotlin.wasm",
    swift: "tree-sitter-swift.wasm",
    dart: "tree-sitter-dart.wasm",
  };
  const fname = catalog[lang];
  if (fname === undefined) return undefined;
  return path.join(VENDOR_WASMS_DIR, fname);
}

function resolvePackageDir(pkgName: string): string | undefined {
  try {
    const manifestPath = requireFn.resolve(`${pkgName}/package.json`);
    return path.dirname(manifestPath);
  } catch {
    return undefined;
  }
}

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
 * the two-stage cascade (per-grammar package → tree-sitter-wasms
 * catalog) resolves kotlin/swift/dart correctly. Not part of the public
 * API — callers in production paths must go through `openWasmParser`.
 */
export function _resolveGrammarWasmPathForTests(lang: LanguageId): string | undefined {
  return resolveGrammarWasmPath(lang);
}
