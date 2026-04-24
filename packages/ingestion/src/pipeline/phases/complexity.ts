/**
 * Complexity phase — annotate Function / Method / Constructor nodes with
 * cyclomatic complexity, maximum nesting depth, NLOC, and Halstead volume.
 *
 * Runs after `parse` (it needs the definitions and their line ranges) and
 * before any phase that depends on complexity-derived signals (none yet at
 * MVP, but e.g. risk scoring will). The phase re-parses each source file
 * once with the same grammar used by `parse`, then walks the subtree of each
 * callable definition to compute:
 *
 *   - `cyclomaticComplexity`: 1 + the number of decision points in the body
 *     (branches, loops, short-circuit boolean operators, catch clauses, etc.
 *     — per-language lists below).
 *   - `nestingDepth`: maximum depth of nested block/statement nodes inside
 *     the body. An unnested body reports 0.
 *   - `nloc`: count of non-blank, non-comment-only physical lines between
 *     the definition's `startLine` and `endLine` (inclusive).
 *   - `halsteadVolume`: (N1+N2) * log2(n1+n2) Halstead volume computed from
 *     leaf-token operator vs operand counts. Requires the provider to
 *     declare a `halsteadOperatorKinds` list; omitted when absent.
 *
 * The phase mutates the shared {@link KnowledgeGraph} by re-adding each
 * callable node with the extra fields set; {@link KnowledgeGraph.addNode}
 * keeps the entry with more defined fields, so the annotated version wins.
 *
 * Determinism:
 *   - Files are iterated in sorted order.
 *   - Within each file, definitions are iterated in (startLine, qualifiedName)
 *     order — identical to the tiebreak the parse phase uses.
 *   - Tree-sitter cursor walks are deterministic per grammar.
 *
 * Robustness:
 *   - A missing file, empty body, or re-parse error increments `skipped`
 *     rather than throwing.
 *   - Providers without a `complexityDefinitionKinds` table cause that
 *     language's callables to be skipped with a single debug note — no
 *     throw.
 */

import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import type { GraphNode, NodeId, NodeKind } from "@opencodehub/core-types";
import { loadGrammar } from "../../parse/grammar-registry.js";
import type { LanguageId } from "../../parse/types.js";
import type { ExtractedDefinition } from "../../providers/extraction-types.js";
import { getProvider } from "../../providers/registry.js";
import type { PipelineContext, PipelinePhase } from "../types.js";
import { PARSE_PHASE_NAME, type ParseOutput } from "./parse.js";
import { SCAN_PHASE_NAME, type ScanOutput } from "./scan.js";

export const COMPLEXITY_PHASE_NAME = "complexity" as const;

export interface ComplexityOutput {
  readonly symbolsAnnotated: number;
  /** Callables whose complexity could not be computed (missing file, empty
   *  body, re-parse failure). Surfaced for diagnostics; never fatal. */
  readonly skipped: number;
}

export const complexityPhase: PipelinePhase<ComplexityOutput> = {
  name: COMPLEXITY_PHASE_NAME,
  deps: [PARSE_PHASE_NAME, SCAN_PHASE_NAME],
  async run(ctx, deps) {
    const parse = deps.get(PARSE_PHASE_NAME) as ParseOutput | undefined;
    const scan = deps.get(SCAN_PHASE_NAME) as ScanOutput | undefined;
    if (parse === undefined) {
      throw new Error("complexity: parse output missing from dependency map");
    }
    if (scan === undefined) {
      throw new Error("complexity: scan output missing from dependency map");
    }
    return runComplexity(ctx, parse, scan);
  },
};

// -------- module-local tree-sitter shim (main-thread, one parser per lang) --

const requireFn = createRequire(import.meta.url);

