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
import { detectHttpCallsPython } from "./http-detect.js";
import { extractPyPropertyAccesses } from "./python-accesses.js";
import type {
  ExtractCallsInput,
  ExtractDefinitionsInput,
  ExtractHeritageInput,
  ExtractImportsInput,
  LanguageProvider,
} from "./types.js";

/**
 * Python provider. `function_definition` in the grammar covers both top-level
 * functions and methods — we promote to `Method` when the definition is
 * nested inside a `class_definition`.
 *
 * Exports follow Python's convention: any name not prefixed with `_` is
 * visible to `from mod import *` (ignoring `__all__` at MVP).
 */

function extractPyDefinitions(input: ExtractDefinitionsInput): readonly ExtractedDefinition[] {
  const { filePath, captures, sourceText } = input;
  const paired = pairDefinitionsWithNames(captures);
  const defCaptures = captures.filter((c) => c.tag.startsWith("definition."));
  const out: ExtractedDefinition[] = [];

  // Class-body attributes may match TWO `definition.property` captures (the
  // typed `x: int = 0` pattern and the untyped `x = 0` pattern both fire
  // because the grammar sees the same assignment through both rules). Track
  // emitted ranges so we only produce one Property per source line.
  const propertyRanges = new Set<string>();
  for (const c of defCaptures) {
    if (c.tag !== "definition.property") continue;
    propertyRanges.add(`${c.startLine}:${c.startCol}:${c.endLine}:${c.endCol}`);
  }
  const emittedPropertyRanges = new Set<string>();

  for (const { def, name } of paired) {
    let kind: NodeKind;
    let owner: string | undefined;

    const ownerDef = innermostEnclosingDef(def, defCaptures);
    if (ownerDef !== undefined) {
      const ownerPaired = paired.find((p) => p.def === ownerDef);
      if (ownerPaired !== undefined) owner = ownerPaired.name.text;
    }

    if (def.tag === "definition.class") {
      kind = "Class";
    } else if (def.tag === "definition.function") {
      // Method when nested inside a class.
      kind = ownerDef?.tag === "definition.class" ? "Method" : "Function";
    } else if (def.tag === "definition.property") {
      const rangeKey = `${def.startLine}:${def.startCol}:${def.endLine}:${def.endCol}`;
      if (emittedPropertyRanges.has(rangeKey)) continue;
      emittedPropertyRanges.add(rangeKey);
      kind = "Property";
    } else if (def.tag === "definition.variable") {
      // Function-body locals. Safe to emit: the enclosing-scope CALLS filter
      // excludes Variable tags so locals can't steal call-edge ownership
      // from their enclosing Function/Method.
      kind = "Variable";
    } else if (def.tag === "definition.constant") {
      // Could be the module-level constant capture OR the untyped class-body
      // property capture. Discriminate by enclosing scope.
      const rangeKey = `${def.startLine}:${def.startCol}:${def.endLine}:${def.endCol}`;
      if (propertyRanges.has(rangeKey)) continue; // typed variant wins
      if (ownerDef?.tag === "definition.class") {
        kind = "Property";
      } else {
        kind = "Const";
      }
    } else {
      continue;
    }

    const qualifiedName = owner !== undefined ? `${owner}.${name.text}` : name.text;
    const headerLine = getLine(sourceText, def.startLine);
    const isExported = !name.text.startsWith("_");

    const rec: ExtractedDefinition = {
      kind,
      name: name.text,
      qualifiedName,
      filePath,
      startLine: def.startLine,
      endLine: def.endLine,
      isExported,
      ...(owner !== undefined ? { owner } : {}),
      ...(kind === "Const" ? { isConst: /^[A-Z_][A-Z0-9_]*\s*=/.test(headerLine.trim()) } : {}),
    };
    out.push(rec);
  }
  return out;
}

