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
import type {
  ExtractCallsInput,
  ExtractDefinitionsInput,
  ExtractHeritageInput,
  ExtractImportsInput,
  LanguageProvider,
} from "./types.js";

/**
 * C# provider.
 *
 * C# allows single class inheritance plus multiple interface implementation
 * in a single `:`-separated list (e.g. `class Foo : Base, IA, IB`). Without
 * a type checker we can't unambiguously partition the list, so we apply a
 * heuristic:
 *   - The first item is treated as EXTENDS when it does NOT match the
 *     C# interface-naming convention (`I[A-Z]...`).
 *   - Remaining items are IMPLEMENTS.
 * This is imperfect — classes named like `Interlocked` violate the rule —
 * but matches conventional C# code well enough for MVP graph analysis.
 */

function mapCsharpDefKind(def: import("../parse/types.js").ParseCapture): NodeKind | undefined {
  if (def.tag === "definition.class") {
    switch (def.nodeType) {
      case "class_declaration":
        return "Class";
      case "struct_declaration":
        return "Struct";
      case "record_declaration":
        return "Record";
      case "enum_declaration":
        return "Enum";
      default:
        return "Class";
    }
  }
  if (def.tag === "definition.interface") return "Interface";
  if (def.tag === "definition.method") {
    return def.nodeType === "constructor_declaration" ? "Constructor" : "Method";
  }
  if (def.tag === "definition.module") return "Namespace";
  return undefined;
}

