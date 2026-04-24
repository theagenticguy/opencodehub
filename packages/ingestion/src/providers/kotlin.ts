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
 * Kotlin provider.
 *
 * Definitions: classes, interfaces, objects (singletons), companion objects,
 * functions (top-level + member), properties (val/var). The grammar uses
 * `class_declaration` for data/sealed/enum/abstract variants — we treat all
 * class variants as `Class`.
 *
 * Heritage: `: Parent, Interface1, Interface2` — a class's
 * `delegation_specifier` carries one `user_type` reference per parent.
 * Kotlin distinguishes class `extends` (first non-interface, at most one)
 * from `implements` (interfaces) only at typecheck time. We emit all as
 * EXTENDS at MVP and let the downstream resolver reassign kinds when it
 * has type info.
 *
 * Imports: `import foo.bar.Baz` or `import foo.bar.*` — parsed via regex.
 *
 * Exports: leading-underscore convention does not apply in Kotlin. We
 * respect `private` / `internal` modifiers as non-exported.
 */

const KOTLIN_DEF_KIND_MAP: Readonly<Record<string, NodeKind>> = {
  "definition.class": "Class",
  "definition.interface": "Interface",
  "definition.module": "Namespace",
  "definition.function": "Function",
  "definition.method": "Method",
  "definition.constant": "Const",
  "definition.property": "Property",
};

function extractKotlinDefinitions(input: ExtractDefinitionsInput): readonly ExtractedDefinition[] {
  const { filePath, captures } = input;
  const paired = pairDefinitionsWithNames(captures);
  const defCaptures = captures.filter((c) => c.tag.startsWith("definition."));
  const out: ExtractedDefinition[] = [];

  for (const { def, name } of paired) {
    let kind = KOTLIN_DEF_KIND_MAP[def.tag];
    if (kind === undefined) continue;

    let owner: string | undefined;
    const ownerDef = innermostEnclosingDef(def, defCaptures);
    if (ownerDef !== undefined) {
      const ownerPaired = paired.find((p) => p.def === ownerDef);
      if (ownerPaired !== undefined) owner = ownerPaired.name.text;
    }

    // Promote function -> method when nested inside a class/interface/object.
    if (
      def.tag === "definition.function" &&
      (ownerDef?.tag === "definition.class" ||
        ownerDef?.tag === "definition.interface" ||
        ownerDef?.tag === "definition.module")
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

function extractKotlinCalls(input: ExtractCallsInput): readonly ExtractedCall[] {
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

function extractKotlinImports(input: ExtractImportsInput): readonly ExtractedImport[] {
  const { filePath, sourceText } = input;
  const stripped = stripComments(sourceText);
  const out: ExtractedImport[] = [];

  const re = /^\s*import\s+([\w.]+)(\.\*)?(?:\s+as\s+([A-Za-z_][\w]*))?\s*$/gm;
  for (const m of stripped.matchAll(re)) {
    const source = m[1] as string;
    const isWildcard = m[2] !== undefined;
    const alias = m[3];
    out.push({
      filePath,
      source,
      kind: isWildcard ? "package-wildcard" : "named",
      ...(isWildcard ? { isWildcard: true } : {}),
      ...(alias !== undefined ? { localAlias: alias } : {}),
    });
  }
  return out;
}

function extractKotlinHeritage(input: ExtractHeritageInput): readonly ExtractedHeritage[] {
  const { filePath, captures, definitions } = input;
  const out: ExtractedHeritage[] = [];

  const classDefs = captures.filter(
    (c) => c.tag === "definition.class" || c.tag === "definition.interface",
  );
  const parentRefs = captures.filter((c) => c.tag === "reference.class");

  for (const ref of parentRefs) {
    const enclosing = innermostEnclosingContainer(ref, classDefs);
    if (enclosing === undefined) continue;
    const child = definitions.find(
      (d) => (d.kind === "Class" || d.kind === "Interface") && d.startLine === enclosing.startLine,
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

export const kotlinProvider: LanguageProvider = {
  id: "kotlin",
  extensions: [".kt", ".kts"],
  importSemantics: "package-wildcard",
  mroStrategy: "c3",
  typeConfig: { structural: false, nominal: true, generics: true },
  heritageEdge: "EXTENDS",
  inferImplicitReceiver: () => "this",
  isExportedIdentifier: (name) => !name.startsWith("_"),

  extractDefinitions: extractKotlinDefinitions,
  extractCalls: extractKotlinCalls,
  extractImports: extractKotlinImports,
  isExported: (def) => def.isExported,
  extractHeritage: extractKotlinHeritage,
};
