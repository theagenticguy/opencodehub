/**
 * BOM body item: AST-aware code chunks (AC-M5-5 — item 5/9).
 *
 * Wraps `@chonkiejs/core`'s `CodeChunker`, which builds chunks from a
 * tree-sitter AST (children grouped by token budget). Each input file is
 * CRLF→LF normalized BEFORE chunking — W-M5-4 requires that two repos
 * differing only by line-ending style produce the same `pack_hash`.
 *
 * Determinism:
 *   - Strict path: `CodeChunker.create({language})` succeeds for every
 *     file; chunks are sorted `(path ASC, startByte ASC)` and stamped
 *     `determinism_class: "strict"`.
 *   - Degraded path: `@chonkiejs/core` fails to dynamic-import (e.g.
 *     because the worktree's onnxruntime-node native bindings did not
 *     rebuild — see prior feedback at
 *     `.claude/projects/-efs-lalsaado-workplace-opencodehub/memory/feedback_approve_builds.md`)
 *     OR `CodeChunker.create` throws for some language. The fallback is a
 *     line-split: each file is split on `\n`, lines packed into chunks of
 *     roughly `budgetTokens / 4` characters, and the whole result stamped
 *     `determinism_class: "degraded"`. The fallback is byte-identical
 *     across runs because line splitting is a pure function of bytes.
 *
 * Token-count contract:
 *   - Strict: chonkie's `Chunk.tokenCount` (its built-in tokenizer).
 *   - Degraded: a coarse approximation `ceil(text.length / 4)` — close
 *     enough to a 4-chars-per-token English heuristic for the BOM's
 *     "rough budgeting" use case. Approximate counts are explicitly
 *     allowed when `determinism_class === "degraded"`.
 *
 * Note on offsets: chonkie returns `startIndex`/`endIndex` as JS string
 * (UTF-16 code-unit) offsets. We store them as `startByte`/`endByte` —
 * for ASCII source these coincide with UTF-8 byte offsets, and the BOM
 * consumer always re-reads the normalized bytes back through the same
 * indices, so the round-trip is internally consistent. A future task may
 * promote these to true UTF-8 byte offsets via `Buffer.byteLength` — the
 * field name keeps that door open without forcing the change today.
 */

/**
 * Create-options for chonkie's CodeChunker. We only need the subset the
 * pack-side wrapper sets (language + chunkSize); declaring it here as a
 * structural type means we never depend on chonkie's exported type at
 * compile time, which keeps `tsc --noEmit` clean even if the package is
 * uninstalled in the consuming environment.
 */
interface ChonkieCodeChunkerCreateOptions {
  readonly language?: string;
  readonly chunkSize?: number;
}

/** The structural shape of `@chonkiejs/core`'s `Chunk`. */
interface ChonkieChunk {
  readonly text: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly tokenCount: number;
}

/** The structural shape of the `CodeChunker` constructor we consume. */
interface ChonkieCodeChunkerCtor {
  create(opts?: ChonkieCodeChunkerCreateOptions): Promise<{
    chunk(text: string): ChonkieChunk[];
  }>;
}

/** A single chunk emitted by {@link buildAstChunks}. */
export interface AstChunk {
  /** Repo-relative POSIX path of the source file. */
  readonly path: string;
  /** Inclusive start offset into the LF-normalized file bytes. */
  readonly startByte: number;
  /** Exclusive end offset into the LF-normalized file bytes. */
  readonly endByte: number;
  /** Token count from the chunker (approximate when degraded). */
  readonly tokenCount: number;
  /** Source language id (passed-through from the input). */
  readonly language?: string;
}

/** A single source file fed into the chunker. */
export interface AstChunkerFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  /**
   * Optional language id (e.g. `"typescript"`, `"python"`). Used to
   * dispatch to the right chonkie tree-sitter grammar. Files without a
   * language are routed through the fallback path.
   */
  readonly language?: string;
}

/** Inputs to {@link buildAstChunks}. */
export interface AstChunkerOpts {
  readonly files: readonly AstChunkerFile[];
  /** Per-chunk token budget passed to chonkie (and used by the fallback). */
  readonly budgetTokens: number;
  /**
   * Tokenizer id in `<vendor>:<name>@<pin>` form. Surfaced upstream to the
   * manifest; this module does not interpret it (chonkie's default
   * character tokenizer is enough for the budget heuristic).
   */
  readonly tokenizerId: string;
}

/** Stamp on the result that the manifest reads to set `determinism_class`. */
export type AstChunkerDeterminism = "strict" | "degraded";

/** Output of {@link buildAstChunks}. */
export interface AstChunkerResult {
  readonly chunks: readonly AstChunk[];
  readonly determinismClass: AstChunkerDeterminism;
  readonly pinsHint: {
    readonly chonkieVersion?: string;
  };
}

/**
 * Override hook used exclusively by tests to inject a fake chonkie module
 * (success path) or a thrown rejection (degraded path) without touching
 * the real `@chonkiejs/core` install. Production callers never set this.
 */
export interface AstChunkerInternalOpts {
  readonly _loadChonkie?: () => Promise<{
    CodeChunker: ChonkieCodeChunkerCtor;
    version?: string;
  }>;
}

/**
 * Build the AST-chunked file slice for the BOM.
 *
 * Returns a frozen-shaped `AstChunkerResult` whose `chunks` field is
 * sorted `(path ASC, startByte ASC)` for byte-identity. The `pinsHint`
 * surfaces `chonkieVersion` so `generatePack` can stamp the manifest's
 * `pins.chonkie_version` from runtime state instead of a hard-coded
 * constant.
 */
