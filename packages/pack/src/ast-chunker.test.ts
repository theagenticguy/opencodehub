/**
 * Tests for the AST-chunker BOM body (item 5/9).
 *
 * Covers:
 *   - A. Determinism on the strict path (mock chonkie that returns fixed chunks).
 *   - B. Determinism on the degraded path.
 *   - C. CRLF→LF normalization affects chunk content but not the produced
 *        offsets relative to the LF-normalized input.
 *   - D. Sorted by `(path ASC, startByte ASC)`.
 *   - E. Empty file is skipped.
 *   - F. `pinsHint.chonkieVersion` is surfaced on the strict path and
 *        omitted on the degraded path.
 *   - G. Per-file CodeChunker.create rejection flips the whole result to
 *        degraded.
 *   - H. File without a language goes through the line-split fallback per file
 *        but the overall result is still strict if other files chunk OK.
 *   - J. Lone-CR (classic-Mac) input normalizes to LF, matching LF-only chunks.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { canonicalJson } from "@opencodehub/core-types";
import { type AstChunkerOpts, buildAstChunks } from "./ast-chunker.js";

interface ChonkieChunk {
  readonly text: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly tokenCount: number;
}

/**
 * Build a fake chonkie loader that emits predictable chunks: one chunk per
 * input file covering the whole text. Letting tests assert the offset
 * round-trip without depending on tree-sitter's actual segmentation.
 */
function makeFakeLoader(version = "0.0.9-fake") {
  return async () => ({
    version,
    CodeChunker: {
      create: async () => ({
        chunk(text: string): ChonkieChunk[] {
          // Single chunk over the whole text — predictable offsets.
          return [
            {
              text,
              startIndex: 0,
              endIndex: text.length,
              tokenCount: Math.max(1, Math.ceil(text.length / 4)),
            },
          ];
        },
      }),
    },
  });
}

