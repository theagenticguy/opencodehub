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
 * Dart provider.
 *
 * Definitions: classes, mixins, extensions, functions, methods, enums.
 * Dart's grammar uses `class_definition`, `mixin_declaration`,
 * `extension_declaration`, `function_signature`, `method_signature`.
 *
 * Heritage: `class Foo extends Parent with M1 implements I1, I2` — the
 * three forms surface as:
 *   - `superclass`    → @reference.class    (EXTENDS)
 *   - `mixins`        → @reference.mixin    (IMPLEMENTS, for MRO linearization)
 *   - `interfaces`    → @reference.interface (IMPLEMENTS)
 *
 * Imports: `import 'package:…' as foo show a, b;` — one import per `import`
 * directive. Also `part of …` and `export …`, but those are ignored at MVP
 * since they do not participate in the dependency graph the same way.
 *
 * Exports: Dart uses a leading-underscore convention for library-private
 * symbols. We treat `_foo` as not exported, everything else as exported.
 */

const DART_DEF_KIND_MAP: Readonly<Record<string, NodeKind>> = {
  "definition.class": "Class",
  "definition.interface": "Interface",
  "definition.mixin": "Trait",
  "definition.function": "Function",
  "definition.method": "Method",
  "definition.constructor": "Constructor",
  "definition.module": "Module",
  "definition.enum": "Enum",
  "definition.constant": "Const",
  "definition.property": "Property",
};

function extractDartDefinitions(input: ExtractDefinitionsInput): readonly ExtractedDefinition[] {
  const { filePath, captures } = input;
  const paired = pairDefinitionsWithNames(captures);
  const defCaptures = captures.filter((c) => c.tag.startsWith("definition."));
  const out: ExtractedDefinition[] = [];

  for (const { def, name } of paired) {
    let kind = DART_DEF_KIND_MAP[def.tag];
    if (kind === undefined) continue;

    let owner: string | undefined;
    const ownerDef = innermostEnclosingDef(def, defCaptures);
    if (ownerDef !== undefined) {
      const ownerPaired = paired.find((p) => p.def === ownerDef);
      if (ownerPaired !== undefined) owner = ownerPaired.name.text;
    }

    if (
      def.tag === "definition.function" &&
      (ownerDef?.tag === "definition.class" ||
        ownerDef?.tag === "definition.interface" ||
        ownerDef?.tag === "definition.mixin")
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

function extractDartCalls(input: ExtractCallsInput): readonly ExtractedCall[] {
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

function extractDartImports(input: ExtractImportsInput): readonly ExtractedImport[] {
  const { filePath, sourceText } = input;
  const stripped = stripComments(sourceText);
  const out: ExtractedImport[] = [];

  // `import 'package:foo/bar.dart' as foo show A, B hide C;`
  const re =
    /^\s*import\s+['"]([^'"]+)['"](?:\s+as\s+([A-Za-z_][\w]*))?(?:\s+(?:show|hide)\s+[\w, ]+)?\s*;/gm;
  for (const m of stripped.matchAll(re)) {
    const source = m[1] as string;
    const alias = m[2];
    out.push({
      filePath,
      source,
      kind: "namespace",
      ...(alias !== undefined ? { localAlias: alias } : {}),
    });
  }
  return out;
}

function extractDartHeritage(input: ExtractHeritageInput): readonly ExtractedHeritage[] {
  const { filePath, captures, definitions } = input;
  const out: ExtractedHeritage[] = [];

  const classDefs = captures.filter(
    (c) =>
      c.tag === "definition.class" ||
      c.tag === "definition.interface" ||
      c.tag === "definition.mixin",
  );

  // superclass: `extends Parent`
  const extendsRefs = captures.filter((c) => c.tag === "reference.class");
  for (const ref of extendsRefs) {
    const enclosing = innermostEnclosingContainer(ref, classDefs);
    if (enclosing === undefined) continue;
    const child = definitions.find(
      (d) =>
        (d.kind === "Class" || d.kind === "Interface" || d.kind === "Trait") &&
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

  // implements: `implements I1, I2`
  const implementsRefs = captures.filter((c) => c.tag === "reference.interface");
  for (const ref of implementsRefs) {
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
      relation: "IMPLEMENTS",
      startLine: ref.startLine,
    });
  }

  // mixins: `with M1, M2`
  const mixinRefs = captures.filter((c) => c.tag === "reference.mixin");
  for (const ref of mixinRefs) {
    const enclosing = innermostEnclosingContainer(ref, classDefs);
    if (enclosing === undefined) continue;
    const child = definitions.find(
      (d) => (d.kind === "Class" || d.kind === "Trait") && d.startLine === enclosing.startLine,
    );
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

export const dartProvider: LanguageProvider = {
  id: "dart",
  extensions: [".dart"],
  importSemantics: "package-wildcard",
  mroStrategy: "c3",
  typeConfig: { structural: false, nominal: true, generics: true },
  heritageEdge: "EXTENDS",
  inferImplicitReceiver: () => "this",
  isExportedIdentifier: (name) => !name.startsWith("_"),

  extractDefinitions: extractDartDefinitions,
  extractCalls: extractDartCalls,
  extractImports: extractDartImports,
  isExported: (def) => def.isExported,
  extractHeritage: extractDartHeritage,
};
