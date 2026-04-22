/**
 * Shared property-access extractor for TypeScript / TSX / JavaScript.
 *
 * All three languages use the same member-expression surface syntax and the
 * same assignment operators. This module wires the generic walker in
 * `extract/property-access.ts` to that dialect and converts the walker's
 * output into {@link PropertyAccess} records anchored to the enclosing
 * Function / Method / Constructor's `NodeId`.
 */

import {
  TS_ACCESS_CONFIG,
  extractPropertyAccesses as walkPropertyAccesses,
} from "../extract/property-access.js";
import { idForDefinition } from "./definition-ids.js";
import type { ExtractedDefinition, PropertyAccess } from "./extraction-types.js";
import type { ExtractionContext } from "./types.js";

/** Entry point wired into TS, TSX, and JS provider objects. */
export function extractTsFamilyPropertyAccesses(
  input: ExtractionContext,
): readonly PropertyAccess[] {
  return walkForDefs(input.filePath, input.sourceText, input.definitions);
}

function walkForDefs(
  filePath: string,
  sourceText: string,
  definitions: readonly ExtractedDefinition[],
): readonly PropertyAccess[] {
  const enclosing = definitions
    .filter((d) => d.kind === "Function" || d.kind === "Method" || d.kind === "Constructor")
    .map((d) => ({
      id: idForDefinition(d) as string,
      startLine: d.startLine,
      endLine: d.endLine,
      qualifiedName: d.qualifiedName,
    }));
  return walkPropertyAccesses(filePath, sourceText, enclosing, TS_ACCESS_CONFIG);
}
