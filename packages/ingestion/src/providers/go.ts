import type { NodeKind } from "@opencodehub/core-types";
import {
  getLine,
  innermostEnclosingDef,
  isInside,
  pairDefinitionsWithNames,
  stripComments,
} from "./extract-helpers.js";
import type {
  ExtractedCall,
  ExtractedDefinition,
  ExtractedHeritage,
  ExtractedImport,
} from "./extraction-types.js";
import { detectHttpCallsGo } from "./http-detect.js";
import type {
  ExtractCallsInput,
  ExtractDefinitionsInput,
  ExtractHeritageInput,
  ExtractImportsInput,
  LanguageProvider,
} from "./types.js";

/**
 * Go provider.
 *
 * Definitions: functions, struct/interface types, methods (with receiver
 * syntax), package-level constants. Qualified names for methods use the
 * receiver type (e.g. `MyStruct.Do`) to mirror Go's dispatch-by-type.
 *
 * Exports: Go is unique among the seven — a top-level identifier is
 * exported iff it starts with an uppercase letter. We reuse that rule for
 * methods too.
 *
 * Heritage: Go has no class inheritance. Interface satisfaction is
 * structural and needs a type checker to resolve — at MVP we emit no
 * heritage edges.
 */

const GO_DEF_KIND_MAP: Readonly<Record<string, NodeKind>> = {
  "definition.class": "Struct", // struct_type under the unified query
  "definition.interface": "Interface",
  "definition.function": "Function",
  "definition.method": "Method",
  "definition.constant": "Const",
  "definition.type": "TypeAlias",
  "definition.module": "Module",
};

function extractGoDefinitions(input: ExtractDefinitionsInput): readonly ExtractedDefinition[] {
  const { filePath, captures, sourceText } = input;
  const paired = pairDefinitionsWithNames(captures);
  const defCaptures = captures.filter((c) => c.tag.startsWith("definition."));

  // The Go unified query emits both `@definition.type` and either
  // `@definition.class` (struct) or `@definition.interface` for the same
  // source range — a type_declaration wrapping a struct/interface. Drop
  // the TypeAlias record when a more specific kind exists at the same
  // position so the graph has one node per type, not two.
  const specificPositions = new Set<string>();
  for (const { def } of paired) {
    if (def.tag === "definition.class" || def.tag === "definition.interface") {
      specificPositions.add(`${def.startLine}:${def.startCol}`);
    }
  }

  const out: ExtractedDefinition[] = [];
  for (const { def, name } of paired) {
    const kind = GO_DEF_KIND_MAP[def.tag];
    if (kind === undefined) continue;
    if (
      def.tag === "definition.type" &&
      specificPositions.has(`${def.startLine}:${def.startCol}`)
    ) {
      continue;
    }

    let owner: string | undefined;
    if (def.tag === "definition.method") {
      // `func (r *Receiver) Method(...)` — parse the receiver type off the
      // header. We strip leading `*` for pointer receivers.
      owner = readGoReceiverType(getLine(sourceText, def.startLine));
    } else {
      const ownerDef = innermostEnclosingDef(def, defCaptures);
      if (ownerDef !== undefined) {
        const ownerPaired = paired.find((p) => p.def === ownerDef);
        if (ownerPaired !== undefined) owner = ownerPaired.name.text;
      }
    }

    const qualifiedName = owner !== undefined ? `${owner}.${name.text}` : name.text;
    const isExported = /^[A-Z]/.test(name.text);

    const rec: ExtractedDefinition = {
      kind,
      name: name.text,
      qualifiedName,
      filePath,
      startLine: def.startLine,
      endLine: def.endLine,
      isExported,
      ...(owner !== undefined ? { owner } : {}),
    };
    out.push(rec);
  }
  return out;
}