interface TsPoint {
  readonly row: number;
  readonly column: number;
}
interface TsNode {
  readonly type: string;
  readonly startPosition: TsPoint;
  readonly endPosition: TsPoint;
  readonly childCount: number;
  readonly namedChildCount: number;
  child(i: number): TsNode | null;
  namedChild(i: number): TsNode | null;
  childForFieldName?(name: string): TsNode | null;
  readonly text: string;
}
interface TsTree {
  readonly rootNode: TsNode;
}
interface TsParser {
  setLanguage(lang: unknown): void;
  parse(source: string): TsTree;
}
interface TsModule {
  new (): TsParser;
}

const parserCache = new Map<LanguageId, TsParser>();
let tsModuleCached: TsModule | undefined;

function getTsModule(): TsModule | undefined {
  if (tsModuleCached !== undefined) return tsModuleCached;
  try {
    tsModuleCached = requireFn("tree-sitter") as TsModule;
    return tsModuleCached;
  } catch {
    return undefined;
  }
}

async function getParser(lang: LanguageId): Promise<TsParser | undefined> {
  const cached = parserCache.get(lang);
  if (cached !== undefined) return cached;
  const TS = getTsModule();
  if (TS === undefined) return undefined;
  const handle = await loadGrammar(lang);
  const parser = new TS();
  parser.setLanguage(handle.tsLanguage);
  parserCache.set(lang, parser);
  return parser;
}

// -------- decision-point + nesting tables ----------------------------------

/**
 * Decision-point node-type sets. Each entry is the raw tree-sitter `type`
 * string that contributes +1 to cyclomatic complexity inside a function body.
 *
 * Sourced from the grammars used by `@opencodehub/ingestion`. Where a node
 * type represents a boolean short-circuit (`&&`, `||`), we further gate on
 * operator text at walk time to avoid counting arithmetic or bitwise
 * expressions that share the parent node kind.
 */
const DECISION_NODE_TYPES: Partial<Record<LanguageId, ReadonlySet<string>>> = {
  typescript: new Set([
    "if_statement",
    "while_statement",
    "do_statement",
    "for_statement",
    "for_in_statement",
    "case_clause",
    "catch_clause",
    "ternary_expression",
    "binary_expression",
  ]),
  tsx: new Set([
    "if_statement",
    "while_statement",
    "do_statement",
    "for_statement",
    "for_in_statement",
    "case_clause",
    "catch_clause",
    "ternary_expression",
    "binary_expression",
  ]),
  javascript: new Set([
    "if_statement",
    "while_statement",
    "do_statement",
    "for_statement",
    "for_in_statement",
    "case_clause",
    "catch_clause",
    "ternary_expression",
    "binary_expression",
  ]),
  python: new Set([
    "if_statement",
    "elif_clause",
    "while_statement",
    "for_statement",
    "except_clause",
    "boolean_operator",
    "conditional_expression",
    "match_statement",
    "case_clause",
  ]),
  go: new Set([
    "if_statement",
    "for_statement",
    "expression_case",
    "type_case",
    "communication_case",
    "binary_expression",
  ]),
  rust: new Set([
    "if_expression",
    "while_expression",
    "for_expression",
    "while_let_expression",
    "loop_expression",
    "match_arm",
    "binary_expression",
    "try_expression",
  ]),
  java: new Set([
    "if_statement",
    "while_statement",
    "do_statement",
    "for_statement",
    "enhanced_for_statement",
    "switch_label",
    "catch_clause",
    "ternary_expression",
    "binary_expression",
  ]),
  csharp: new Set([
    "if_statement",
    "while_statement",
    "do_statement",
    "for_statement",
    "for_each_statement",
    "case_switch_label",
    "catch_clause",
    "conditional_expression",
    "binary_expression",
    "switch_expression_arm",
  ]),
};

