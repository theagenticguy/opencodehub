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
 * Ruby provider.
 *
 * Definitions: classes, modules, methods (instance + class/singleton),
 * top-level constants. `method` nodes nested inside a `class` become
 * `Method`, top-level `method`s become `Function`. Modules are emitted as
 * `Module` (for the Ruby sense of "mixable container").
 *
 * Heritage: `class Foo < Bar` is captured as `@reference.class` on the
 * `superclass` child of the class. `include M` / `extend M` / `prepend M`
 * inside the class body are detected via a pre-pass on the source text —
 * Ruby's grammar tags these as plain method calls, so we recognize them
 * by callee name.
 *
 * Imports: `require`, `require_relative`, `load` — all surface as plain
 * method calls in Ruby's grammar. We scan the source text directly.
 *
 * Exports: Ruby has no static export modifier. We mark everything with a
 * leading `_` as not exported (convention-only) and everything else as
 * exported.
 */

const RUBY_DEF_KIND_MAP: Readonly<Record<string, NodeKind>> = {
  "definition.class": "Class",
  "definition.module": "Module",
  "definition.function": "Function",
  "definition.method": "Method",
  "definition.constant": "Const",
};

function extractRubyDefinitions(input: ExtractDefinitionsInput): readonly ExtractedDefinition[] {
  const { filePath, captures } = input;
  const paired = pairDefinitionsWithNames(captures);
  const defCaptures = captures.filter((c) => c.tag.startsWith("definition."));
  const out: ExtractedDefinition[] = [];

  for (const { def, name } of paired) {
    let kind = RUBY_DEF_KIND_MAP[def.tag];
    if (kind === undefined) continue;

    let owner: string | undefined;
    const ownerDef = innermostEnclosingDef(def, defCaptures);
    if (ownerDef !== undefined) {
      const ownerPaired = paired.find((p) => p.def === ownerDef);
      if (ownerPaired !== undefined) owner = ownerPaired.name.text;
    }

    // Promote function -> method when nested in a class/module.
    if (
      def.tag === "definition.function" &&
      (ownerDef?.tag === "definition.class" || ownerDef?.tag === "definition.module")
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

function extractRubyCalls(input: ExtractCallsInput): readonly ExtractedCall[] {
  const { filePath, captures, definitions } = input;
  const defCaptures = captures.filter((c) => c.tag.startsWith("definition."));
  const callRefs = captures.filter((c) => c.tag === "reference.call");
  const out: ExtractedCall[] = [];

  for (const ref of callRefs) {
    const innerName = findNameInside(captures, ref);
    const calleeName = innerName?.text ?? ref.text;

    // Drop pseudo-calls that are really import/mixin forms — we handle
    // those in extractImports / extractHeritage respectively.
    if (
      calleeName === "require" ||
      calleeName === "require_relative" ||
      calleeName === "load" ||
      calleeName === "autoload" ||
      calleeName === "include" ||
      calleeName === "extend" ||
      calleeName === "prepend"
    ) {
      continue;
    }

    const enclosingDef = innermostEnclosingDef(ref, defCaptures);
    const callerQualifiedName = enclosingDef
      ? qualifiedForCapture(enclosingDef, definitions)
      : "<module>";

    // Receiver inference: `obj.method(...)`. Ruby also has `self.method`
    // inside class bodies.
    let receiver: string | undefined;
    if (innerName !== undefined) {
      const idx = ref.text.lastIndexOf(`.${innerName.text}`);
      if (idx > 0) {
        const prefix = ref.text.slice(0, idx).trim();
        if (prefix !== "" && /^[A-Za-z_@][\w:]*$/.test(prefix)) receiver = prefix;
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

/**
 * Parse Ruby imports. Covers:
 *   `require 'mod'`
 *   `require_relative './mod'`
 *   `load 'mod.rb'`
 *   `autoload :Foo, 'foo'`
 */
function extractRubyImports(input: ExtractImportsInput): readonly ExtractedImport[] {
  const { filePath, sourceText } = input;
  const stripped = stripComments(sourceText);
  const out: ExtractedImport[] = [];

  const re =
    /\b(require|require_relative|load|autoload)\s*\(?\s*(?::[A-Za-z_][\w]*\s*,\s*)?["']([^"']+)["']/g;
  for (const m of stripped.matchAll(re)) {
    const kind = m[1] as string;
    const source = m[2] as string;
    out.push({
      filePath,
      source,
      kind: kind === "require_relative" ? "named" : "package-wildcard",
    });
  }
  return out;
}

/**
 * Heritage from Ruby class/module definitions:
 *   `class Foo < Bar`                → EXTENDS Bar
 *   `class Foo < Bar; include M; end` → EXTENDS Bar + IMPLEMENTS M
 *   `class Foo; prepend P; end`       → IMPLEMENTS P
 *
 * Tree-sitter-ruby wraps `< Bar` in a `superclass` node. Include/extend/
 * prepend mixins appear as `call` nodes whose method is `include` etc.
 * We detect them via text scanning inside the class body since the unified
 * query treats them as plain calls.
 */
function extractRubyHeritage(input: ExtractHeritageInput): readonly ExtractedHeritage[] {
  const { filePath, captures, definitions } = input;
  const out: ExtractedHeritage[] = [];

  // `@reference.class` captures from `superclass` field.
  const superRefs = captures.filter((c) => c.tag === "reference.class");
  const classDefs = captures.filter((c) => c.tag === "definition.class");
  for (const ref of superRefs) {
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

  // `@reference.mixin` captures from `include`/`extend`/`prepend` calls.
  const mixinRefs = captures.filter((c) => c.tag === "reference.mixin");
  for (const ref of mixinRefs) {
    const enclosing = innermostEnclosingContainer(ref, classDefs);
    if (enclosing === undefined) continue;
    const child = definitions.find(
      (d) => (d.kind === "Class" || d.kind === "Module") && d.startLine === enclosing.startLine,
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

export const rubyProvider: LanguageProvider = {
  id: "ruby",
  extensions: [".rb"],
  importSemantics: "named",
  mroStrategy: "c3",
  typeConfig: { structural: true, nominal: true, generics: false },
  heritageEdge: "EXTENDS",
  inferImplicitReceiver: () => "self",
  isExportedIdentifier: (name) => !name.startsWith("_"),

  extractDefinitions: extractRubyDefinitions,
  extractCalls: extractRubyCalls,
  extractImports: extractRubyImports,
  isExported: (def) => def.isExported,
  extractHeritage: extractRubyHeritage,
};
