/**
 * Native vs WASM runtime detection + WASM parser opener.
 *
 * The native `tree-sitter` npm binding loads a `.node` addon. Exotic
 * environments (musl-libc Alpine, Cloudflare Workers, sandboxed Electron
 * renderers, AWS Lambda ARM64 custom runtimes, restricted CI) cannot
 * load `.node` addons — we fall back to the `web-tree-sitter` WASM
 * runtime plus each grammar's per-package `.wasm` artifact.
 *
 * `openWasmParser(lang)` lazily initializes the web-tree-sitter runtime
 * once per process and resolves the grammar WASM from the installed
 * `tree-sitter-<lang>` package. Per-grammar cache means repeated calls
 * are O(1).
 *
 * Query execution uses the same unified S-expression bodies from
 * `unified-queries.ts`; the parse-phase consumer receives byte-
 * identical ParseCapture output whether the runtime was native or WASM
 * (asserted by the parity test in `worker-pool.test.ts`).
 */

import { createRequire } from "node:module";
import path from "node:path";
import type { LanguageId } from "./types.js";

const requireFn = createRequire(import.meta.url);

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
 * Resolve the `.wasm` grammar asset shipped with each
 * `tree-sitter-<lang>` package. Returns `undefined` when the grammar
 * package is not installed or doesn't ship a `.wasm`.
 */
function resolveGrammarWasmPath(lang: LanguageId): string | undefined {
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
    php: { pkg: "tree-sitter-php", file: "tree-sitter-php.wasm" },
  };
  const entry = mapping[lang];
  if (entry === undefined) return undefined;
  const pkgDir = resolvePackageDir(entry.pkg);
  if (pkgDir === undefined) return undefined;
  return path.join(pkgDir, entry.file);
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