/** Node types whose presence increases nesting depth by 1. */
const NESTING_NODE_TYPES: Partial<Record<LanguageId, ReadonlySet<string>>> = {
  typescript: new Set([
    "if_statement",
    "while_statement",
    "do_statement",
    "for_statement",
    "for_in_statement",
    "switch_statement",
    "try_statement",
    "catch_clause",
  ]),
  tsx: new Set([
    "if_statement",
    "while_statement",
    "do_statement",
    "for_statement",
    "for_in_statement",
    "switch_statement",
    "try_statement",
    "catch_clause",
  ]),
  javascript: new Set([
    "if_statement",
    "while_statement",
    "do_statement",
    "for_statement",
    "for_in_statement",
    "switch_statement",
    "try_statement",
    "catch_clause",
  ]),
  python: new Set([
    "if_statement",
    "elif_clause",
    "else_clause",
    "while_statement",
    "for_statement",
    "try_statement",
    "except_clause",
    "with_statement",
    "match_statement",
  ]),
  go: new Set([
    "if_statement",
    "for_statement",
    "expression_switch_statement",
    "type_switch_statement",
    "select_statement",
  ]),
  rust: new Set([
    "if_expression",
    "while_expression",
    "while_let_expression",
    "for_expression",
    "loop_expression",
    "match_expression",
    "match_arm",
  ]),
  java: new Set([
    "if_statement",
    "while_statement",
    "do_statement",
    "for_statement",
    "enhanced_for_statement",
    "switch_statement",
    "try_statement",
    "catch_clause",
  ]),
  csharp: new Set([
    "if_statement",
    "while_statement",
    "do_statement",
    "for_statement",
    "for_each_statement",
    "switch_statement",
    "try_statement",
    "catch_clause",
  ]),
};

/**
 * Per-language definition-node lookup. Populated lazily from each
 * provider's {@link LanguageProvider.complexityDefinitionKinds}. Missing
 * providers return `undefined`; the phase skips those languages with a
 * single debug note per language.
 */
const definitionTypeCache = new Map<LanguageId, ReadonlySet<string> | undefined>();
function definitionTypesFor(lang: LanguageId): ReadonlySet<string> | undefined {
  if (definitionTypeCache.has(lang)) return definitionTypeCache.get(lang);
  let provider: ReturnType<typeof getProvider> | undefined;
  try {
    provider = getProvider(lang);
  } catch {
    provider = undefined;
  }
  const kinds = provider?.complexityDefinitionKinds;
  const set = kinds !== undefined && kinds.length > 0 ? new Set(kinds) : undefined;
  definitionTypeCache.set(lang, set);
  return set;
}

/** Per-language Halstead operator lookup — same semantics as above. */
const halsteadOperatorCache = new Map<LanguageId, ReadonlySet<string> | undefined>();
function halsteadOperatorsFor(lang: LanguageId): ReadonlySet<string> | undefined {
  if (halsteadOperatorCache.has(lang)) return halsteadOperatorCache.get(lang);
  let provider: ReturnType<typeof getProvider> | undefined;
  try {
    provider = getProvider(lang);
  } catch {
    provider = undefined;
  }
  const kinds = provider?.halsteadOperatorKinds;
  const set = kinds !== undefined && kinds.length > 0 ? new Set(kinds) : undefined;
  halsteadOperatorCache.set(lang, set);
  return set;
}

/** Single-line comment prefixes per language. Used by NLOC. */
const LINE_COMMENT_PREFIX: Partial<Record<LanguageId, readonly string[]>> = {
  typescript: ["//"],
  tsx: ["//"],
  javascript: ["//"],
  python: ["#"],
  go: ["//"],
  rust: ["//"],
  java: ["//"],
  csharp: ["//"],
};

// -------- traversal primitives ---------------------------------------------

/** Pre-order iterator over a tree-sitter subtree. */
function* walk(node: TsNode): IterableIterator<TsNode> {
  yield node;
  const n = node.childCount;
  for (let i = 0; i < n; i++) {
    const child = node.child(i);
    if (child !== null) yield* walk(child);
  }
}

