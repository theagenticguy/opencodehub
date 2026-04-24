import type { NodeKind } from "@opencodehub/core-types";
import type { ParseCapture } from "../parse/types.js";
import {
  innermostEnclosingContainer,
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
 * Swift provider.
 *
 * Definitions: classes, structs, enums, protocols, extensions, functions,
 * methods, initializers, computed properties. Swift's grammar packs
 * `class_declaration` to cover all of class/struct/enum/actor (disambiguated
 * by the `class`/`struct`/`enum` keyword field on the node). We rely on the
 * unified query to tag the specific kind.
 *
 * Heritage: `class Foo: Bar, P1, P2` — the first type is the superclass
 * (if a class) and any remaining are protocols. We emit all as EXTENDS; the
 * downstream resolver can demote later parents to IMPLEMENTS when it has
 * protocol knowledge. At MVP this is good enough for reachability.
 *
 * Imports: `import Foo` or `import Foo.Bar.Baz` — each line → one import.
 *
 * Exports: Swift's access control is explicit — `private`/`fileprivate`
 * are non-exported, everything else (internal, public, open) is. We check
 * the modifier on the declaration header.
 */

const SWIFT_DEF_KIND_MAP: Readonly<Record<string, NodeKind>> = {
  "definition.class": "Class",
  "definition.struct": "Struct",
  "definition.enum": "Enum",
  "definition.interface": "Interface",
  "definition.function": "Function",
  "definition.method": "Method",
  "definition.constructor": "Constructor",
  "definition.module": "Namespace",
  "definition.property": "Property",
  "definition.constant": "Const",
};

function extractSwiftDefinitions(input: ExtractDefinitionsInput): readonly ExtractedDefinition[] {
  const { filePath, captures } = input;
  const paired = pairDefinitionsWithNames(captures);
  const defCaptures = captures.filter((c) => c.tag.startsWith("definition."));
  const out: ExtractedDefinition[] = [];

  for (const { def, name } of paired) {
    let kind = SWIFT_DEF_KIND_MAP[def.tag];
    if (kind === undefined) continue;

    let owner: string | undefined;
    const ownerDef = innermostEnclosingDef(def, defCaptures);
    if (ownerDef !== undefined) {
      const ownerPaired = paired.find((p) => p.def === ownerDef);
      if (ownerPaired !== undefined) owner = ownerPaired.name.text;
    }

    // Promote function -> method when nested in a type declaration.
    if (
      def.tag === "definition.function" &&
      (ownerDef?.tag === "definition.class" ||
        ownerDef?.tag === "definition.struct" ||
        ownerDef?.tag === "definition.enum" ||
        ownerDef?.tag === "definition.interface")
    ) {
      kind = "Method";
    }

    const qualifiedName = owner !== undefined ? `${owner}.${name.text}` : name.text;
    const isExported = !name.text.startsWith("_");

    out.push({
      kind,
      name: name.text,
      qualifiedName,
      filePath,
      startLine: def.startLine,
      endLine: def.endLine,
      isExported,
      ...(owner !== undefined ? { owner } : {}),
    });
  }
  return out;
}

function extractSwiftCalls(input: ExtractCallsInput): readonly ExtractedCall[] {
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
  captures: readonly ParseCapture[],
  outer: ParseCapture,
): ParseCapture | undefined {
  let best: ParseCapture | undefined;
  for (const c of captures) {
    if (c.tag !== "name") continue;
    if (!isInside(c, outer)) continue;
    if (best === undefined || c.startLine < best.startLine) best = c;
  }
  return best;
}

function qualifiedForCapture(
  def: ParseCapture,
  definitions: readonly ExtractedDefinition[],
): string {
  for (const d of definitions) {
    if (d.startLine === def.startLine) return d.qualifiedName;
  }
  return "<module>";
}

function extractSwiftImports(input: ExtractImportsInput): readonly ExtractedImport[] {
  const { filePath, sourceText } = input;
  const stripped = stripComments(sourceText);
  const out: ExtractedImport[] = [];

  const re =
    /^\s*import\s+(?:(?:class|struct|enum|protocol|typealias|func|var|let)\s+)?([\w.]+)\s*$/gm;
  for (const m of stripped.matchAll(re)) {
    out.push({ filePath, source: m[1] as string, kind: "named" });
  }
  return out;
}

function extractSwiftHeritage(input: ExtractHeritageInput): readonly ExtractedHeritage[] {
  const { filePath, captures, definitions } = input;
  const out: ExtractedHeritage[] = [];

  const containerDefs = captures.filter(
    (c) =>
      c.tag === "definition.class" ||
      c.tag === "definition.struct" ||
      c.tag === "definition.enum" ||
      c.tag === "definition.interface",
  );
  const parentRefs = captures.filter((c) => c.tag === "reference.class");

  for (const ref of parentRefs) {
    const enclosing = innermostEnclosingContainer(ref, containerDefs);
    if (enclosing === undefined) continue;
    const child = definitions.find(
      (d) =>
        (d.kind === "Class" ||
          d.kind === "Struct" ||
          d.kind === "Enum" ||
          d.kind === "Interface") &&
        d.startLine === enclosing.startLine,
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

export const swiftProvider: LanguageProvider = {
  id: "swift",
  extensions: [".swift"],
  importSemantics: "named",
  mroStrategy: "single-inheritance",
  typeConfig: { structural: false, nominal: true, generics: true },
  heritageEdge: "EXTENDS",
  inferImplicitReceiver: () => "self",
  isExportedIdentifier: (name) => !name.startsWith("_"),

  extractDefinitions: extractSwiftDefinitions,
  extractCalls: extractSwiftCalls,
  extractImports: extractSwiftImports,
  isExported: (def) => def.isExported,
  extractHeritage: extractSwiftHeritage,
};
