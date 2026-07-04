import type { NodeKind } from "@opencodehub/core-types";
import {
  type CallsConfig,
  type DefinitionsConfig,
  dotPrefixNoRegexReceiver,
  extractCallsGeneric,
  extractDefinitionsGeneric,
  getLine,
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

const CSHARP_DEFS_CONFIG: DefinitionsConfig = {
  // C# resolves kind off `def.nodeType` (class/struct/record/enum/constructor)
  // — a `Record<tag,NodeKind>` cannot express it, hence the function form.
  kindFor: mapCsharpDefKind,
  isExported: ({ def, sourceText }) => /\bpublic\b/.test(getLine(sourceText, def.startLine)),
};

function extractCsharpDefinitions(input: ExtractDefinitionsInput): readonly ExtractedDefinition[] {
  return extractDefinitionsGeneric(input, CSHARP_DEFS_CONFIG);
}

const CSHARP_CALLS_CONFIG: CallsConfig = {
  // C# is the only provider that also treats `reference.send` as a call site.
  callTags: ["reference.call", "reference.send"],
  inferReceiver: dotPrefixNoRegexReceiver(),
};

function extractCsharpCalls(input: ExtractCallsInput): readonly ExtractedCall[] {
  return extractCallsGeneric(input, CSHARP_CALLS_CONFIG);
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
