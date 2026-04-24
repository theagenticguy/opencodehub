/**
 * Shared types for the parse subsystem.
 *
 * These are the cross-boundary shapes exchanged between the main thread,
 * the piscina worker pool, and downstream symbol-extraction code.
 *
 * All positions are normalized to 1-indexed line numbers and 0-indexed
 * column offsets (matching most editor UIs).
 */

// `LanguageId` has a single source of truth in `@opencodehub/core-types`;
// every in-tree consumer re-exports from the same symbol. Keeping the
// re-export here lets existing imports from `../parse/types.js` keep
// working without a churn pass on every call site.
import type { LanguageId } from "@opencodehub/core-types";
export type { LanguageId } from "@opencodehub/core-types";

/** A single tagged node extracted from a parse tree by the unified query. */
export interface ParseCapture {
  /** Capture tag, e.g. `definition.class`, `reference.call`, `name`, `doc`. */
  readonly tag: string;
  /** Text slice the capture refers to (identifier name, snippet, etc.). */
  readonly text: string;
  /** 1-indexed line where the capture starts. */
  readonly startLine: number;
  /** 1-indexed line where the capture ends. */
  readonly endLine: number;
  /** 0-indexed column offset where the capture starts. */
  readonly startCol: number;
  /** 0-indexed column offset where the capture ends. */
  readonly endCol: number;
  /** Underlying tree-sitter node type — useful for debugging queries. */
  readonly nodeType: string;
}

/** Result of parsing a single file. */
export interface ParseResult {
  readonly filePath: string;
  readonly language: LanguageId;
  readonly captures: readonly ParseCapture[];
  readonly byteLength: number;
  readonly parseTimeMs: number;
  readonly warnings?: readonly string[];
}

/** Request to parse a single file. */
export interface ParseTask {
  readonly filePath: string;
  /** Raw file bytes — avoids a UTF-8 round-trip in the worker. */
  readonly content: Buffer;
  readonly language: LanguageId;
}

/** A batch of parse tasks sent to a single worker invocation. */
export interface ParseBatch {
  readonly tasks: readonly ParseTask[];
}
