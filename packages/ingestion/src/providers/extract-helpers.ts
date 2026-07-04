/**
 * Shared helpers used by per-language extractors.
 *
 * Kept intentionally generic: none of these functions know about a specific
 * language's grammar. Per-language providers feed them filtered subsets of
 * {@link ParseCapture} and receive back plain records.
 */

import type { NodeKind } from "@opencodehub/core-types";
import type { ParseCapture } from "../parse/types.js";
import type { ExtractedCall, ExtractedDefinition, ExtractedHeritage } from "./extraction-types.js";
import type { ExtractCallsInput, ExtractDefinitionsInput, ExtractHeritageInput } from "./types.js";

/** One definition capture plus its inner `@name` capture (resolved by range). */
export interface PairedDefinition {
  readonly def: ParseCapture;
  readonly name: ParseCapture;
}

/**
 * Pair every `@definition.*` capture with the `@name` capture that lies
 * within its source range. Robust against match reordering: we use
 * positional containment rather than list adjacency.
 *
 * When multiple `@name` captures fall inside a single definition range
 * (e.g. a class body with methods), we pick the earliest `@name` whose
 * start line matches the definition's start line. Falls back to the
 * first inner `@name`.
 */
export function pairDefinitionsWithNames(
  captures: readonly ParseCapture[],
  defTagPrefix = "definition.",
): readonly PairedDefinition[] {
  const defs = captures.filter((c) => c.tag.startsWith(defTagPrefix));

  // Build the set of source positions that are ALSO tagged as a reference.
  // A `@name` that coincides with a `@reference.*` capture is almost always
  // a referenced type identifier (e.g. the receiver type in a Go method)
  // rather than the identifier we want to bind to the definition.
  const referencePositions = new Set<string>();
  for (const c of captures) {
    if (c.tag.startsWith("reference.")) {
      referencePositions.add(positionKey(c));
    }
  }
  // Deduplicate `@name` captures at the same source position — tree-sitter
  // can emit the same node under multiple patterns.
  const uniqueNames = dedupeByPosition(captures.filter((c) => c.tag === "name"));
  const declarationNames = uniqueNames.filter((c) => !referencePositions.has(positionKey(c)));

  const paired: PairedDefinition[] = [];
  for (const def of defs) {
    // Priority 1: a declaration name (not coinciding with a reference) on
    // the def's header line. This correctly picks `Greet` out of
    // `func (g *Greeter) Greet(...)` — `Greeter` is a reference-typed
    // identifier, `Greet` is the declaration.
    const headerDecls = declarationNames.filter(
      (n) => n.startLine === def.startLine && isInside(n, def),
    );
    if (headerDecls.length > 0) {
      // Earliest column — definitions tend to have their name earlier than
      // any trailing parameter identifiers on the same line.
      const sorted = [...headerDecls].sort((a, b) => a.startCol - b.startCol);
      paired.push({ def, name: sorted[0] as ParseCapture });
      continue;
    }

    // Priority 2: any name on the header line (recovers class/interface
    // declarations whose name is tagged with a `@reference.type` overlay).
    const headerNames = uniqueNames.filter(
      (n) => n.startLine === def.startLine && isInside(n, def),
    );
    if (headerNames.length > 0) {
      const sorted = [...headerNames].sort((a, b) => a.startCol - b.startCol);
      paired.push({ def, name: sorted[0] as ParseCapture });
      continue;
    }

    // Priority 3: declaration names anywhere inside the def range. Handles
    // module-scope `@definition.*` captures that span the whole file.
    let best = pickBestName(def, declarationNames);
    // Priority 4: fall back to any name at all.
    if (best === undefined) {
      best = pickBestName(def, uniqueNames);
    }
    if (best !== undefined) {
      paired.push({ def, name: best });
    }
  }
  return paired;
}

