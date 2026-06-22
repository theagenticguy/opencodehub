/**
 * Business-logic phase — annotate Function / Method / Constructor / Class /
 * Interface / Struct nodes with two advisory concern tags:
 *
 *   - `likelyPlumbing`   (precision-first, ~0.94): the symbol is almost
 *     certainly plumbing (serialization, DTO mapping, transport, DI wiring).
 *   - `candidateBusiness` (recall-first, ~0.93): the recall-first complement —
 *     everything the sieve did NOT classify as plumbing is a "look here for
 *     domain logic" candidate.
 *
 * The user gets both tags from `codehub analyze` with no query, no labels, no
 * embeddings. They land in `nodes.payload` and are reachable via SQLite JSON1
 * (`payload->>'$.candidateBusiness'`).
 *
 * ## How it works
 *
 *   1. For each in-scope definition, slice its source body from the scanned
 *      file (start/end lines from the parse phase).
 *   2. {@link computePlumbingFeatures} reduces the body (+ class head) to the
 *      small deterministic feature vector the sieve consumes.
 *   3. {@link classifyPlumbing} / {@link classifyBusinessCandidate} (the merged,
 *      validated `@opencodehub/analysis` kernels) produce the two tags.
 *   4. The node is re-added with the tags set; {@link KnowledgeGraph.addNode}
 *      keeps the entry with more defined fields, so the annotated version wins
 *      (same merge contract the complexity phase relies on).
 *
 * ## Validated languages only
 *
 * The sieve's precision floor was measured on Python, Java, and Go. Other
 * languages are SKIPPED (no tag emitted) rather than given an unbacked verdict
 * — `SIEVE_VALIDATED_LANGUAGES` gates the per-file loop.
 *
 * ## Determinism
 *
 * Files iterated in sorted order; definitions in (startLine, qualifiedName)
 * order — identical to the complexity phase. {@link computePlumbingFeatures}
 * and both kernels are pure, so the tags are byte-stable across runs and safe
 * under the `graphHash` contract.
 */

import { promises as fs } from "node:fs";
import {
  classifyBusinessCandidate,
  classifyPlumbing,
  type PlumbingFeatures,
} from "@opencodehub/analysis";
import type { GraphNode, NodeKind } from "@opencodehub/core-types";
import { computePlumbingFeatures } from "../../extract/business-logic-features.js";
import type { LanguageId } from "../../providers/types.js";
import type { PipelineContext, PipelinePhase } from "../types.js";
import { PARSE_PHASE_NAME, type ParseOutput } from "./parse.js";
import { SCAN_PHASE_NAME, type ScanOutput } from "./scan.js";

export const BUSINESS_LOGIC_PHASE_NAME = "business-logic" as const;

export interface BusinessLogicOutput {
  /** Symbols that received a tag (either likelyPlumbing or candidateBusiness). */
  readonly symbolsTagged: number;
  /** Symbols tagged as confident plumbing. */
  readonly plumbing: number;
  /** Symbols tagged as business candidates. */
  readonly candidates: number;
  /** Definitions skipped (unvalidated language, unreadable file, no node). */
  readonly skipped: number;
}

/** Languages the sieve is validated on. Maps the analysis-layer string set to
 *  the ingestion {@link LanguageId} union so the per-file gate is type-checked. */
const VALIDATED_LANGS: ReadonlySet<LanguageId> = new Set<LanguageId>(["python", "java", "go"]);

/** The lang string the extractor expects (narrowed from the validated set). */
type SieveLang = "python" | "java" | "go";

/** Kinds the sieve tags: callables plus the class-like kinds (entities carry
 *  domain methods; the ORM-model signal is class-head based). */
const TAGGABLE_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  "Function",
  "Method",
  "Constructor",
  "Class",
  "Interface",
  "Struct",
]);

export const businessLogicPhase: PipelinePhase<BusinessLogicOutput> = {
  name: BUSINESS_LOGIC_PHASE_NAME,
  deps: [PARSE_PHASE_NAME, SCAN_PHASE_NAME],
  async run(ctx, deps) {
    const parse = deps.get(PARSE_PHASE_NAME) as ParseOutput | undefined;
    const scan = deps.get(SCAN_PHASE_NAME) as ScanOutput | undefined;
    if (parse === undefined) {
      throw new Error("business-logic: parse output missing from dependency map");
    }
    if (scan === undefined) {
      throw new Error("business-logic: scan output missing from dependency map");
    }
    return runBusinessLogic(ctx, parse, scan);
  },
};