function countDecisionsIn(body: TsNode, lang: LanguageId): number {
  const decisions = DECISION_NODE_TYPES[lang];
  const definitions = definitionTypesFor(lang);
  if (decisions === undefined || definitions === undefined) return 0;
  let count = 0;

  const stack: { node: TsNode; skip: boolean }[] = [{ node: body, skip: false }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    const { node, skip } = frame;
    if (!skip && decisions.has(node.type)) {
      if (contributesToCyclomatic(node, lang)) {
        count += 1;
      }
    }
    // Do NOT descend into nested function/method/constructor definitions —
    // their complexity belongs to their own node, not to ours.
    const enteringNested = node !== body && definitions.has(node.type);
    const nChildren = node.childCount;
    for (let i = nChildren - 1; i >= 0; i--) {
      const child = node.child(i);
      if (child !== null) {
        stack.push({ node: child, skip: enteringNested });
      }
    }
  }
  return count;
}

/**
 * Only short-circuit boolean operators contribute to cyclomatic complexity.
 * Tree-sitter exposes the operator text on a child node for `binary_expression`
 * in the TS/JS/Go/Rust/Java/C# grammars; `boolean_operator` (Python) is
 * structurally already boolean so every instance counts.
 */
function contributesToCyclomatic(node: TsNode, lang: LanguageId): boolean {
  if (node.type !== "binary_expression") return true;
  // Find operator child; child(1) is typically the operator token.
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c === null) continue;
    const t = c.type;
    if (t === "&&" || t === "||") return true;
  }
  // Rust uses the same `binary_expression` node for `&&` / `||`; the check
  // above also covers it. Go's `&&`/`||` are tokens named by their literal.
  void lang;
  return false;
}

function maxNestingIn(body: TsNode, lang: LanguageId): number {
  const nesting = NESTING_NODE_TYPES[lang];
  const definitions = definitionTypesFor(lang);
  if (nesting === undefined || definitions === undefined) return 0;
  let best = 0;

  // Recursive walker with an explicit stack to avoid stack-overflow on huge
  // functions. Entries: (node, currentDepth, skipSubtree).
  const stack: { node: TsNode; depth: number; skip: boolean }[] = [
    { node: body, depth: 0, skip: false },
  ];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    const { node, depth, skip } = frame;
    let nextDepth = depth;
    if (!skip && node !== body && nesting.has(node.type)) {
      nextDepth = depth + 1;
      if (nextDepth > best) best = nextDepth;
    }
    const enteringNested = node !== body && definitions.has(node.type);
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.child(i);
      if (child !== null) {
        stack.push({ node: child, depth: nextDepth, skip: enteringNested });
      }
    }
  }
  return best;
}

// -------- NLOC --------------------------------------------------------------

function computeNloc(
  sourceText: string,
  startLine1: number,
  endLine1: number,
  lang: LanguageId,
): number {
  const lines = sourceText.split("\n");
  const from = Math.max(0, startLine1 - 1);
  const to = Math.min(lines.length - 1, endLine1 - 1);
  const prefixes = LINE_COMMENT_PREFIX[lang] ?? [];
  let count = 0;
  let inPythonDocstring = false;
  for (let i = from; i <= to; i++) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    // Python: skip lines that are entirely a triple-quoted docstring range.
    // We detect a simple toggle on `"""` or `'''`.
    if (lang === "python") {
      const opensClose = countTripleQuotes(trimmed);
      if (inPythonDocstring) {
        if (opensClose % 2 === 1) inPythonDocstring = false;
        continue;
      }
      if ((trimmed.startsWith('"""') || trimmed.startsWith("'''")) && opensClose % 2 === 1) {
        inPythonDocstring = true;
        continue;
      }
      if (
        (trimmed.startsWith('"""') && trimmed.endsWith('"""') && trimmed.length > 3) ||
        (trimmed.startsWith("'''") && trimmed.endsWith("'''") && trimmed.length > 3)
      ) {
        continue;
      }
    }
    let isCommentOnly = false;
    for (const prefix of prefixes) {
      if (trimmed.startsWith(prefix)) {
        isCommentOnly = true;
        break;
      }
    }
    if (isCommentOnly) continue;
    count += 1;
  }
  return count;
}

