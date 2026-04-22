/**
 * Shared property-access walker powering the ACCESSES-edge emitter.
 *
 * Per-function/method body, we scan the source text between `startLine` and
 * `endLine` (inclusive, 1-indexed) and look for:
 *   - Member expressions  (`a.b`)            → read
 *   - Assignment targets  (`a.b = ...`)      → write
 *   - Subscript accesses  (`a["b"]`)         → read (also "b" when LHS)
 *
 * We deliberately do not consume the tree-sitter parse tree: the unified
 * query does not surface member/attribute/assignment/subscript nodes. A
 * source-text walker that first strips comments + string literals via
 * {@link stripComments} is deterministic, language-agnostic, and avoids a
 * round-trip through the worker pool.
 *
 * Per-language providers pass a {@link PropertyAccessConfig} selecting which
 * flavour of assignment operators to treat as writes (Python augments include
 * `:=`; some languages use `=` only). The walker is careful to:
 *   - Skip property names that collide with keywords (`this`, `self`, `if`...).
 *   - Skip chained receivers (`a.b.c` → only the last segment is treated as
 *     a property read anchored to the *most recent* identifier).
 *   - Skip function-call members (`a.foo()` is a call, not a property read).
 *   - Skip optional chaining (`a?.b`) is kept (TS/JS-only; detected).
 *
 * Flat property names only (v2 scope): `user.address.street` yields reads
 * on `address` (for `user`) and `street` (for `address`). Qualified paths
 * are a future extension.
 */

import { stripComments } from "../providers/extract-helpers.js";
import type { ExtractedDefinition, PropertyAccess } from "../providers/extraction-types.js";

/**
 * Per-language tuning for the walker.
 *
 * `commentStripped`: passes the stripped string through verbatim when `true`
 *   (TS/JS/Python share the same stripping rules via
 *   {@link stripComments}; more exotic comment grammars can pre-process
 *   their source before calling the walker).
 *
 * `memberSeparator`: `.` for every language supported by v2. Kept as a
 *   parameter so a future Ruby / Kotlin / Swift addition can swap in `::`
 *   or `->` without forking the walker.
 *
 * `assignmentOperators`: regex alternation snippet matching the write
 *   operators the language recognises. TS/JS use `=`, `+=`, `-=`, etc.;
 *   Python additionally accepts `:=`.
 */
export interface PropertyAccessConfig {
  readonly commentStripped?: boolean;
  readonly memberSeparator: "." | "::" | "->";
  readonly assignmentOperators: readonly string[];
}

export const TS_ACCESS_CONFIG: PropertyAccessConfig = {
  commentStripped: true,
  memberSeparator: ".",
  // Per spec (ECMAScript + TS): `=`, `+=`, `-=`, `*=`, `/=`, `%=`, `**=`,
  // `<<=`, `>>=`, `>>>=`, `&=`, `|=`, `^=`, `&&=`, `||=`, `??=`.
  assignmentOperators: [
    "=",
    "+=",
    "-=",
    "*=",
    "/=",
    "%=",
    "**=",
    "<<=",
    ">>=",
    ">>>=",
    "&=",
    "|=",
    "^=",
    "&&=",
    "||=",
    "??=",
  ],
};

export const PYTHON_ACCESS_CONFIG: PropertyAccessConfig = {
  commentStripped: true,
  memberSeparator: ".",
  // Python augmented assignment ops + walrus.
  assignmentOperators: [
    "=",
    "+=",
    "-=",
    "*=",
    "/=",
    "//=",
    "%=",
    "**=",
    "&=",
    "|=",
    "^=",
    ">>=",
    "<<=",
    ":=",
  ],
};

/** Language keywords that may appear before a `.` but are not real receivers. */
const KEYWORD_RECEIVERS: ReadonlySet<string> = new Set([
  "if",
  "else",
  "for",
  "while",
  "return",
  "yield",
  "await",
  "throw",
  "new",
  "delete",
  "typeof",
  "void",
  "in",
  "of",
  "from",
  "as",
  "is",
  "and",
  "or",
  "not",
  "class",
  "function",
  "def",
  "lambda",
  "import",
  "export",
  "const",
  "let",
  "var",
  "true",
  "false",
  "null",
  "None",
  "True",
  "False",
  "undefined",
]);

interface EnclosingDef {
  readonly id: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly qualifiedName: string;
}

/**
 * Extract every property access inside the given function/method bodies.
 *
 * `enclosingDefs` is a filtered view of `definitions` (Function / Method /
 * Constructor kinds only) with pre-resolved `NodeId`s so the walker doesn't
 * re-derive them.
 */
