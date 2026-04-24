/**
 * Shared test helpers for provider behavior tests.
 *
 * Spins up a ParsePool, dispatches a single in-memory fixture, and hands
 * back the captures so each per-language test file can feed them into its
 * provider's extract* methods.
 *
 * NOTE: This file is only imported from `*.test.ts` files. Putting it in
 * `src/` keeps the ambient typing simple (vs. a separate `test/` tree).
 */

import { Buffer } from "node:buffer";
import type { LanguageId, ParseCapture, ParseTask } from "../parse/types.js";
import type { ParsePool } from "../parse/worker-pool.js";

export interface ParsedFixture {
  readonly filePath: string;
  readonly sourceText: string;
  readonly captures: readonly ParseCapture[];
}

/**
 * Parse a single source-text fixture and return its captures.
 * Caller owns pool lifecycle (pass one in from the test's top-level
 * `before()` / `after()` hooks to amortize worker spin-up cost).
 */
export async function parseFixture(
  pool: ParsePool,
  language: LanguageId,
  filePath: string,
  sourceText: string,
): Promise<ParsedFixture> {
  const task: ParseTask = {
    filePath,
    content: Buffer.from(sourceText, "utf8"),
    language,
  };
  const [result] = await pool.dispatch([task]);
  if (result === undefined) {
    throw new Error(`parseFixture: no result returned for ${filePath}`);
  }
  return {
    filePath,
    sourceText,
    captures: result.captures,
  };
}