function countTripleQuotes(s: string): number {
  let n = 0;
  for (let i = 0; i + 2 < s.length + 1; i++) {
    if (s.startsWith('"""', i) || s.startsWith("'''", i)) {
      n += 1;
      i += 2;
    }
  }
  return n;
}

// -------- main driver ------------------------------------------------------

const CALLABLE_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  "Function",
  "Method",
  "Constructor",
]);

async function runComplexity(
  ctx: PipelineContext,
  parse: ParseOutput,
  scan: ScanOutput,
): Promise<ComplexityOutput> {
  const absByRel = new Map<string, string>();
  const langByRel = new Map<string, LanguageId>();
  for (const f of scan.files) {
    if (f.language === undefined) continue;
    absByRel.set(f.relPath, f.absPath);
    langByRel.set(f.relPath, f.language);
  }

  let annotated = 0;
  let skipped = 0;

  // Sorted file traversal for determinism.
  const files = [...parse.definitionsByFile.keys()].sort();
  for (const filePath of files) {
    const defs = parse.definitionsByFile.get(filePath) ?? [];
    const callableDefs = defs.filter((d) => CALLABLE_KINDS.has(d.kind));
    if (callableDefs.length === 0) continue;

    const lang = langByRel.get(filePath);
    const abs = absByRel.get(filePath);
    if (lang === undefined || abs === undefined) {
      skipped += callableDefs.length;
      continue;
    }

    const parser = await getParser(lang);
    if (parser === undefined) {
      skipped += callableDefs.length;
      continue;
    }

    let sourceText: string;
    try {
      sourceText = await fs.readFile(abs, "utf8");
    } catch (err) {
      ctx.onProgress?.({
        phase: COMPLEXITY_PHASE_NAME,
        kind: "warn",
        message: `complexity: cannot read ${filePath}: ${(err as Error).message}`,
      });
      skipped += callableDefs.length;
      continue;
    }

    let tree: TsTree;
    try {
      tree = parser.parse(sourceText);
    } catch (err) {
      ctx.onProgress?.({
        phase: COMPLEXITY_PHASE_NAME,
        kind: "warn",
        message: `complexity: parse failed for ${filePath}: ${(err as Error).message}`,
      });
      skipped += callableDefs.length;
      continue;
    }

    const defTypesForLang = definitionTypesFor(lang);
    if (defTypesForLang === undefined) {
      // Provider did not declare `complexityDefinitionKinds`. Emit a single
      // debug note per language (via the progress callback), skip the
      // callables, and stay forward-compatible for future providers.
      ctx.onProgress?.({
        phase: COMPLEXITY_PHASE_NAME,
        kind: "warn",
        message: `complexity: language "${lang}" provider missing complexityDefinitionKinds; skipping`,
      });
      skipped += callableDefs.length;
      continue;
    }
    const defNodes = collectDefinitionNodes(tree.rootNode, defTypesForLang);

    // Sort for determinism.
    const sortedDefs = [...callableDefs].sort((a, b) => {
      if (a.startLine !== b.startLine) return a.startLine - b.startLine;
      if (a.qualifiedName < b.qualifiedName) return -1;
      if (a.qualifiedName > b.qualifiedName) return 1;
      return 0;
    });

    for (const def of sortedDefs) {
      const subtree = matchSubtree(defNodes, def);
      if (subtree === undefined) {
        skipped += 1;
        continue;
      }
      const body = selectBody(subtree) ?? subtree;
      if (body.endPosition.row <= body.startPosition.row && body.childCount === 0) {
        skipped += 1;
        continue;
      }
      const decisions = countDecisionsIn(body, lang);
      const cyclomaticComplexity = 1 + decisions;
      const nestingDepth = maxNestingIn(body, lang);
      const nloc = computeNloc(sourceText, def.startLine, def.endLine, lang);
      const halsteadVolume = computeHalsteadVolume(body, lang);

      const updated = annotateNode(
        ctx,
        def,
        cyclomaticComplexity,
        nestingDepth,
        nloc,
        halsteadVolume,
      );
      if (updated) {
        annotated += 1;
      } else {
        skipped += 1;
      }
    }
  }

  return { symbolsAnnotated: annotated, skipped };
}