export async function runBusinessLogic(
  ctx: PipelineContext,
  parse: ParseOutput,
  scan: ScanOutput,
): Promise<BusinessLogicOutput> {
  const absByRel = new Map<string, string>();
  const langByRel = new Map<string, LanguageId>();
  for (const f of scan.files) {
    if (f.language === undefined) continue;
    absByRel.set(f.relPath, f.absPath);
    langByRel.set(f.relPath, f.language);
  }

  // Index taggable graph nodes by the same 4-tuple the complexity phase uses,
  // so each definition resolves with one Map.get instead of a full-graph scan.
  const nodeIndex = buildNodeIndex(ctx);

  let symbolsTagged = 0;
  let plumbing = 0;
  let candidates = 0;
  let skipped = 0;

  const files = [...parse.definitionsByFile.keys()].sort();
  const sourceCache = new Map<string, string[] | null>();

  for (const filePath of files) {
    const lang = langByRel.get(filePath);
    if (lang === undefined || !VALIDATED_LANGS.has(lang)) continue; // unvalidated → skip silently
    const sieveLang = lang as SieveLang;

    const defs = (parse.definitionsByFile.get(filePath) ?? []).filter((d) =>
      TAGGABLE_KINDS.has(d.kind),
    );
    if (defs.length === 0) continue;

    const lines = await loadLines(absByRel.get(filePath), sourceCache, ctx, filePath);
    if (lines === null) {
      skipped += defs.length;
      continue;
    }

    // Deterministic order, matching the complexity phase tiebreak.
    const sorted = [...defs].sort((a, b) => {
      if (a.startLine !== b.startLine) return a.startLine - b.startLine;
      return a.qualifiedName < b.qualifiedName ? -1 : a.qualifiedName > b.qualifiedName ? 1 : 0;
    });

    for (const def of sorted) {
      const node = nodeIndex.get(nodeKey(def.filePath, def.name, def.kind, def.startLine));
      if (node === undefined) {
        skipped += 1;
        continue;
      }
      const bodyText = sliceBody(lines, def.startLine, def.endLine);
      const isClassLike = def.kind === "Class" || def.kind === "Interface" || def.kind === "Struct";
      const classHeadText = isClassLike ? sliceClassHead(lines, def.startLine) : undefined;

      const features: PlumbingFeatures = computePlumbingFeatures({
        symbolName: def.name,
        kind: def.kind,
        bodyText,
        ...(classHeadText !== undefined ? { classHeadText } : {}),
        lang: sieveLang,
      });

      const sieve = classifyPlumbing(features);
      const candidate = classifyBusinessCandidate(features);

      ctx.graph.addNode(withTags(node, sieve.likelyPlumbing, candidate.candidateBusiness));

      symbolsTagged += 1;
      if (sieve.likelyPlumbing) plumbing += 1;
      if (candidate.candidateBusiness) candidates += 1;
    }
  }

  ctx.onProgress?.({
    phase: BUSINESS_LOGIC_PHASE_NAME,
    kind: "note",
    message: `business-logic: tagged ${symbolsTagged} (${plumbing} plumbing, ${candidates} candidates), ${skipped} skipped`,
  });

  return { symbolsTagged, plumbing, candidates, skipped };
}

async function loadLines(
  abs: string | undefined,
  cache: Map<string, string[] | null>,
  ctx: PipelineContext,
  filePath: string,
): Promise<string[] | null> {
  if (abs === undefined) return null;
  const cached = cache.get(abs);
  if (cached !== undefined) return cached;
  try {
    const text = await fs.readFile(abs, "utf8");
    const lines = text.split("\n");
    cache.set(abs, lines);
    return lines;
  } catch (err) {
    ctx.onProgress?.({
      phase: BUSINESS_LOGIC_PHASE_NAME,
      kind: "warn",
      message: `business-logic: cannot read ${filePath}: ${(err as Error).message}`,
    });
    cache.set(abs, null);
    return null;
  }
}