function pickBestName(
  def: ParseCapture,
  candidates: readonly ParseCapture[],
): ParseCapture | undefined {
  let best: ParseCapture | undefined;
  for (const n of candidates) {
    if (!isInside(n, def)) continue;
    if (best === undefined) {
      best = n;
      continue;
    }
    const bestAtHeader = best.startLine === def.startLine;
    const candAtHeader = n.startLine === def.startLine;
    if (candAtHeader && !bestAtHeader) {
      best = n;
    } else if (candAtHeader === bestAtHeader) {
      if (
        n.startLine < best.startLine ||
        (n.startLine === best.startLine && n.startCol < best.startCol)
      ) {
        best = n;
      }
    }
  }
  return best;
}

function dedupeByPosition(captures: readonly ParseCapture[]): ParseCapture[] {
  const seen = new Set<string>();
  const out: ParseCapture[] = [];
  for (const c of captures) {
    const k = positionKey(c);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

function positionKey(c: ParseCapture): string {
  return `${c.startLine}:${c.startCol}:${c.endLine}:${c.endCol}`;
}

/** True if `inner`'s range is inside `outer`'s range. */
export function isInside(inner: ParseCapture, outer: ParseCapture): boolean {
  if (inner.startLine < outer.startLine || inner.endLine > outer.endLine) {
    return false;
  }
  if (inner.startLine === outer.startLine && inner.startCol < outer.startCol) {
    return false;
  }
  if (inner.endLine === outer.endLine && inner.endCol > outer.endCol) {
    return false;
  }
  return true;
}

/**
 * Return the earliest `@name` capture that lies within `outer`'s range.
 * Used by per-language call extractors to resolve the callee identifier
 * inside a `reference.call` / `reference.send` capture.
 */
export function findNameInside(
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

/**
 * Resolve the qualified name of the definition that owns `def` (matched by
 * start line) from the already-extracted `definitions`. Falls back to
 * `"<module>"` for captures with no matching definition record.
 */
export function qualifiedForCapture(
  def: ParseCapture,
  definitions: readonly ExtractedDefinition[],
): string {
  for (const d of definitions) {
    if (d.startLine === def.startLine) return d.qualifiedName;
  }
  return "<module>";
}

/**
 * Return the innermost (smallest enclosing) definition that contains `inner`.
 *
 * Skips:
 *  - `inner` itself.
 *  - Any `@definition.module` capture — module/file-scoped defs are logical
 *    containers, not semantic owners.
 *  - Captures with an identical source range to `inner`. A grammar query
 *    can attach multiple `@definition.*` tags to the same node (e.g. a Go
 *    `type_declaration` hitting both `@definition.type` and
 *    `@definition.class`). Those are sibling records, not parent/child.
 */
// Tags that CAN be call-edge endpoints. `definition.property`,
// `definition.variable`, and `definition.constant` are deliberately excluded:
// attributing a call like `x = foo()` inside a class body to the assignment
// target `x` (which would tightly wrap the call site) instead of the
// enclosing method is almost never what callers of impact/context analysis
// want. The enclosing scope is what owns the call.
const CALLABLE_SCOPE_TAGS: ReadonlySet<string> = new Set([
  "definition.class",
  "definition.function",
  "definition.method",
  "definition.constructor",
  "definition.interface",
  "definition.type",
  "definition.trait",
]);

/**
 * Return the tightest-span capture from `containers` that contains `inner`.
 * Used by heritage extraction to attribute a base-class / interface
 * reference to the innermost enclosing class/struct/interface definition
 * rather than the outermost one. Without this, a nested class's base is
 * attributed to its enclosing parent, producing spurious MRO conflicts
 * (see strands-agents/sdk-python `LiteLLMModel.LiteLLMConfig`).
 */
export function innermostEnclosingContainer(
  inner: ParseCapture,
  containers: readonly ParseCapture[],
): ParseCapture | undefined {
  let best: ParseCapture | undefined;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const c of containers) {
    if (c === inner) continue;
    if (inner.startLine < c.startLine || inner.endLine > c.endLine) continue;
    const span = (c.endLine - c.startLine) * 1_000_000 + (c.endCol - c.startCol);
    if (span < bestSpan) {
      best = c;
      bestSpan = span;
    }
  }
  return best;
}

export function innermostEnclosingDef(
  inner: ParseCapture,
  defs: readonly ParseCapture[],
): ParseCapture | undefined {
  let best: ParseCapture | undefined;
  let bestSpan = Infinity;
  for (const d of defs) {
    if (d === inner) continue;
    if (!CALLABLE_SCOPE_TAGS.has(d.tag)) continue;
    if (
      d.startLine === inner.startLine &&
      d.endLine === inner.endLine &&
      d.startCol === inner.startCol &&
      d.endCol === inner.endCol
    ) {
      continue;
    }
    if (!isInside(inner, d)) continue;
    const span = (d.endLine - d.startLine) * 1_000_000 + (d.endCol - d.startCol);
    if (span < bestSpan) {
      best = d;
      bestSpan = span;
    }
  }
  return best;
}

/**
 * Read a single 1-indexed line from `sourceText`. Returns `""` when the
 * line is out of range (defensive against stale captures).
 */
export function getLine(sourceText: string, line1Indexed: number): string {
  if (line1Indexed <= 0) return "";
  // Split lazily: we only call this per-capture, usually small N.
  let current = 1;
  let start = 0;
  for (let i = 0; i < sourceText.length; i += 1) {
    if (sourceText.charCodeAt(i) === 10) {
      if (current === line1Indexed) {
        return sourceText.slice(start, i);
      }
      current += 1;
      start = i + 1;
    }
  }
  if (current === line1Indexed) {
    return sourceText.slice(start);
  }
  return "";
}

/**
 * Strip line + block comments from a source string. Used by import scanners
 * where a commented-out import would otherwise produce a spurious edge.
 *
 * Language-neutral implementation: understands `//` line comments, `/* ...`
 * block comments, and `#` line comments. Leaves string contents alone
 * (tracks single/double/backtick quotes).
 */
export function stripComments(src: string): string {
  const out: string[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    // Block comment
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) break;
      // Preserve newlines so line numbers in later extracts are stable.
      for (let j = i; j < end + 2; j += 1) {
        if (src.charCodeAt(j) === 10) out.push("\n");
      }
      i = end + 2;
      continue;
    }

    // Line comment (`//` or `#`). For `#`, only treat as comment when not
    // part of a `#!` shebang at file start — caller passes stripped text
    // otherwise. We keep the rule simple: both begin a line comment here.
    if ((c === "/" && next === "/") || c === "#") {
      while (i < n && src.charCodeAt(i) !== 10) i += 1;
      continue;
    }

    // Strings: skip the body verbatim, honoring escape sequences.
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out.push(c);
      i += 1;
      while (i < n) {
        const ch = src[i];
        out.push(ch as string);
        if (ch === "\\" && i + 1 < n) {
          // Preserve the escaped char.
          out.push(src[i + 1] as string);
          i += 2;
          continue;
        }
        i += 1;
        if (ch === quote) break;
      }
      continue;
    }

    out.push(c as string);
    i += 1;
  }
  return out.join("");
}