function collectDefinitionNodes(root: TsNode, defTypes: ReadonlySet<string>): TsNode[] {
  const out: TsNode[] = [];
  for (const n of walk(root)) {
    if (defTypes.has(n.type)) out.push(n);
  }
  return out;
}

/**
 * Match a subtree to an {@link ExtractedDefinition} by line range. Tree-sitter
 * `startPosition.row` is 0-indexed; ExtractedDefinition.startLine is 1-indexed.
 * We compare the 1-indexed form on both sides.
 */
function matchSubtree(candidates: readonly TsNode[], def: ExtractedDefinition): TsNode | undefined {
  let best: TsNode | undefined;
  let bestRangeWidth = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const cStart = c.startPosition.row + 1;
    const cEnd = c.endPosition.row + 1;
    if (cStart > def.startLine || cEnd < def.endLine) continue;
    // Prefer the tightest enclosing candidate.
    const width = cEnd - cStart;
    if (width < bestRangeWidth) {
      bestRangeWidth = width;
      best = c;
    }
  }
  return best;
}

/** Pick the body node when the function itself is a declaration shell. */
function selectBody(def: TsNode): TsNode | undefined {
  if (def.childForFieldName !== undefined) {
    const named = def.childForFieldName("body");
    if (named !== null && named !== undefined) return named;
  }
  // Fallback: last named child tends to be the block in most grammars.
  for (let i = def.childCount - 1; i >= 0; i--) {
    const c = def.child(i);
    if (c === null) continue;
    if (c.type.includes("block") || c.type.includes("body")) return c;
  }
  return undefined;
}

function annotateNode(
  ctx: PipelineContext,
  def: ExtractedDefinition,
  cyclomaticComplexity: number,
  nestingDepth: number,
  nloc: number,
  halsteadVolume: number | undefined,
): boolean {
  const existing = findCallableNode(ctx, def);
  if (existing === undefined) return false;
  const updated: GraphNode = withComplexity(
    existing,
    cyclomaticComplexity,
    nestingDepth,
    nloc,
    halsteadVolume,
  );
  ctx.graph.addNode(updated);
  return true;
}

function findCallableNode(ctx: PipelineContext, def: ExtractedDefinition): GraphNode | undefined {
  // Iterate graph nodes looking for an exact id/filePath/name match. The
  // graph holds ~O(symbols) entries; this is O(N) per definition but the
  // call cost is dominated by parse IO, so we stay simple.
  for (const n of ctx.graph.nodes()) {
    if (!CALLABLE_KINDS.has(n.kind)) continue;
    if (n.filePath !== def.filePath) continue;
    if (n.name !== def.name) continue;
    if (n.kind !== def.kind) continue;
    // Only callable nodes carry startLine; the CALLABLE_KINDS guard above
    // narrows `n` to a LocatedNode in practice, but TS cannot see it here
    // because the GraphNode union also contains kinds without startLine.
    const nodeWithLine = n as unknown as { readonly startLine?: number };
    if (nodeWithLine.startLine !== def.startLine) continue;
    return n;
  }
  return undefined;
}

function withComplexity(
  node: GraphNode,
  cyclomaticComplexity: number,
  nestingDepth: number,
  nloc: number,
  halsteadVolume: number | undefined,
): GraphNode {
  // Only callable kinds carry these fields; other kinds fall through
  // unchanged, matching the optional-field contract in core-types.
  if (node.kind === "Function" || node.kind === "Method" || node.kind === "Constructor") {
    return {
      ...node,
      cyclomaticComplexity,
      nestingDepth,
      nloc,
      ...(halsteadVolume !== undefined ? { halsteadVolume } : {}),
    } as GraphNode;
  }
  return node;
}

