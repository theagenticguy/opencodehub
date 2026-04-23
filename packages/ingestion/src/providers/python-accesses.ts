/**
 * Python-specific property-access extractor. Separate from the TS family so
 * Python-only operators (`:=`, `//=`, etc.) are handled without perturbing
 * the TS rules. Attribute access shape (`a.b`) is identical.
 */

import {
  PYTHON_ACCESS_CONFIG,
  extractPropertyAccesses as walkPropertyAccesses,
} from "../extract/property-access.js";
import { idForDefinition } from "./definition-ids.js";
import type { ExtractedDefinition, PropertyAccess } from "./extraction-types.js";
import type { ExtractionContext } from "./types.js";

export function extractPyPropertyAccesses(input: ExtractionContext): readonly PropertyAccess[] {
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
  return walkPropertyAccesses(filePath, sourceText, enclosing, PYTHON_ACCESS_CONFIG);
}
