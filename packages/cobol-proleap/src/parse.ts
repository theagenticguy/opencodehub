/**
 * `parseCobolDeep()` stub — real subprocess wiring lands in commit 2,
 * crash/fallback wiring in commit 4.
 *
 * The scaffolding commit returns an empty result so callers have a stable
 * shape to program against.
 */

import type { CobolDeepResult, ParseCobolDeepOptions } from "./types.js";

export async function parseCobolDeep(
  _paths: readonly string[],
  _opts: ParseCobolDeepOptions,
): Promise<CobolDeepResult> {
  return {
    elements: [],
    diagnostics: [],
    fellBackToRegex: false,
  };
}
