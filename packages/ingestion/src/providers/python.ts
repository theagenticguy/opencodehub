import type { NodeKind } from "@opencodehub/core-types";
import {
  type CallsConfig,
  dotPrefixNoRegexReceiver,
  extractCallsGeneric,
  getLine,
  innermostEnclosingContainer,
  innermostEnclosingDef,
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

// Receiver inference from the call expression's source text. The
// `@reference.call` range covers the full call; when the grammar matched
// `attribute.attribute`, `ref.text` is like `self.foo(x)` — we keep the
// full non-empty prefix before `.callee` as the receiver (no regex filter).
const PYTHON_CALLS_CONFIG: CallsConfig = {
  inferReceiver: dotPrefixNoRegexReceiver(),
};

function extractPyCalls(input: ExtractCallsInput): readonly ExtractedCall[] {
  return extractCallsGeneric(input, PYTHON_CALLS_CONFIG);
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
/**
 * Collapse Python's physical lines into logical lines so a multi-line import
 * is matched as one unit. Two continuation forms are joined:
 *   - parenthesized lists: `from m import (\n a,\n b,\n)` — join while the
 *     running open-paren count is > 0;
 *   - explicit backslash continuation: a line ending in `\`.
 * Both are ubiquitous in real Python (black / ruff wrap long import lists in
 * parens). Without joining, the per-line regex sees `from m import (` →
 * rest `(` → zero names → the whole import is silently dropped.
 *
 * Comments are already stripped upstream, so a `(` here is structural, not a
 * literal inside a string/comment. Paren counting is a coarse approximation
 * (it doesn't track string literals) but import statements never contain
 * string-embedded parens, so it is exact for the import grammar.
 */
function joinLogicalLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  let buf = "";
  let depth = 0;
  for (const raw of lines) {
    let line = raw;
    let continued = false;
    if (depth === 0 && /\\\s*$/.test(line)) {
      line = line.replace(/\\\s*$/, " ");
      continued = true;
    }
    buf = buf === "" ? line : `${buf} ${line.trim()}`;
    for (const ch of line) {
      if (ch === "(") depth += 1;
      else if (ch === ")") depth = Math.max(0, depth - 1);
    }
    if (depth > 0 || continued) continue;
    out.push(buf);
    buf = "";
  }
  if (buf !== "") out.push(buf);
  return out;
}

function extractPyImports(input: ExtractImportsInput): readonly ExtractedImport[] {
  const { filePath, sourceText } = input;
  const stripped = stripComments(sourceText);
  const lines = joinLogicalLines(stripped.split("\n"));
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
    // Use the tightest-enclosing-container walk so nested classes don't
    // inherit their enclosing class's bases. See `LiteLLMModel` /
    // `SageMakerAIModel` in strands-agents/sdk-python: a nested
    // `Config(BaseModelConfig)` used to attribute the base to the outer
    // class, producing spurious MRO conflicts.
    const enclosing = innermostEnclosingContainer(ref, classDefs);
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
  // Reference resolution runs through the three-tier walker
  // (same-file -> import-scoped -> global). SCIP edges, when present,
  // overlay as the precision oracle on top of the walker's output.
  complexityDefinitionKinds: ["function_definition", "lambda"],
  halsteadOperatorKinds: [
    "+",
    "-",
    "*",
    "/",
    "//",
    "%",
    "**",
    "=",
    "==",
    "!=",
    "<",
    ">",
    "<=",
    ">=",
    "and",
    "or",
    "not",
    "is",
    "in",
    "&",
    "|",
    "^",
    "~",
    "<<",
    ">>",
    "+=",
    "-=",
    "*=",
    "/=",
    "%=",
    "**=",
    "//=",
    "&=",
    "|=",
    "^=",
    ":",
    "@",
    ":=",
  ],

  extractDefinitions: extractPyDefinitions,
  extractCalls: extractPyCalls,
  extractImports: extractPyImports,
  isExported: (def) => def.isExported,
  extractHeritage: extractPyHeritage,
  detectOutboundHttp: ({ sourceText }) => detectHttpCallsPython(sourceText),
  extractPropertyAccesses: extractPyPropertyAccesses,
};