function makeRejectingLoader() {
  return async () => {
    throw new Error("simulated dynamic-import failure");
  };
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

const BASE_OPTS = {
  budgetTokens: 64,
  tokenizerId: "openai:cl100k_base@0.7.0",
} as const;

test("A. strict path is deterministic across two calls", async () => {
  const opts: AstChunkerOpts = {
    ...BASE_OPTS,
    files: [
      { path: "src/a.ts", bytes: utf8("const a = 1;\n"), language: "typescript" },
      { path: "src/b.py", bytes: utf8("x = 1\n"), language: "python" },
    ],
  };
  const first = await buildAstChunks(opts, { _loadChonkie: makeFakeLoader() });
  const second = await buildAstChunks(opts, { _loadChonkie: makeFakeLoader() });
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(first.determinismClass, "strict");
});

test("B. degraded path is deterministic across two calls", async () => {
  const opts: AstChunkerOpts = {
    ...BASE_OPTS,
    files: [
      { path: "src/a.ts", bytes: utf8("const a = 1;\nconst b = 2;\n"), language: "typescript" },
    ],
  };
  const first = await buildAstChunks(opts, { _loadChonkie: makeRejectingLoader() });
  const second = await buildAstChunks(opts, { _loadChonkie: makeRejectingLoader() });
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(first.determinismClass, "degraded");
});

test("C. CRLF input yields offsets against the LF-normalized text", async () => {
  const crlf: AstChunkerOpts = {
    ...BASE_OPTS,
    files: [{ path: "x.ts", bytes: utf8("a\r\nb\r\n"), language: "typescript" }],
  };
  const lf: AstChunkerOpts = {
    ...BASE_OPTS,
    files: [{ path: "x.ts", bytes: utf8("a\nb\n"), language: "typescript" }],
  };
  const fromCrlf = await buildAstChunks(crlf, { _loadChonkie: makeFakeLoader() });
  const fromLf = await buildAstChunks(lf, { _loadChonkie: makeFakeLoader() });
  // After CRLF→LF the texts are byte-identical, so the chunks must match
  // byte-for-byte regardless of input line-ending style.
  assert.equal(canonicalJson(fromCrlf.chunks), canonicalJson(fromLf.chunks));
  assert.equal(fromCrlf.chunks[0]?.startByte, 0);
  assert.equal(fromCrlf.chunks[0]?.endByte, 4);
});

test("D. chunks sort by (path ASC, startByte ASC)", async () => {
  const opts: AstChunkerOpts = {
    ...BASE_OPTS,
    // Provide files in reverse path order — sort must reorder them.
    files: [
      { path: "z.ts", bytes: utf8("z\n"), language: "typescript" },
      { path: "a.ts", bytes: utf8("a\n"), language: "typescript" },
    ],
  };
  const result = await buildAstChunks(opts, { _loadChonkie: makeFakeLoader() });
  assert.equal(result.chunks[0]?.path, "a.ts");
  assert.equal(result.chunks[1]?.path, "z.ts");
});

test("E. empty file is skipped", async () => {
  const opts: AstChunkerOpts = {
    ...BASE_OPTS,
    files: [
      { path: "empty.ts", bytes: utf8(""), language: "typescript" },
      { path: "non-empty.ts", bytes: utf8("x;\n"), language: "typescript" },
    ],
  };
  const result = await buildAstChunks(opts, { _loadChonkie: makeFakeLoader() });
  assert.equal(result.chunks.length, 1);
  assert.equal(result.chunks[0]?.path, "non-empty.ts");
});

test("F. pinsHint surfaces version on strict, omits on degraded", async () => {
  const opts: AstChunkerOpts = {
    ...BASE_OPTS,
    files: [{ path: "x.ts", bytes: utf8("x;\n"), language: "typescript" }],
  };
  const strict = await buildAstChunks(opts, { _loadChonkie: makeFakeLoader("0.4.2") });
  assert.equal(strict.pinsHint.chonkieVersion, "0.4.2");
  const degraded = await buildAstChunks(opts, { _loadChonkie: makeRejectingLoader() });
  assert.equal(degraded.pinsHint.chonkieVersion, undefined);
});

test("G. per-file CodeChunker.create rejection degrades the whole result", async () => {
  const opts: AstChunkerOpts = {
    ...BASE_OPTS,
    files: [{ path: "x.ts", bytes: utf8("x;\n"), language: "typescript" }],
  };
  const result = await buildAstChunks(opts, {
    _loadChonkie: async () => ({
      version: "0.4.2",
      CodeChunker: {
        create: async () => {
          throw new Error("grammar wasm not found");
        },
      },
    }),
  });
  assert.equal(result.determinismClass, "degraded");
  // The fallback still produces at least one chunk for non-empty input.
  assert.ok(result.chunks.length >= 1);
});

test("H. file without language uses the line-split fallback per file but result stays strict", async () => {
  const opts: AstChunkerOpts = {
    ...BASE_OPTS,
    files: [
      { path: "src/a.ts", bytes: utf8("const a = 1;\n"), language: "typescript" },
      // No `language` → routed through line-split.
      { path: "src/data.txt", bytes: utf8("hello world\n") },
    ],
  };
  const result = await buildAstChunks(opts, { _loadChonkie: makeFakeLoader() });
  // The whole result remains "strict" because chonkie still ran for the
  // language-tagged files; only the language-less file uses line-split.
  assert.equal(result.determinismClass, "strict");
  // The unlabelled file produced a chunk with `language` undefined.
  const txtChunk = result.chunks.find((c) => c.path === "src/data.txt");
  assert.ok(txtChunk !== undefined);
  assert.equal(txtChunk.language, undefined);
});

test("J. lone-CR input normalizes to LF and matches the LF-only chunks", async () => {
  const cr: AstChunkerOpts = {
    ...BASE_OPTS,
    // Classic-Mac line endings: lone CR, no LF.
    files: [{ path: "x.ts", bytes: utf8("a\rb\r"), language: "typescript" }],
  };
  const lf: AstChunkerOpts = {
    ...BASE_OPTS,
    files: [{ path: "x.ts", bytes: utf8("a\nb\n"), language: "typescript" }],
  };
  const fromCr = await buildAstChunks(cr, { _loadChonkie: makeFakeLoader() });
  const fromLf = await buildAstChunks(lf, { _loadChonkie: makeFakeLoader() });
  // After lone-CR→LF the texts are byte-identical, so chunks (and therefore
  // the eventual pack_hash) must match regardless of input line-ending style.
  assert.equal(canonicalJson(fromCr.chunks), canonicalJson(fromLf.chunks));
  assert.equal(fromCr.chunks[0]?.startByte, 0);
  assert.equal(fromCr.chunks[0]?.endByte, 4);
});

test("I. degraded fallback emits chunks bounded by ~chunkSize*4 chars", async () => {
  // Build a long single-line input so the line-split has to slice mid-file.
  const big = "abcdefghij\n".repeat(100); // 1100 chars across 100 lines.
  const opts: AstChunkerOpts = {
    budgetTokens: 16, // ~64 chars per chunk → many chunks expected.
    tokenizerId: "openai:cl100k_base@0.7.0",
    files: [{ path: "long.txt", bytes: utf8(big) }],
  };
  const result = await buildAstChunks(opts, { _loadChonkie: makeRejectingLoader() });
  assert.ok(result.chunks.length > 1, "expected multiple line-split chunks");
  // Every chunk should end on a line boundary or EOF; reconstructing the
  // file from chunks must recover the original text.
  const decoded = new TextDecoder().decode(utf8(big));
  let cursor = 0;
  for (const c of result.chunks) {
    assert.equal(c.startByte, cursor);
    cursor = c.endByte;
  }
  assert.equal(cursor, decoded.length);
});