/** Body text from `startLine` to `endLine` inclusive (1-based lines). */
function sliceBody(lines: readonly string[], startLine: number, endLine: number): string {
  const s = Math.max(0, startLine - 1);
  const e = endLine >= startLine ? Math.min(lines.length, endLine) : Math.min(lines.length, s + 50);
  return lines.slice(s, e).join("\n");
}

/** Class-head text the ORM-model detector matches against. Two parts:
 *
 *   1. PRECEDING annotation / decorator lines. JPA puts `@Entity` /
 *      `@MappedSuperclass` (and Python `@dataclass` etc.) on the line(s) ABOVE
 *      the class declaration, while the parse phase's `startLine` points at the
 *      `class`/`type` keyword. Without scanning upward the entity annotation is
 *      missed and `isOrmModel` reads false — the Java-entity divergence the
 *      parity check caught. We walk up over contiguous `@…` / comment / blank
 *      lines and prepend them so the extractor's annotation blob sees them.
 *   2. The declaration line(s) down to the first `{` or `:` that opens the body
 *      (the base / superclass list), capped at a few lines.
 *
 * Never includes the body. */
function sliceClassHead(lines: readonly string[], startLine: number): string {
  const s = Math.max(0, startLine - 1);
  // Walk upward, collecting ONLY real annotation lines (`@Entity`,
  // `@MappedSuperclass`, `@dataclass`). Comment and blank lines are stepped
  // OVER (a Javadoc block can sit between the annotation and the class) but
  // NOT collected — a Javadoc `@author` / `@param` tag would otherwise leak
  // into the extractor's annotation blob and shadow the real ORM annotation,
  // flipping isOrmModel false (the JPA-entity divergence the parity check
  // caught). Code lines stop the climb.
  const pre: string[] = [];
  let inBlockComment = false;
  for (let i = s - 1; i >= 0 && i >= s - 10; i--) {
    const line = lines[i] ?? "";
    const t = line.trim();
    // Track block-comment boundaries walking upward: a line ending `*/` opens
    // (from below) a comment region; a line containing `/*` closes it.
    if (t.endsWith("*/")) inBlockComment = true;
    const isComment = inBlockComment || t.startsWith("//") || t.startsWith("*");
    if (t.includes("/*")) inBlockComment = false;
    if (t === "" || isComment) continue; // step over, don't collect
    if (t.startsWith("@")) {
      pre.unshift(line); // a real annotation line
      continue;
    }
    break; // hit a code line — stop climbing
  }
  const head: string[] = [];
  for (let i = s; i < Math.min(lines.length, s + 4); i++) {
    const line = lines[i] ?? "";
    head.push(line);
    if (line.includes("{") || line.includes(":")) break;
  }
  return [...pre, ...head].join("\n");
}

function nodeKey(
  filePath: string,
  name: string,
  kind: NodeKind,
  startLine: number | undefined,
): string {
  return `${filePath}\x00${name}\x00${kind}\x00${startLine}`;
}

function buildNodeIndex(ctx: PipelineContext): ReadonlyMap<string, GraphNode> {
  const index = new Map<string, GraphNode>();
  for (const n of ctx.graph.nodes()) {
    if (!TAGGABLE_KINDS.has(n.kind)) continue;
    const startLine = (n as unknown as { readonly startLine?: number }).startLine;
    const key = nodeKey(n.filePath, n.name, n.kind, startLine);
    if (!index.has(key)) index.set(key, n);
  }
  return index;
}

/**
 * Re-attach the two advisory tags onto a taggable node. The kind guard narrows
 * the {@link GraphNode} union to the callable / class-like kinds that carry the
 * {@link CallableShape} fields, so the spread is type-safe (mirrors the
 * `withComplexity` narrowing idiom in the complexity phase). Other kinds — which
 * `TAGGABLE_KINDS` already excludes — fall through unchanged.
 */
function withTags(node: GraphNode, likelyPlumbing: boolean, candidateBusiness: boolean): GraphNode {
  if (TAGGABLE_KINDS.has(node.kind)) {
    return { ...node, likelyPlumbing, candidateBusiness } as GraphNode;
  }
  return node;
}
