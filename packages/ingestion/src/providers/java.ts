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
import { detectHttpCallsJava } from "./http-detect.js";
import type {
  ExtractCallsInput,
  ExtractDefinitionsInput,
  ExtractHeritageInput,
  ExtractImportsInput,
  LanguageProvider,
} from "./types.js";

/**
 * Java provider.
 *
 * Kind mapping: Java's query flattens `class_declaration`, `enum_declaration`,
 * and `record_declaration` onto `@definition.class`. We distinguish by the
 * underlying `nodeType` so the graph carries accurate kinds.
 *
 * Exports: `public` modifier on the declaration line. Everything else is
 * package-private / private / protected — not exported for the graph.
 */

function mapJavaDefKind(def: import("../parse/types.js").ParseCapture): NodeKind | undefined {
  if (def.tag === "definition.class") {
    switch (def.nodeType) {
      case "class_declaration":
        return "Class";
      case "enum_declaration":
        return "Enum";
      case "record_declaration":
        return "Record";
      default:
        return "Class";
    }
  }
  if (def.tag === "definition.interface") return "Interface";
  if (def.tag === "definition.method") {
    return def.nodeType === "constructor_declaration" ? "Constructor" : "Method";
  }
  return undefined;
}

function extractJavaDefinitions(input: ExtractDefinitionsInput): readonly ExtractedDefinition[] {
  const { filePath, captures, sourceText } = input;
  const paired = pairDefinitionsWithNames(captures);
  const defCaptures = captures.filter((c) => c.tag.startsWith("definition."));
  const out: ExtractedDefinition[] = [];

  for (const { def, name } of paired) {
    const kind = mapJavaDefKind(def);
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

function extractJavaCalls(input: ExtractCallsInput): readonly ExtractedCall[] {
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

    // Java call receiver: `foo()`, `this.foo()`, `obj.foo()`, `Class.foo()`.
    // The `@reference.call` capture only covers `method_invocation`'s name
    // child in our query, so `ref.text` is just the bare method name. We
    // fall back to reading the source line and slicing before the name.
    // As a MVP-level approximation, we leave receiver undefined here —
    // downstream type resolution is the authoritative source.
    let receiver: string | undefined;
    if (innerName !== undefined && ref.text.includes(".")) {
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
 * Parse Java imports:
 *   `import pkg.Class;`         (named)
 *   `import pkg.*;`             (package-wildcard)
 *   `import static pkg.X.m;`    (named, static)
 *   `import static pkg.X.*;`    (package-wildcard, static)
 */
function extractJavaImports(input: ExtractImportsInput): readonly ExtractedImport[] {
  const { filePath, sourceText } = input;
  const stripped = stripComments(sourceText);
  const out: ExtractedImport[] = [];
  const importRe = /^\s*import\s+(static\s+)?([^;]+);\s*$/gm;

  for (const m of stripped.matchAll(importRe)) {
    const body = (m[2] as string).trim();
    if (body.endsWith(".*")) {
      const source = body.slice(0, -2);
      out.push({ filePath, source, kind: "package-wildcard", isWildcard: true });
      continue;
    }
    const parts = body.split(".");
    if (parts.length < 2) continue;
    const last = parts[parts.length - 1] as string;
    const source = parts.slice(0, -1).join(".");
    out.push({ filePath, source, kind: "named", importedNames: [last] });
  }
  return out;
}

function extractJavaHeritage(input: ExtractHeritageInput): readonly ExtractedHeritage[] {
  const { filePath, captures, definitions } = input;
  const out: ExtractedHeritage[] = [];

  // The unified query emits:
  //   `(superclass (type_identifier) @name @reference.class)` — single parent
  //   `(super_interfaces (type_list (type_identifier) @name @reference.implementation))`
  // Map each ref to its enclosing class/interface definition.
  const classRefs = captures.filter((c) => c.tag === "reference.class");
  const implRefs = captures.filter((c) => c.tag === "reference.implementation");

  for (const ref of classRefs) {
    const child = findChildDef(ref, definitions);
    if (child === undefined) continue;
    // Guard against `reference.class` captures that come from
    // `object_creation_expression` (`new Foo()`) rather than `superclass`.
    // Those are call-site-like and would appear outside the declaration
    // header. Keep only refs that lie on the child's header line.
    if (ref.startLine !== child.startLine) continue;
    out.push({
      childQualifiedName: child.qualifiedName,
      parentName: ref.text,
      filePath,
      relation: "EXTENDS",
      startLine: ref.startLine,
    });
  }

  for (const ref of implRefs) {
    const child = findChildDef(ref, definitions);
    if (child === undefined) continue;
    out.push({
      childQualifiedName: child.qualifiedName,
      parentName: ref.text,
      filePath,
      relation: "IMPLEMENTS",
      startLine: ref.startLine,
    });
  }

  return out;
}

function findChildDef(
  ref: { startLine: number; endLine: number },
  definitions: readonly ExtractedDefinition[],
): ExtractedDefinition | undefined {
  let best: ExtractedDefinition | undefined;
  for (const d of definitions) {
    if (d.kind !== "Class" && d.kind !== "Interface" && d.kind !== "Enum" && d.kind !== "Record") {
      continue;
    }
    if (ref.startLine < d.startLine || ref.endLine > d.endLine) continue;
    if (best === undefined || d.startLine > best.startLine) best = d;
  }
  return best;
}

export const javaProvider: LanguageProvider = {
  id: "java",
  extensions: [".java"],
  importSemantics: "named",
  mroStrategy: "single-inheritance",
  typeConfig: { structural: false, nominal: true, generics: true },
  heritageEdge: "EXTENDS",
  inferImplicitReceiver: () => "this",
  isExportedIdentifier: (_name, context) => context === "top-level",

  extractDefinitions: extractJavaDefinitions,
  extractCalls: extractJavaCalls,
  extractImports: extractJavaImports,
  isExported: (def) => def.isExported,
  extractHeritage: extractJavaHeritage,
  detectOutboundHttp: ({ sourceText }) => detectHttpCallsJava(sourceText),
};
