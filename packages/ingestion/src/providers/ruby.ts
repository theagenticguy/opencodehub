import type { NodeKind } from "@opencodehub/core-types";
import {
  type CallsConfig,
  type DefinitionsConfig,
  dotPrefixReceiver,
  extractCallsGeneric,
  extractDefinitionsGeneric,
  extractHeritageRefBased,
  type HeritageConfig,
  kindFromMap,
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

const RUBY_DEFS_CONFIG: DefinitionsConfig = {
  kindFor: kindFromMap(RUBY_DEF_KIND_MAP),
  // Promote function -> method when nested in a class/module.
  promoteToMethod: (def, ownerDef) =>
    def.tag === "definition.function" &&
    (ownerDef?.tag === "definition.class" || ownerDef?.tag === "definition.module"),
  isExported: ({ name }) => !name.startsWith("_"),
};

function extractRubyDefinitions(input: ExtractDefinitionsInput): readonly ExtractedDefinition[] {
  return extractDefinitionsGeneric(input, RUBY_DEFS_CONFIG);
}

const RUBY_CALLS_CONFIG: CallsConfig = {
  // Drop pseudo-calls that are really import/mixin forms — we handle those in
  // extractImports / extractHeritage respectively.
  dropCalleeNames: new Set([
    "require",
    "require_relative",
    "load",
    "autoload",
    "include",
    "extend",
    "prepend",
  ]),
  // Receiver inference: `obj.method(...)`. Ruby also has `self.method` inside
  // class bodies. `@`-prefixed instance vars and `::`-scoped constants qualify.
  inferReceiver: dotPrefixReceiver(/^[A-Za-z_@][\w:]*$/),
};

function extractRubyCalls(input: ExtractCallsInput): readonly ExtractedCall[] {
  return extractCallsGeneric(input, RUBY_CALLS_CONFIG);
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
// Containers are `definition.class` ONLY — the hand-rolled body used
// `classDefs` for BOTH the superclass and the include/extend/prepend mixin
// walks (modules are eligible as CHILD kinds via `childKinds`, not as
// containers).
const RUBY_HERITAGE_CONFIG: HeritageConfig = {
  containerTags: ["definition.class"],
  rules: [
    // `@reference.class` captures from the `superclass` field.
    { refTag: "reference.class", relation: "EXTENDS", childKinds: ["Class"] },
    // `@reference.mixin` captures from `include`/`extend`/`prepend` calls.
    { refTag: "reference.mixin", relation: "IMPLEMENTS", childKinds: ["Class", "Module"] },
  ],
};

function extractRubyHeritage(input: ExtractHeritageInput): readonly ExtractedHeritage[] {
  return extractHeritageRefBased(input, RUBY_HERITAGE_CONFIG);
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
  complexityDefinitionKinds: ["method", "singleton_method", "lambda", "block", "do_block"],
  halsteadOperatorKinds: [
    "+",
    "-",
    "*",
    "/",
    "%",
    "**",
    "=",
    "==",
    "===",
    "!=",
    "<",
    ">",
    "<=",
    ">=",
    "<=>",
    "&&",
    "||",
    "and",
    "or",
    "not",
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
    "**=",
    "&&=",
    "||=",
    "?",
    ":",
    "=>",
  ],

  extractDefinitions: extractRubyDefinitions,
  extractCalls: extractRubyCalls,
  extractImports: extractRubyImports,
  isExported: (def) => def.isExported,
  extractHeritage: extractRubyHeritage,
};