/**
 * A receiver-inference strategy: given the raw call-site text and the resolved
 * bare callee name, return the receiver (`obj` in `obj.method()`) or
 * `undefined` when none can be inferred. The per-language `extractCalls`
 * bodies differ ONLY in this function; {@link extractCallsGeneric} owns the
 * shared loop shell. The factories below produce the four distinct algorithms
 * the languages actually use — the `lastIndexOf(.name)` vs bare-`lastIndexOf`
 * target and the regex-vs-none guard are real behavioral differences and are
 * NOT collapsed into one form.
 */
export type InferReceiver = (refText: string, calleeName: string) => string | undefined;

/** Configuration for {@link extractCallsGeneric}. */
export interface CallsConfig {
  /**
   * Capture tags that mark a call site. Defaults to `["reference.call"]`;
   * C# adds `"reference.send"`.
   */
  readonly callTags?: readonly string[];
  /** Receiver-inference strategy. Omit for languages that emit no receiver (C). */
  readonly inferReceiver?: InferReceiver;
  /**
   * Callee names to drop entirely (pseudo-calls handled elsewhere). Ruby only:
   * `require` / `include` / etc. are import/mixin forms, not real calls.
   */
  readonly dropCalleeNames?: ReadonlySet<string>;
}

const DEFAULT_CALL_TAGS: readonly string[] = ["reference.call"];