function extractCsharpDefinitions(input: ExtractDefinitionsInput): readonly ExtractedDefinition[] {
  const { filePath, captures, sourceText } = input;
  const paired = pairDefinitionsWithNames(captures);
  const defCaptures = captures.filter((c) => c.tag.startsWith("definition."));
  const out: ExtractedDefinition[] = [];

  for (const { def, name } of paired) {
    const kind = mapCsharpDefKind(def);
    if (kind === undefined) continue;

    let owner: string | undefined;
    const ownerDef = innermostEnclosingDef(def, defCaptures);
    if (ownerDef !== undefined) {
      const ownerPaired = paired.find((p) => p.def === ownerDef);
      if (ownerPaired !== undefined) owner = ownerPaired.name.text;
    }

    const qualifiedName = owner !== undefined ? `${owner}.${name.text}` : name.text;
    const headerLine = getLine(sourceText, def.startLine);
    const isExported = /\bpublic\b/.test(headerLine);

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

function extractCsharpCalls(input: ExtractCallsInput): readonly ExtractedCall[] {
  const { filePath, captures, definitions } = input;
  const defCaptures = captures.filter((c) => c.tag.startsWith("definition."));
  const callRefs = captures.filter((c) => c.tag === "reference.call" || c.tag === "reference.send");
  const out: ExtractedCall[] = [];

  for (const ref of callRefs) {
    const innerName = findNameInside(captures, ref);
    const calleeName = innerName?.text ?? ref.text;

    const enclosingDef = innermostEnclosingDef(ref, defCaptures);
    const callerQualifiedName = enclosingDef
      ? qualifiedForCapture(enclosingDef, definitions)
      : "<module>";

    let receiver: string | undefined;
    if (innerName !== undefined) {
      const idx = ref.text.lastIndexOf(`.${innerName.text}`);
      if (idx > 0) {
        const prefix = ref.text.slice(0, idx).trim();
        if (prefix !== "") receiver = prefix;
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
 * Parse C# `using` directives:
 *   `using System;`                    (namespace)
 *   `using static System.Math;`        (namespace static)
 *   `using Json = Newtonsoft.Json;`    (aliased)
 *   `using global::Foo;`               (global-qualified)
 */
function extractCsharpImports(input: ExtractImportsInput): readonly ExtractedImport[] {
  const { filePath, sourceText } = input;
  const stripped = stripComments(sourceText);
  const out: ExtractedImport[] = [];
  const usingRe = /^\s*using\s+(?:static\s+)?([^;]+);\s*$/gm;

  for (const m of stripped.matchAll(usingRe)) {
    const body = (m[1] as string).trim();

    // Aliased: `Alias = Full.Path`
    const aliasMatch = /^([A-Za-z_][\w]*)\s*=\s*(.+)$/.exec(body);
    if (aliasMatch !== null) {
      out.push({
        filePath,
        source: (aliasMatch[2] as string).replace(/^global::/, ""),
        kind: "namespace",
        localAlias: aliasMatch[1] as string,
      });
      continue;
    }

    out.push({
      filePath,
      source: body.replace(/^global::/, ""),
      kind: "namespace",
    });
  }
  return out;
}

function extractCsharpHeritage(input: ExtractHeritageInput): readonly ExtractedHeritage[] {
  const { filePath, captures, definitions } = input;
  const out: ExtractedHeritage[] = [];

  // The C# query does not emit dedicated base-list captures; scan the
  // header line of each class/struct/record/interface definition for
  // `: Base[, I1, I2]`.
  const defCaps = captures.filter(
    (c) => c.tag === "definition.class" || c.tag === "definition.interface",
  );

  for (const def of defCaps) {
    const firstLine = def.text.split("\n", 1)[0] as string;
    // Match from the opening `:` up to `{` / `where` / end-of-line.
    const baseMatch = /:\s*([^{]+?)(?:\s+where\b|\s*\{|$)/.exec(firstLine);
    if (baseMatch === null) continue;
    const list = (baseMatch[1] as string)
      .split(",")
      .map((s) => s.trim().replace(/<.*$/, ""))
      .filter((s) => s.length > 0 && /^[A-Za-z_][\w.]*$/.test(s));

    const child = definitions.find((d) => d.startLine === def.startLine);
    if (child === undefined) continue;

    // For interfaces, all entries are parent interfaces — emit as EXTENDS
    // (interface extends interface is the canonical C# relation).
    if (child.kind === "Interface") {
      for (const parent of list) {
        out.push({
          childQualifiedName: child.qualifiedName,
          parentName: parent,
          filePath,
          relation: "EXTENDS",
          startLine: def.startLine,
        });
      }
      continue;
    }

    // For classes/structs/records: apply the `I[A-Z]` interface-naming
    // heuristic. When the first item starts with `I` followed by an
    // uppercase letter, treat every item as IMPLEMENTS. Otherwise the
    // first item is EXTENDS, the rest are IMPLEMENTS.
    const [first, ...rest] = list;
    if (first === undefined) continue;
    const firstLooksLikeInterface = /^I[A-Z]/.test(first);
    if (firstLooksLikeInterface) {
      for (const parent of list) {
        out.push({
          childQualifiedName: child.qualifiedName,
          parentName: parent,
          filePath,
          relation: "IMPLEMENTS",
          startLine: def.startLine,
        });
      }
    } else {
      out.push({
        childQualifiedName: child.qualifiedName,
        parentName: first,
        filePath,
        relation: "EXTENDS",
        startLine: def.startLine,
      });
      for (const parent of rest) {
        out.push({
          childQualifiedName: child.qualifiedName,
          parentName: parent,
          filePath,
          relation: "IMPLEMENTS",
          startLine: def.startLine,
        });
      }
    }
  }
  return out;
}

export const csharpProvider: LanguageProvider = {
  id: "csharp",
  extensions: [".cs"],
  importSemantics: "named",
  mroStrategy: "single-inheritance",
  typeConfig: { structural: false, nominal: true, generics: true },
  heritageEdge: "EXTENDS",
  inferImplicitReceiver: () => "this",
  isExportedIdentifier: (_name, context) => context === "top-level",
  complexityDefinitionKinds: [
    "method_declaration",
    "constructor_declaration",
    "local_function_statement",
    "destructor_declaration",
    "operator_declaration",
    "lambda_expression",
  ],
  halsteadOperatorKinds: [
    "+",
    "-",
    "*",
    "/",
    "%",
    "=",
    "==",
    "!=",
    "<",
    ">",
    "<=",
    ">=",
    "&&",
    "||",
    "!",
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
    "&=",
    "|=",
    "^=",
    "<<=",
    ">>=",
    "?",
    ":",
    "??",
    "?.",
    "=>",
    "is",
    "as",
  ],

  extractDefinitions: extractCsharpDefinitions,
  extractCalls: extractCsharpCalls,
  extractImports: extractCsharpImports,
  isExported: (def) => def.isExported,
  extractHeritage: extractCsharpHeritage,
};