function readGoReceiverType(headerLine: string): string | undefined {
  // Accepts `func (r *Foo) Bar(...)`, `func (Foo) Bar(...)`, and generic
  // variants like `func (r *Foo[T]) Bar(...)`.
  const m = /^\s*func\s*\(\s*(?:[A-Za-z_][\w]*\s+)?\*?([A-Za-z_][\w]*)/.exec(headerLine);
  if (m === null) return undefined;
  return m[1];
}

function extractGoCalls(input: ExtractCallsInput): readonly ExtractedCall[] {
  const { filePath, captures, definitions } = input;
  const defCaptures = captures.filter((c) => c.tag.startsWith("definition."));
  const callRefs = captures.filter((c) => c.tag === "reference.call");
  const out: ExtractedCall[] = [];

  for (const ref of callRefs) {
    const innerName = findNameInside(captures, ref);
    const calleeName = innerName?.text ?? ref.text;

    const enclosingDef = innermostEnclosingDef(ref, defCaptures);
    const callerQualifiedName = enclosingDef
      ? qualifiedForCapture(enclosingDef, definitions)
      : "<module>";

    // Receiver inference: `pkg.Func(...)` or `recv.Method(...)`. When the
    // grammar matched `selector_expression`, `ref.text` begins with the
    // selector source.
    let receiver: string | undefined;
    if (innerName !== undefined) {
      const idx = ref.text.lastIndexOf(`.${innerName.text}`);
      if (idx > 0) {
        const prefix = ref.text.slice(0, idx).trim();
        if (prefix !== "" && /^[A-Za-z_][\w.]*$/.test(prefix)) receiver = prefix;
      }
    }

    out.push({
      callerQualifiedName,
      calleeName,
      filePath,
      startLine: ref.startLine,
      ...(receiver !== undefined ? { calleeOwner: receiver } : {}),
    });
  }
  return out;
}

function findNameInside(
  captures: readonly import("../parse/types.js").ParseCapture[],
  outer: import("../parse/types.js").ParseCapture,
): import("../parse/types.js").ParseCapture | undefined {
  let best: import("../parse/types.js").ParseCapture | undefined;
  for (const c of captures) {
    if (c.tag !== "name") continue;
    if (!isInside(c, outer)) continue;
    if (best === undefined || c.startLine < best.startLine) best = c;
  }
  return best;
}

function qualifiedForCapture(
  def: import("../parse/types.js").ParseCapture,
  definitions: readonly ExtractedDefinition[],
): string {
  for (const d of definitions) {
    if (d.startLine === def.startLine) return d.qualifiedName;
  }
  return "<module>";
}

/**
 * Parse Go imports. Covers:
 *   `import "fmt"`
 *   `import f "fmt"` (aliased)
 *   `import . "fmt"` (dot-import)
 *   `import _ "fmt"` (blank-import)
 *   `import ( "a"; f "fmt"; . "b" )` (grouped)
 */
function extractGoImports(input: ExtractImportsInput): readonly ExtractedImport[] {
  const { filePath, sourceText } = input;
  const stripped = stripComments(sourceText);
  const out: ExtractedImport[] = [];

  // Match single-line imports and the grouped block.
  const singleRe = /^\s*import\s+(?:([A-Za-z_.][\w]*)\s+)?"([^"]+)"\s*$/gm;
  for (const m of stripped.matchAll(singleRe)) {
    const alias = m[1];
    const source = m[2] as string;
    out.push({
      filePath,
      source,
      kind: "package-wildcard",
      ...(alias !== undefined ? { localAlias: alias } : {}),
    });
  }

  // Grouped: `import ( ... )`. Match balanced parens line by line.
  const groupRe = /^\s*import\s*\(([\s\S]*?)\)\s*$/gm;
  for (const g of stripped.matchAll(groupRe)) {
    const body = g[1] as string;
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      const entry = /^(?:([A-Za-z_.][\w]*)\s+)?"([^"]+)"\s*$/.exec(trimmed);
      if (entry === null) continue;
      const alias = entry[1];
      const source = entry[2] as string;
      out.push({
        filePath,
        source,
        kind: "package-wildcard",
        ...(alias !== undefined ? { localAlias: alias } : {}),
      });
    }
  }

  return out;
}

function extractGoHeritage(_input: ExtractHeritageInput): readonly ExtractedHeritage[] {
  // Go has struct embedding and interface satisfaction but no explicit
  // hierarchy edges. Accurately modelling "T implements I" requires a
  // type checker that compares method sets — deferred past MVP.
  return [];
}

export const goProvider: LanguageProvider = {
  id: "go",
  extensions: [".go"],
  importSemantics: "package-wildcard",
  mroStrategy: "none",
  typeConfig: { structural: true, nominal: true, generics: true },
  heritageEdge: null,
  isExportedIdentifier: (name) => /^[A-Z]/.test(name),

  extractDefinitions: extractGoDefinitions,
  extractCalls: extractGoCalls,
  extractImports: extractGoImports,
  isExported: (def) => def.isExported,
  extractHeritage: extractGoHeritage,
  detectOutboundHttp: ({ sourceText }) => detectHttpCallsGo(sourceText),
};