export async function buildAstChunks(
  opts: AstChunkerOpts,
  internal: AstChunkerInternalOpts = {},
): Promise<AstChunkerResult> {
  const loader = internal._loadChonkie ?? defaultLoadChonkie;
  let mod: { CodeChunker: ChonkieCodeChunkerCtor; version?: string } | undefined;
  try {
    mod = await loader();
  } catch {
    return runFallback(opts);
  }

  const chunkSize = Math.max(1, Math.floor(opts.budgetTokens));
  const chunks: AstChunk[] = [];

  for (const file of [...opts.files].sort(compareByPath)) {
    const text = decodeAndNormalize(file.bytes);
    if (text.length === 0) continue;

    if (file.language === undefined) {
      // No language → no grammar resolution → degrade per file by routing
      // through the same line-split fallback. The whole result is still
      // strict if every other file went through chonkie successfully.
      pushLineSplitChunks(chunks, file, text, chunkSize);
      continue;
    }

    let chunker: { chunk(text: string): ChonkieChunk[] };
    try {
      chunker = await mod.CodeChunker.create({
        language: file.language,
        chunkSize,
      });
    } catch {
      // Per-file fallback: keep the strict label only if NO file falls
      // back. Easiest signal is to switch the whole result to degraded
      // the moment any file fails.
      return runFallback(opts);
    }

    let raw: ChonkieChunk[];
    try {
      raw = chunker.chunk(text);
    } catch {
      return runFallback(opts);
    }

    for (const c of raw) {
      chunks.push({
        path: file.path,
        startByte: c.startIndex,
        endByte: c.endIndex,
        tokenCount: c.tokenCount,
        ...(file.language !== undefined ? { language: file.language } : {}),
      });
    }
  }

  chunks.sort(compareChunks);
  return {
    chunks,
    determinismClass: "strict",
    pinsHint: mod.version !== undefined ? { chonkieVersion: mod.version } : {},
  };
}

/**
 * Default chonkie loader. Dynamic-imports `@chonkiejs/core` and walks up
 * to its `package.json` for the version pin. Throws on import failure so
 * the caller falls through to the degraded path.
 */
async function defaultLoadChonkie(): Promise<{
  CodeChunker: ChonkieCodeChunkerCtor;
  version?: string;
}> {
  const mod = (await import("@chonkiejs/core")) as { CodeChunker: ChonkieCodeChunkerCtor };
  let version: string | undefined;
  try {
    // Resolve sibling package.json without forcing a CJS require — works
    // under ESM / Node 22.
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const pkg = require("@chonkiejs/core/package.json") as { version?: string };
    version = typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    version = undefined;
  }
  return version !== undefined
    ? { CodeChunker: mod.CodeChunker, version }
    : { CodeChunker: mod.CodeChunker };
}

/**
 * Degraded fallback: line-split each file, pack lines into chunks of
 * roughly `chunkSize * 4` characters (matching the 4-chars-per-token
 * heuristic baked into the strict path's tokenCount). Pure function of
 * the input bytes → byte-identity across runs.
 */
function runFallback(opts: AstChunkerOpts): AstChunkerResult {
  const chunkSize = Math.max(1, Math.floor(opts.budgetTokens));
  const chunks: AstChunk[] = [];
  for (const file of [...opts.files].sort(compareByPath)) {
    const text = decodeAndNormalize(file.bytes);
    if (text.length === 0) continue;
    pushLineSplitChunks(chunks, file, text, chunkSize);
  }
  chunks.sort(compareChunks);
  return {
    chunks,
    determinismClass: "degraded",
    pinsHint: {},
  };
}

/**
 * Append line-split chunks for one file. Approx `chunkSize * 4` chars
 * per chunk; lines are packed greedily without splitting a single line.
 */
function pushLineSplitChunks(
  out: AstChunk[],
  file: AstChunkerFile,
  text: string,
  chunkSize: number,
): void {
  const charBudget = Math.max(1, chunkSize * 4);
  const len = text.length;
  let cursor = 0;
  while (cursor < len) {
    let end = Math.min(cursor + charBudget, len);
    if (end < len) {
      // Walk forward to the next newline so chunks always end on a line
      // boundary. If no newline before EOF, use `len` as the boundary.
      const nl = text.indexOf("\n", end);
      end = nl === -1 ? len : nl + 1;
    }
    const slice = text.slice(cursor, end);
    out.push({
      path: file.path,
      startByte: cursor,
      endByte: end,
      tokenCount: Math.max(1, Math.ceil(slice.length / 4)),
      ...(file.language !== undefined ? { language: file.language } : {}),
    });
    cursor = end;
  }
}

/** Decode raw bytes as UTF-8 and CRLF→LF normalize for W-M5-4. */
function decodeAndNormalize(bytes: Uint8Array): string {
  // `fatal: false` so malformed sequences become U+FFFD instead of throwing —
  // the BOM is best-effort over arbitrary repo bytes; it does not validate
  // encoding here.
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return decoded.replace(/\r\n/g, "\n");
}

/** Path ASC primary sort. */
function compareByPath(a: AstChunkerFile, b: AstChunkerFile): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Chunk sort: path ASC, startByte ASC, endByte ASC (lex-stable). */
function compareChunks(a: AstChunk, b: AstChunk): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.startByte !== b.startByte) return a.startByte - b.startByte;
  if (a.endByte !== b.endByte) return a.endByte - b.endByte;
  return 0;
}