/**
 * Strategy (A) — dot-prefix + regex guard.
 * `idx = refText.lastIndexOf(`.${callee}`)`; when `idx > 0`, take the trimmed
 * prefix and accept it as the receiver iff it is non-empty and matches `regex`.
 * Used by swift, ruby, dart, go, kotlin (each with its own regex).
 */
export function dotPrefixReceiver(regex: RegExp): InferReceiver {
  return (refText, calleeName) => {
    const idx = refText.lastIndexOf(`.${calleeName}`);
    if (idx > 0) {
      const prefix = refText.slice(0, idx).trim();
      if (prefix !== "" && regex.test(prefix)) return prefix;
    }
    return undefined;
  };
}

/**
 * Strategy (B) — dot-prefix, NO regex guard.
 * Same `lastIndexOf(`.${callee}`)` target but the only guard is `prefix !== ""`.
 * Used by csharp and java (java additionally short-circuits on
 * `!refText.includes(".")`, which is a no-op for the output since the
 * `lastIndexOf` would then return `-1` — sharing this factory is safe).
 */
export function dotPrefixNoRegexReceiver(): InferReceiver {
  return (refText, calleeName) => {
    const idx = refText.lastIndexOf(`.${calleeName}`);
    if (idx > 0) {
      const prefix = refText.slice(0, idx).trim();
      if (prefix !== "") return prefix;
    }
    return undefined;
  };
}

/**
 * Strategy (C) — bare-name `lastIndexOf` + strip trailing separator + regex.
 * `idx = refText.lastIndexOf(callee)` (BARE name, not `.${callee}`); the
 * trimmed prefix has a trailing separator stripped (`sepRe`, anchored `$`),
 * and the re-trimmed remainder is accepted iff non-empty and matches `regex`.
 * Used by cpp (`.` / `->` / `::`) and php (`->` / `::`).
 */
export function sepStripReceiver(sepRe: RegExp, regex: RegExp): InferReceiver {
  return (refText, calleeName) => {
    const idx = refText.lastIndexOf(calleeName);
    if (idx > 0) {
      const prefix = refText.slice(0, idx).trim();
      const stripped = prefix.replace(sepRe, "").trim();
      if (stripped !== "" && regex.test(stripped)) return stripped;
    }
    return undefined;
  };
}

/**
 * Strategy (D) — multi-separator preference loop, NO regex.
 * Tries `${sep}${callee}` for each `sep` in order; the first with `idx > 0`
 * and a non-empty trimmed prefix wins. Used by rust (`::` preferred, then `.`).
 */
export function multiSepReceiver(seps: readonly string[]): InferReceiver {
  return (refText, calleeName) => {
    for (const sep of seps) {
      const idx = refText.lastIndexOf(`${sep}${calleeName}`);
      if (idx > 0) {
        const prefix = refText.slice(0, idx).trim();
        if (prefix !== "") return prefix;
      }
    }
    return undefined;
  };
}