export function extractPropertyAccesses(
  filePath: string,
  sourceText: string,
  enclosingDefs: readonly EnclosingDef[],
  config: PropertyAccessConfig,
): readonly PropertyAccess[] {
  if (enclosingDefs.length === 0) return [];

  const src = config.commentStripped === true ? stripComments(sourceText) : sourceText;
  const lines = src.split("\n");
  const out: PropertyAccess[] = [];

  // Sort by innermost-first: when a method sits inside a class declaration
  // (which itself might not be a Function/Method/Constructor), `findInnermost`
  // picks the tightest containing span.
  const sortedDefs = [...enclosingDefs].sort((a, b) => {
    const spanA = a.endLine - a.startLine;
    const spanB = b.endLine - b.startLine;
    return spanA - spanB;
  });

  const sep = escapeRegExp(config.memberSeparator);
  // Match `<receiver><sep><name>` where `<name>` is the bare identifier we
  // attribute the access to. `<receiver>` captures everything up to the
  // final separator so we can reject keyword-prefixed matches and chained
  // calls (`obj.foo().bar` should not yield a `foo` read — we detect the
  // `(` after `foo` below).
  //
  // `(?<![A-Za-z_$\w])` anchors the receiver to a fresh identifier start.
  // Named-capture groups chosen to read naturally at the use site.
  const memberRe = new RegExp(
    `(?<![A-Za-z_$\\w])(?<receiver>[A-Za-z_$][\\w$]*)\\s*\\??${sep}(?<name>[A-Za-z_$][\\w$]*)`,
    "g",
  );

  const subscriptRe =
    /(?<![A-Za-z_$\w])(?<receiver>[A-Za-z_$][\w$]*)\s*\[\s*(?<quote>['"])(?<name>[A-Za-z_$][\w$]*)\k<quote>\s*\]/g;

  // Pre-compile a regex that decides if the substring AFTER a member match
  // begins with an assignment operator. Longest-match-first so `+=` wins
  // over `=`.
  const opsByLength = [...config.assignmentOperators].sort((a, b) => b.length - a.length);
  const assignHead = new RegExp(`^\\s*(${opsByLength.map(escapeRegExp).join("|")})(?![<>=])`);

  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const enclosing = findInnermost(sortedDefs, lineNo);
    if (enclosing === undefined) continue;

    const line = lines[i] ?? "";

    // --- Member expressions (`a.b`, `a?.b`, `a.b = ...`). -------------------
    for (const m of line.matchAll(memberRe)) {
      const receiver = m.groups?.["receiver"];
      const name = m.groups?.["name"];
      if (receiver === undefined || name === undefined) continue;
      if (KEYWORD_RECEIVERS.has(receiver)) continue;

      const matchEnd = (m.index ?? 0) + m[0].length;
      const tail = line.slice(matchEnd);
      // Skip calls: `a.b(` or `a.b<Type>(` (TS generics). We want to keep
      // `a.b` as a property access ONLY when it is not the callee of a
      // function call. Method invocations are already modelled by CALLS.
      if (isCallTail(tail)) continue;

      const reason: "read" | "write" = isAssignmentTail(tail, assignHead) ? "write" : "read";
      out.push({
        enclosingSymbolId: enclosing.id,
        propertyName: name,
        reason,
        startLine: lineNo,
        endLine: lineNo,
        filePath,
      });
    }

    // --- Subscript with string literal (`a["b"]`, `a['b'] = ...`). ---------
    for (const m of line.matchAll(subscriptRe)) {
      const receiver = m.groups?.["receiver"];
      const name = m.groups?.["name"];
      if (receiver === undefined || name === undefined) continue;
      if (KEYWORD_RECEIVERS.has(receiver)) continue;

      const matchEnd = (m.index ?? 0) + m[0].length;
      const tail = line.slice(matchEnd);
      const reason: "read" | "write" = isAssignmentTail(tail, assignHead) ? "write" : "read";
      out.push({
        enclosingSymbolId: enclosing.id,
        propertyName: name,
        reason,
        startLine: lineNo,
        endLine: lineNo,
        filePath,
      });
    }
  }

  return sortAccesses(out);
}

/** Stable ordering: (enclosingSymbolId, propertyName, startLine, reason). */
export function sortAccesses(accesses: readonly PropertyAccess[]): readonly PropertyAccess[] {
  return [...accesses].sort((a, b) => {
    if (a.enclosingSymbolId !== b.enclosingSymbolId) {
      return a.enclosingSymbolId < b.enclosingSymbolId ? -1 : 1;
    }
    if (a.propertyName !== b.propertyName) {
      return a.propertyName < b.propertyName ? -1 : 1;
    }
    if (a.startLine !== b.startLine) return a.startLine - b.startLine;
    if (a.reason !== b.reason) return a.reason < b.reason ? -1 : 1;
    return 0;
  });
}

/** True when the character tail begins with `(` or `<...>(` (generic call). */
function isCallTail(tail: string): boolean {
  // Direct call: `foo(` possibly with whitespace.
  if (/^\s*\(/.test(tail)) return true;
  // TS generic call: `foo<A, B>(` — approximate, we only look for `<` then
  // bounded scan for `>(`.
  if (/^\s*</.test(tail)) {
    const close = tail.indexOf(">");
    if (close !== -1 && /^\s*\(/.test(tail.slice(close + 1))) return true;
  }
  return false;
}

function isAssignmentTail(tail: string, assignHead: RegExp): boolean {
  return assignHead.test(tail);
}

function findInnermost(
  sortedDefs: readonly EnclosingDef[],
  line: number,
): EnclosingDef | undefined {
  for (const d of sortedDefs) {
    if (line >= d.startLine && line <= d.endLine) return d;
  }
  return undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Convenience filter — providers call this to narrow the `ExtractedDefinition`
 * list down to callable owners, then hand each through `idForDefinition` from
 * the parse phase before invoking {@link extractPropertyAccesses}.
 */
export function callableDefs(defs: readonly ExtractedDefinition[]): readonly ExtractedDefinition[] {
  return defs.filter(
    (d) => d.kind === "Function" || d.kind === "Method" || d.kind === "Constructor",
  );
}