function extractPyCalls(input: ExtractCallsInput): readonly ExtractedCall[] {
  const { filePath, captures, definitions } = input;
  const defCaptures = captures.filter((c) => c.tag.startsWith("definition."));
  const callRefs = captures.filter((c) => c.tag === "reference.call");
  const out: ExtractedCall[] = [];

  for (const ref of callRefs) {
    const innerName = findNameInside(captures, ref);
    const calleeName = innerName?.text ?? ref.text;

    // Determine caller context: walk enclosing defs from innermost out.
    const enclosingDef = innermostEnclosingDef(ref, defCaptures);
    const callerQualifiedName = enclosingDef
      ? qualifiedForCapture(enclosingDef, definitions)
      : "<module>";

    // Receiver inference from the call expression's source text. The
    // `@reference.call` range covers the full call; when the grammar
    // matched `attribute.attribute`, `ref.text` is like `self.foo(x)`.
    const receiver = inferPyReceiver(ref, innerName);

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

function inferPyReceiver(
  ref: import("../parse/types.js").ParseCapture,
  name: import("../parse/types.js").ParseCapture | undefined,
): string | undefined {
  if (name === undefined) return undefined;
  const idx = ref.text.lastIndexOf(`.${name.text}`);
  if (idx <= 0) return undefined;
  const prefix = ref.text.slice(0, idx).trim();
  if (prefix === "") return undefined;
  if (/^[A-Za-z_][\w]*$/.test(prefix)) return prefix;
  return prefix;
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
 * Parse Python imports:
 *   `import X`                → namespace
 *   `import X as Y`           → namespace with alias
 *   `import X.Y.Z`            → namespace (dotted)
 *   `from X import a, b`      → named
 *   `from X import a as b`    → named with alias
 *   `from X import *`         → package-wildcard
 *   `from . import x`         → relative import (source begins `.`)
 */
function extractPyImports(input: ExtractImportsInput): readonly ExtractedImport[] {
  const { filePath, sourceText } = input;
  const stripped = stripComments(sourceText);
  const lines = stripped.split("\n");
  const out: ExtractedImport[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;

    // `from X import ...`
    const fromMatch = /^from\s+([^\s]+)\s+import\s+(.+)$/.exec(line);
    if (fromMatch !== null) {
      const source = fromMatch[1] as string;
      const rest = (fromMatch[2] as string).trim();
      if (rest === "*") {
        out.push({ filePath, source, kind: "package-wildcard", isWildcard: true });
        continue;
      }
      // Strip trailing `(...)` in case of parenthesized lists.
      const cleaned = rest.replace(/^\(|\)$/g, "").trim();
      const parts = cleaned
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      const names: string[] = [];
      for (const p of parts) {
        const m = /^([A-Za-z_][\w]*)(?:\s+as\s+([A-Za-z_][\w]*))?$/.exec(p);
        if (m === null) continue;
        names.push((m[2] as string | undefined) ?? (m[1] as string));
      }
      if (names.length > 0) {
        out.push({ filePath, source, kind: "named", importedNames: names });
      }
      continue;
    }

    // `import X[, Y as Z]`
    const importMatch = /^import\s+(.+)$/.exec(line);
    if (importMatch !== null) {
      const body = importMatch[1] as string;
      const parts = body
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      for (const p of parts) {
        const m = /^([A-Za-z_][\w.]*)(?:\s+as\s+([A-Za-z_][\w]*))?$/.exec(p);
        if (m === null) continue;
        const source = m[1] as string;
        const alias = m[2];
        out.push({
          filePath,
          source,
          kind: "namespace",
          ...(alias !== undefined ? { localAlias: alias } : {}),
        });
      }
    }
  }
  return out;
}

function extractPyHeritage(input: ExtractHeritageInput): readonly ExtractedHeritage[] {
  const { filePath, captures, definitions } = input;

  // The Python query emits `(class_definition superclasses: (argument_list
  // (identifier) @name @reference.class))`. Group references by enclosing
  // class definition, then emit an EXTENDS edge per parent. The C3 walker
  // handles MRO linearization downstream.
  const classDefs = captures.filter((c) => c.tag === "definition.class");
  const classRefs = captures.filter((c) => c.tag === "reference.class");
  const out: ExtractedHeritage[] = [];

  for (const ref of classRefs) {
    // Find the class def whose range contains `ref`.
    const enclosing = classDefs.find(
      (d) => ref.startLine >= d.startLine && ref.endLine <= d.endLine,
    );
    if (enclosing === undefined) continue;
    const child = definitions.find(
      (d) => d.kind === "Class" && d.startLine === enclosing.startLine,
    );
    if (child === undefined) continue;
    out.push({
      childQualifiedName: child.qualifiedName,
      parentName: ref.text,
      filePath,
      relation: "EXTENDS",
      startLine: ref.startLine,
    });
  }

  return out;
}

function preprocessPyImportPath(raw: string): string {
  // Python source-level imports use dotted paths, e.g. `pkg.sub.mod`. The
  // path-lookup phase maps these to files on disk; here we just strip any
  // trailing `.py` or `/__init__.py` that might have leaked through (rare,
  // but occurs when an import is reconstructed from a file path).
  return raw.replace(/\.py$/, "").replace(/\/__init__$/, "");
}

export const pythonProvider: LanguageProvider = {
  id: "python",
  extensions: [".py"],
  importSemantics: "namespace",
  mroStrategy: "c3",
  typeConfig: { structural: true, nominal: false, generics: true },
  heritageEdge: "EXTENDS",
  inferImplicitReceiver: () => "self",
  preprocessImportPath: preprocessPyImportPath,
  isExportedIdentifier: (name) => !name.startsWith("_"),
  // Opt into the clean-room stack-graphs evaluator for Python reference
  // resolution. The strategy falls back to the three-tier walker whenever
  // stack-graphs can't produce an answer (missing graph cache, degraded
  // rule load, depth-budget exhaustion, etc.).
  resolverStrategyName: "stack-graphs",

  extractDefinitions: extractPyDefinitions,
  extractCalls: extractPyCalls,
  extractImports: extractPyImports,
  isExported: (def) => def.isExported,
  extractHeritage: extractPyHeritage,
  detectOutboundHttp: ({ sourceText }) => detectHttpCallsPython(sourceText),
  extractPropertyAccesses: extractPyPropertyAccesses,
};