/**
 * Shared call-site extraction loop. Reproduces the skeleton every per-language
 * `extractCalls` body used to hand-roll:
 *   - filter definition captures + call-reference captures (by `config.callTags`)
 *   - for each call ref: resolve the inner `@name` (callee), optionally drop it
 *     ({@link CallsConfig.dropCalleeNames}), attribute it to the innermost
 *     enclosing definition, and run the per-language receiver strategy.
 *
 * Emits records byte-identical to the pre-refactor providers (locked by the
 * characterization harness). The `calleeOwner` field is spread conditionally so
 * an absent receiver never materializes as explicit `undefined`
 * (`exactOptionalPropertyTypes` is on).
 */
export function extractCallsGeneric(
  input: ExtractCallsInput,
  config: CallsConfig = {},
): readonly ExtractedCall[] {
  const { filePath, captures, definitions } = input;
  const callTags = config.callTags ?? DEFAULT_CALL_TAGS;
  const defCaptures = captures.filter((c) => c.tag.startsWith("definition."));
  const callRefs = captures.filter((c) => callTags.includes(c.tag));
  const out: ExtractedCall[] = [];

  for (const ref of callRefs) {
    const innerName = findNameInside(captures, ref);
    const calleeName = innerName?.text ?? ref.text;

    if (config.dropCalleeNames?.has(calleeName)) continue;

    const enclosingDef = innermostEnclosingDef(ref, defCaptures);
    const callerQualifiedName = enclosingDef
      ? qualifiedForCapture(enclosingDef, definitions)
      : "<module>";

    let receiver: string | undefined;
    if (innerName !== undefined && config.inferReceiver !== undefined) {
      receiver = config.inferReceiver(ref.text, innerName.text);
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

/**
 * Context handed to a {@link DefinitionsConfig.isExported} predicate. Bundles
 * the raw definition capture, the resolved bare `name`, the file `sourceText`
 * (so header-line providers can `getLine(sourceText, def.startLine)`), and the
 * innermost enclosing definition capture (`ownerDef`, when the def is nested).
 */
export interface DefinitionExportContext {
  readonly name: string;
  readonly def: ParseCapture;
  readonly sourceText: string;
  readonly ownerDef?: ParseCapture;
}

/**
 * Configuration for {@link extractDefinitionsGeneric}. Mirrors the
 * {@link CallsConfig} style: the generic owns the paired-loop + owner
 * derivation + qualifiedName + the push shape; the config supplies only the
 * per-language varying pieces.
 *
 * `kindFor` is deliberately a FUNCTION (not a `Record`): csharp and java
 * resolve the kind off `def.nodeType`, so a map cannot express them. The
 * Record-driven providers wrap their table with {@link kindFromMap} to stay
 * declarative — the two forms are NOT collapsed.
 */
export interface DefinitionsConfig {
  /** Resolve the {@link NodeKind} for a definition capture, or `undefined` to skip it. */
  readonly kindFor: (def: ParseCapture) => NodeKind | undefined;
  /** Per-language export predicate. See {@link DefinitionExportContext}. */
  readonly isExported: (ctx: DefinitionExportContext) => boolean;
  /**
   * Promote a `definition.function` to `"Method"` when nested in an allowed
   * owner type (swift/ruby/dart/kotlin). Return `true` to force `"Method"`;
   * omit for providers without function→method promotion.
   */
  readonly promoteToMethod?: (def: ParseCapture, ownerDef: ParseCapture | undefined) => boolean;
  /**
   * Compute an owner name directly from the source header, overriding the
   * innermost-enclosing-def walk (Go method receiver types). Return a
   * `{ owner }` wrapper to CLAIM the def — the walk is skipped and `owner`
   * (which may itself be `undefined`, e.g. an unparseable receiver) becomes the
   * owner. Return the bare `undefined` to decline, so the normal enclosing-def
   * walk runs. Go claims `definition.method` captures and declines all others,
   * mirroring the original `if (method) { owner = receiver } else { walk }`.
   */
  readonly ownerOverride?: (
    def: ParseCapture,
    sourceText: string,
  ) => { readonly owner: string | undefined } | undefined;
  /**
   * Drop a paired definition before it is emitted (Go's `definition.type`
   * dedup against a struct/interface at the same source position). Runs after
   * `kindFor` resolves a defined kind, before the record is pushed.
   */
  readonly skipDef?: (def: ParseCapture) => boolean;
  /**
   * When set, emit `isConst: /\bconst\b/.test(headerLine)` on records whose
   * kind is `"Const"` (ts/js). The header line is `getLine(sourceText,
   * def.startLine)`. Providers with a different `isConst` rule (python) stay
   * custom.
   */
  readonly wantsConst?: boolean;
}

/**
 * Adapt a `Record<tag, NodeKind>` table into the {@link DefinitionsConfig.kindFor}
 * function form. `noUncheckedIndexedAccess` makes `map[def.tag]` yield
 * `NodeKind | undefined`, which is exactly the `kindFor` contract.
 */
export function kindFromMap(
  map: Readonly<Record<string, NodeKind>>,
): (def: ParseCapture) => NodeKind | undefined {
  return (def) => map[def.tag];
}

/**
 * Shared definition-extraction loop. Reproduces the skeleton every per-language
 * `extractDefinitions` body used to hand-roll:
 *   - pair each `@definition.*` capture with its inner `@name`
 *     ({@link pairDefinitionsWithNames})
 *   - resolve the {@link NodeKind} ({@link DefinitionsConfig.kindFor}); skip
 *     when `undefined`
 *   - derive the owner via {@link innermostEnclosingDef}, unless
 *     {@link DefinitionsConfig.ownerOverride} yields a header-derived owner
 *   - optionally promote a nested function to `"Method"`
 *     ({@link DefinitionsConfig.promoteToMethod})
 *   - build the dotted `qualifiedName` and the per-language `isExported` flag
 *   - push the canonical record shape
 *
 * Emits records byte-identical to the pre-refactor providers (locked by the
 * characterization harness). `owner` and `isConst` are spread conditionally so
 * an absent value never materializes as explicit `undefined`
 * (`exactOptionalPropertyTypes` is on).
 */
export function extractDefinitionsGeneric(
  input: ExtractDefinitionsInput,
  config: DefinitionsConfig,
): readonly ExtractedDefinition[] {
  const { filePath, captures, sourceText } = input;
  const paired = pairDefinitionsWithNames(captures);
  const defCaptures = captures.filter((c) => c.tag.startsWith("definition."));
  const out: ExtractedDefinition[] = [];

  for (const { def, name } of paired) {
    let kind = config.kindFor(def);
    if (kind === undefined) continue;
    if (config.skipDef?.(def)) continue;

    let owner: string | undefined;
    const overridden = config.ownerOverride?.(def, sourceText);
    let ownerDef: ParseCapture | undefined;
    if (overridden !== undefined) {
      // The override CLAIMED this def — use its owner (possibly undefined) and
      // skip the enclosing-def walk entirely.
      owner = overridden.owner;
    } else {
      ownerDef = innermostEnclosingDef(def, defCaptures);
      if (ownerDef !== undefined) {
        const ownerPaired = paired.find((p) => p.def === ownerDef);
        if (ownerPaired !== undefined) owner = ownerPaired.name.text;
      }
    }

    if (config.promoteToMethod?.(def, ownerDef) === true) {
      kind = "Method";
    }

    const qualifiedName = owner !== undefined ? `${owner}.${name.text}` : name.text;
    const isExported = config.isExported({
      name: name.text,
      def,
      sourceText,
      ...(ownerDef !== undefined ? { ownerDef } : {}),
    });

    let isConst: boolean | undefined;
    if (config.wantsConst === true && kind === "Const") {
      isConst = /\bconst\b/.test(getLine(sourceText, def.startLine));
    }

    out.push({
      kind,
      name: name.text,
      qualifiedName,
      filePath,
      startLine: def.startLine,
      endLine: def.endLine,
      isExported,
      ...(owner !== undefined ? { owner } : {}),
      ...(isConst !== undefined ? { isConst } : {}),
    });
  }
  return out;
}

/**
 * One heritage rule: attribute every `refTag` capture enclosed by a container
 * to the enclosing definition, emitting a `relation` edge. `childKinds` gates
 * which enclosing definition kinds are eligible — the reference is dropped when
 * the innermost container's owning definition is not one of them.
 */
export interface HeritageRule {
  /** Capture tag that marks a parent reference, e.g. `"reference.class"`. */
  readonly refTag: string;
  /** Edge relation emitted for matches under this rule. */
  readonly relation: "EXTENDS" | "IMPLEMENTS";
  /** Definition kinds eligible to own a matched reference. */
  readonly childKinds: readonly NodeKind[];
}

/**
 * Configuration for {@link extractHeritageRefBased}. Mirrors the
 * {@link CallsConfig} / {@link DefinitionsConfig} style: the generic owns the
 * container-filter + innermost-enclosing walk + child lookup + push shape; the
 * config supplies only the per-language `containerTags` and the ordered
 * `rules`. Rules are applied IN ORDER, so a provider's block order maps 1:1 to
 * the rule order — keeping the pre-sort output identical to the hand-rolled
 * body (locked by the characterization harness).
 */
export interface HeritageConfig {
  /** Definition-capture tags eligible as heritage containers. */
  readonly containerTags: readonly string[];
  /** Per-reference rules, applied in order. */
  readonly rules: readonly HeritageRule[];
}

/**
 * Shared ref-based heritage-extraction loop. Reproduces the skeleton the
 * ref-based providers (swift/php/ruby/dart) hand-rolled per rule:
 *   - filter the container definition captures (by `config.containerTags`)
 *   - for each rule, filter the `refTag` captures, walk each to its innermost
 *     enclosing container ({@link innermostEnclosingContainer}), match the
 *     owning definition by start line + `childKinds`, and push a
 *     `{ childQualifiedName, parentName, filePath, relation, startLine }` edge
 *
 * Emits records byte-identical to the pre-refactor providers (locked by the
 * characterization harness). Languages with a bespoke heritage algorithm
 * (csharp header-regex, go structural method-set, ts-shared hybrid, java
 * single-inheritance) do NOT use this generic.
 */
export function extractHeritageRefBased(
  input: ExtractHeritageInput,
  config: HeritageConfig,
): readonly ExtractedHeritage[] {
  const { filePath, captures, definitions } = input;
  const containerDefs = captures.filter((c) => config.containerTags.includes(c.tag));
  const out: ExtractedHeritage[] = [];

  for (const rule of config.rules) {
    const refs = captures.filter((c) => c.tag === rule.refTag);
    for (const ref of refs) {
      const enclosing = innermostEnclosingContainer(ref, containerDefs);
      if (enclosing === undefined) continue;
      const child = definitions.find(
        (d) => rule.childKinds.includes(d.kind) && d.startLine === enclosing.startLine,
      );
      if (child === undefined) continue;
      out.push({
        childQualifiedName: child.qualifiedName,
        parentName: ref.text,
        filePath,
        relation: rule.relation,
        startLine: ref.startLine,
      });
    }
  }
  return out;
}

/**
 * Split a `foo, bar as baz, qux` list into per-entry records.
 * Used by TS/JS named-import parsing.
 */
export interface NamedImportEntry {
  readonly name: string;
  readonly alias?: string;
}
export function splitNamedImports(body: string): readonly NamedImportEntry[] {
  const parts = body
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const out: NamedImportEntry[] = [];
  for (const p of parts) {
    const m = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(p);
    if (m === null) continue;
    const name = m[1] as string;
    const alias = m[2];
    out.push(alias !== undefined ? { name, alias } : { name });
  }
  return out;
}