// -------- Halstead volume --------------------------------------------------

/**
 * Compute the Halstead volume for a function body.
 *
 * Halstead's metric treats every token as either an "operator" or an
 * "operand". Operators are the syntactic tokens that perform work
 * (`+`, `&&`, `=`, `if`, `return`, …); operands are the identifiers and
 * literals they act on.
 *
 * Volume V = (N1 + N2) * log2(n1 + n2), where:
 *   - n1 = unique operator count
 *   - n2 = unique operand count
 *   - N1 = total operator occurrences
 *   - N2 = total operand occurrences
 *
 * Returns `undefined` when the provider did not declare
 * `halsteadOperatorKinds` or when the body contains no countable tokens.
 */
function computeHalsteadVolume(body: TsNode, lang: LanguageId): number | undefined {
  const operators = halsteadOperatorsFor(lang);
  if (operators === undefined) return undefined;
  const definitions = definitionTypesFor(lang);
  if (definitions === undefined) return undefined;

  const operatorCounts = new Map<string, number>();
  const operandCounts = new Map<string, number>();

  // Iterative walk; avoids stack overflow on very large functions. We do
  // not descend into nested function/method definitions — their tokens
  // belong to their own volume computation.
  const stack: { node: TsNode; skip: boolean }[] = [{ node: body, skip: false }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    const { node, skip } = frame;
    if (skip) continue;

    const enteringNested = node !== body && definitions.has(node.type);

    // Leaf = no children. A leaf's `type` holds either a token ("+") or a
    // semantic name ("identifier", "number", "string"); we bucket by type
    // string. Non-leaf internal nodes do not contribute tokens on their own.
    if (node.childCount === 0) {
      const t = node.type;
      if (operators.has(t)) {
        operatorCounts.set(t, (operatorCounts.get(t) ?? 0) + 1);
      } else if (isHalsteadOperand(t)) {
        // Use the operand text so `x` and `y` are distinct identifiers.
        // Fall back to the type string if the text is empty (guard against
        // grammars that return empty leaves for synthesized tokens).
        const key = node.text.length > 0 ? `${t}:${node.text}` : t;
        operandCounts.set(key, (operandCounts.get(key) ?? 0) + 1);
      }
      continue;
    }

    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.child(i);
      if (child !== null) {
        stack.push({ node: child, skip: enteringNested });
      }
    }
  }

  const n1 = operatorCounts.size;
  const n2 = operandCounts.size;
  let N1 = 0;
  let N2 = 0;
  for (const v of operatorCounts.values()) N1 += v;
  for (const v of operandCounts.values()) N2 += v;

  const totalVocab = n1 + n2;
  if (totalVocab === 0) return undefined;
  if (totalVocab === 1) return 0;
  const volume = (N1 + N2) * Math.log2(totalVocab);
  return Number.isFinite(volume) ? volume : undefined;
}

/** Leaf-node type names we treat as Halstead operands. */
const HALSTEAD_OPERAND_TYPES: ReadonlySet<string> = new Set([
  "identifier",
  "property_identifier",
  "type_identifier",
  "field_identifier",
  "shorthand_property_identifier",
  "namespace_identifier",
  "package_identifier",
  "simple_identifier",
  "constant",
  "number",
  "integer",
  "integer_literal",
  "float",
  "float_literal",
  "string",
  "string_literal",
  "string_content",
  "raw_string_literal",
  "true",
  "false",
  "null",
  "nil",
  "undefined",
  "none",
  "None",
  "boolean_literal",
  "char_literal",
  "character_literal",
  "escape_sequence",
  "regex",
  "regex_pattern",
  "self",
  "super",
  "this",
]);

function isHalsteadOperand(type: string): boolean {
  return HALSTEAD_OPERAND_TYPES.has(type);
}

// Re-export the NodeId type name so downstream phases can refer to the exact
// identity we annotate. Not strictly required — kept for symmetry with
// sibling phase modules.
export type { NodeId };
