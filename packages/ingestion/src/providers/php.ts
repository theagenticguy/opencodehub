import type { NodeKind } from "@opencodehub/core-types";
import type { ParseCapture } from "../parse/types.js";
import {
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
 * PHP provider.
 *
 * Definitions: classes, interfaces, traits, methods, functions, consts.
 * The grammar uses `class_declaration`/`interface_declaration`/
 * `trait_declaration`/`method_declaration`/`function_definition`. Methods
 * always live inside a class/interface/trait body, so the innermost-
 * enclosing-def walk picks up the owning type correctly.
 *
 * Heritage: `class Foo extends Bar implements I1, I2` plus `use T1, T2;`
 * for trait composition inside a class body. The unified query emits
 * `@reference.class` for the `extends` target, `@reference.interface` for
 * the `implements` list, and `@reference.mixin` for traits.
 *
 * Imports: `use` namespace/class imports, plus `require`/`include` family
 * for files. At MVP we treat all four (`require`, `require_once`, `include`,
 * `include_once`) as the same kind.
 *
 * Exports: PHP public/protected/private modifiers on methods — we treat
 * `private` as non-exported, everything else as exported.
 */

const PHP_DEF_KIND_MAP: Readonly<Record<string, NodeKind>> = {
  "definition.class": "Class",
  "definition.interface": "Interface",
  "definition.trait": "Trait",
  "definition.function": "Function",
  "definition.method": "Method",
  "definition.module": "Namespace",
  "definition.constant": "Const",
  "definition.enum": "Enum",
};

function extractPhpDefinitions(input: ExtractDefinitionsInput): readonly ExtractedDefinition[] {
  const { filePath, captures } = input;
  const paired = pairDefinitionsWithNames(captures);
  const defCaptures = captures.filter((c) => c.tag.startsWith("definition."));
  const out: ExtractedDefinition[] = [];

  for (const { def, name } of paired) {
    const kind = PHP_DEF_KIND_MAP[def.tag];
    if (kind === undefined) continue;

    let owner: string | undefined;
    const ownerDef = innermostEnclosingDef(def, defCaptures);
    if (ownerDef !== undefined) {
      const ownerPaired = paired.find((p) => p.def === ownerDef);
      if (ownerPaired !== undefined) owner = ownerPaired.name.text;
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

function extractPhpCalls(input: ExtractCallsInput): readonly ExtractedCall[] {
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

    // Receiver inference — PHP has `$obj->method()`, `Class::method()`,
    // and `self::method()` forms.
    let receiver: string | undefined;
    if (innerName !== undefined) {
      const idx = ref.text.lastIndexOf(innerName.text);
      if (idx > 0) {
        const prefix = ref.text.slice(0, idx).trim();
        const stripped = prefix.replace(/(?:->|::)$/, "").trim();
        if (stripped !== "" && /^\$?[A-Za-z_][\w]*$/.test(stripped)) {
          receiver = stripped;
        }
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

function extractPhpImports(input: ExtractImportsInput): readonly ExtractedImport[] {
  const { filePath, sourceText } = input;
  const stripped = stripComments(sourceText);
  const out: ExtractedImport[] = [];

  // `use Namespace\Class;` or `use Namespace\{A, B as C};` or
  // `use function foo;` or `use const BAR;`
  const useRe =
    /\buse\s+(?:function\s+|const\s+)?([A-Za-z_\\][\w\\]*)(?:\s+as\s+([A-Za-z_][\w]*))?\s*;/g;
  for (const m of stripped.matchAll(useRe)) {
    const source = (m[1] as string).replace(/\\\\/g, "/").replace(/\\/g, "/");
    const alias = m[2];
    out.push({
      filePath,
      source,
      kind: "named",
      ...(alias !== undefined ? { localAlias: alias } : {}),
    });
  }

  // `require 'path'`, `require_once "path"`, `include 'path'`, etc.
  const reqRe = /\b(require|require_once|include|include_once)\s*\(?\s*["']([^"']+)["']/g;
  for (const m of stripped.matchAll(reqRe)) {
    const source = m[2] as string;
    out.push({ filePath, source, kind: "package-wildcard" });
  }

  return out;
}

function extractPhpHeritage(input: ExtractHeritageInput): readonly ExtractedHeritage[] {
  const { filePath, captures, definitions } = input;
  const out: ExtractedHeritage[] = [];

  const containerDefs = captures.filter(
    (c) =>
      c.tag === "definition.class" ||
      c.tag === "definition.interface" ||
      c.tag === "definition.trait",
  );

  // EXTENDS — `@reference.class`
  const extendsRefs = captures.filter((c) => c.tag === "reference.class");
  for (const ref of extendsRefs) {
    const enclosing = containerDefs.find(
      (d) => ref.startLine >= d.startLine && ref.endLine <= d.endLine,
    );
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

  // IMPLEMENTS — `@reference.interface`
  const implementsRefs = captures.filter((c) => c.tag === "reference.interface");
  for (const ref of implementsRefs) {
    const enclosing = containerDefs.find(
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
      relation: "IMPLEMENTS",
      startLine: ref.startLine,
    });
  }

  // Trait use — `@reference.mixin`
  const mixinRefs = captures.filter((c) => c.tag === "reference.mixin");
  for (const ref of mixinRefs) {
    const enclosing = containerDefs.find(
      (d) => ref.startLine >= d.startLine && ref.endLine <= d.endLine,
    );
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

export const phpProvider: LanguageProvider = {
  id: "php",
  extensions: [".php", ".php3", ".php4", ".php5", ".php7", ".phtml"],
  importSemantics: "named",
  mroStrategy: "single-inheritance",
  typeConfig: { structural: false, nominal: true, generics: false },
  heritageEdge: "EXTENDS",
  inferImplicitReceiver: () => "this",
  isExportedIdentifier: (name) => !name.startsWith("_"),

  extractDefinitions: extractPhpDefinitions,
  extractCalls: extractPhpCalls,
  extractImports: extractPhpImports,
  isExported: (def) => def.isExported,
  extractHeritage: extractPhpHeritage,
};
