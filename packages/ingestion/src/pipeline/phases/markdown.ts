/**
 * Markdown phase — projects prose documents onto the graph.
 *
 * Consumes the structure phase output (for its pathSet) and scans every file
 * whose extension matches `.md`, `.mdx`, or `.markdown`. For each such file
 * the phase:
 *   1. Emits a `Section` node per H1..H6 heading.
 *   2. Links sections to their owning file via CONTAINS (top-level sections)
 *      and to each other along the heading hierarchy (parent → child).
 *   3. Scans the body for `[text](./path.md)` or `[text](./path.md#anchor)`
 *      style internal links and emits REFERENCES edges from the containing
 *      section (falling back to the file when no section encloses the link)
 *      to the target file — but only if the target path resolves against the
 *      structure phase pathSet.
 *
 * Determinism: input files are iterated in the sorted relPath order supplied
 * by the scan phase, headings are processed in source order, and link target
 * resolution is deterministic given the pathSet.
 *
 * No new dependencies — heading and link parsing is done with compiled regex.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { FileNode, SectionNode } from "@opencodehub/core-types";
import { makeNodeId, type NodeId } from "@opencodehub/core-types";
import type { PipelineContext, PipelinePhase } from "../types.js";
import { SCAN_PHASE_NAME, type ScannedFile, type ScanOutput } from "./scan.js";
import { STRUCTURE_PHASE_NAME, type StructureOutput } from "./structure.js";

/** File extensions treated as markdown. Lowercase, leading dot. */
const MARKDOWN_EXTS: ReadonlySet<string> = new Set([".md", ".mdx", ".markdown"]);

/** Match ATX-style headings `#`-`######` followed by the heading text. */
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/** Match `[anchor](target)` links. Captures only the target. */
const LINK_RE = /\[(?:[^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

export interface MarkdownOutput {
  readonly sectionCount: number;
  readonly linkCount: number;
}

export const MARKDOWN_PHASE_NAME = "markdown";

export const markdownPhase: PipelinePhase<MarkdownOutput> = {
  name: MARKDOWN_PHASE_NAME,
  deps: [STRUCTURE_PHASE_NAME],
  async run(ctx, deps) {
    const structure = deps.get(STRUCTURE_PHASE_NAME) as StructureOutput | undefined;
    if (structure === undefined) {
      throw new Error("markdown: structure output missing from dependency map");
    }
    // markdown reads the scan output indirectly via phaseOutputs — it is not
    // declared as a direct dep (structure already consumes it and we prefer
    // a single declared dep chain) but the full phaseOutputs map is visible.
    const scan = ctx.phaseOutputs.get(SCAN_PHASE_NAME) as ScanOutput | undefined;
    if (scan === undefined) {
      throw new Error("markdown: scan output missing from phase outputs");
    }
    return runMarkdown(ctx, scan, structure);
  },
};

async function runMarkdown(
  ctx: PipelineContext,
  scan: ScanOutput,
  structure: StructureOutput,
): Promise<MarkdownOutput> {
  const markdownFiles = scan.files.filter((f) => MARKDOWN_EXTS.has(extOf(f.relPath)));

  let sectionCount = 0;
  let linkCount = 0;

  for (const file of markdownFiles) {
    let content: string;
    try {
      const buf = await fs.readFile(file.absPath);
      content = buf.toString("utf8");
    } catch (err) {
      ctx.onProgress?.({
        phase: MARKDOWN_PHASE_NAME,
        kind: "warn",
        message: `markdown: cannot read ${file.relPath}: ${(err as Error).message}`,
      });
      continue;
    }

    const headings = parseHeadings(content);
    const sectionsOnFile = emitSectionsAndContains(ctx, file, headings);
    sectionCount += sectionsOnFile.length;

    linkCount += emitReferenceLinks(ctx, file, content, sectionsOnFile, structure.pathSet);
  }

  return { sectionCount, linkCount };
}

interface HeadingHit {
  readonly level: number;
  readonly text: string;
  /** 1-based line number where the heading is declared. */
  readonly line: number;
  /** 0-based character offset where the heading line starts. */
  readonly offset: number;
}

function parseHeadings(content: string): readonly HeadingHit[] {
  const out: HeadingHit[] = [];
  let lineNum = 1;
  let lineStart = 0;
  let inFence = false;
  const len = content.length;

  for (let i = 0; i <= len; i += 1) {
    const ch = i === len ? "\n" : content.charAt(i);
    if (ch === "\n") {
      const line = content.slice(lineStart, i);
      const trimmed = line.trimEnd();
      // Toggle code-fence state on lines starting with ``` or ~~~.
      if (/^(?:```|~~~)/.test(trimmed)) {
        inFence = !inFence;
      } else if (!inFence) {
        const m = HEADING_RE.exec(trimmed);
        if (m !== null) {
          const hashes = m[1];
          const text = m[2];
          if (hashes !== undefined && text !== undefined) {
            const level = hashes.length;
            const cleaned = text.trim();
            if (cleaned.length > 0) {
              out.push({ level, text: cleaned, line: lineNum, offset: lineStart });
            }
          }
        }
      }
      lineStart = i + 1;
      lineNum += 1;
    }
  }
  return out;
}

interface SectionBinding {
  readonly heading: HeadingHit;
  readonly id: NodeId;
  /** Offset (inclusive) where this section's body starts. */
  readonly bodyStart: number;
  /** Offset (exclusive) where this section's body ends. */
  bodyEnd: number;
}

function emitSectionsAndContains(
  ctx: PipelineContext,
  file: ScannedFile,
  headings: readonly HeadingHit[],
): readonly SectionBinding[] {
  const fileId = makeNodeId("File", file.relPath, file.relPath);
  // Guarantee the File node exists even if structure was skipped. addNode
  // is idempotent on repeat calls.
  const fileNode: FileNode = {
    id: fileId,
    kind: "File",
    name: basename(file.relPath),
    filePath: file.relPath,
    ...(file.language !== undefined ? { language: file.language } : {}),
    contentHash: file.sha256,
  };
  ctx.graph.addNode(fileNode);

  // Track the chain of currently-open sections by level so each new heading
  // can find its parent and produce a stable qualified key.
  const stack: SectionBinding[] = [];
  const bindings: SectionBinding[] = [];

  for (const h of headings) {
    while (
      stack.length > 0 &&
      (stack[stack.length - 1] as SectionBinding).heading.level >= h.level
    ) {
      stack.pop();
    }
    const parent = stack.length > 0 ? (stack[stack.length - 1] as SectionBinding) : undefined;
    const parentHeadingText = parent?.heading.text ?? "";
    const id = makeNodeId("Section", file.relPath, `${parentHeadingText}/${h.text}`, {
      parameterCount: h.level,
    });
    const node: SectionNode = {
      id,
      kind: "Section",
      name: h.text,
      filePath: file.relPath,
      level: h.level,
      startLine: h.line,
    };
    ctx.graph.addNode(node);

    const binding: SectionBinding = {
      heading: h,
      id,
      bodyStart: h.offset,
      bodyEnd: Number.POSITIVE_INFINITY,
    };
    bindings.push(binding);

    if (parent === undefined) {
      ctx.graph.addEdge({
        from: fileId,
        to: id,
        type: "CONTAINS",
        confidence: 1,
        reason: "file-to-section",
      });
    } else {
      ctx.graph.addEdge({
        from: parent.id,
        to: id,
        type: "CONTAINS",
        confidence: 1,
        reason: "section-to-subsection",
      });
    }

    stack.push(binding);
  }

  // Close body offsets: each section body ends where the next heading of
  // equal-or-lower level starts.
  for (let i = 0; i < bindings.length; i += 1) {
    const current = bindings[i] as SectionBinding;
    for (let j = i + 1; j < bindings.length; j += 1) {
      const next = bindings[j] as SectionBinding;
      if (next.heading.level <= current.heading.level) {
        current.bodyEnd = next.heading.offset;
        break;
      }
    }
  }

  return bindings;
}

function emitReferenceLinks(
  ctx: PipelineContext,
  file: ScannedFile,
  content: string,
  sections: readonly SectionBinding[],
  pathSet: ReadonlySet<string>,
): number {
  const fileId = makeNodeId("File", file.relPath, file.relPath);
  const importerDir = parentDir(file.relPath);

  let linkCount = 0;
  LINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null = LINK_RE.exec(content);
  while (match !== null) {
    const target = match[1];
    const matchIdx = match.index;
    match = LINK_RE.exec(content);
    if (target === undefined) continue;

    // Drop external links, anchors-only, or obviously non-file URIs.
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    if (target.startsWith("#")) continue;
    if (target.startsWith("mailto:")) continue;

    // Separate anchor from path.
    const hashIdx = target.indexOf("#");
    const rawPath = hashIdx === -1 ? target : target.slice(0, hashIdx);
    if (rawPath.length === 0) continue;

    const resolved = resolveLinkTarget(rawPath, importerDir, pathSet);
    if (resolved === undefined) continue;

    const targetId = makeNodeId("File", resolved, resolved);
    const ownerId = ownerSectionFor(sections, matchIdx) ?? fileId;
    ctx.graph.addEdge({
      from: ownerId,
      to: targetId,
      type: "REFERENCES",
      confidence: 0.8,
      reason: "markdown-link",
    });
    linkCount += 1;
  }
  return linkCount;
}

function ownerSectionFor(sections: readonly SectionBinding[], offset: number): NodeId | undefined {
  // Pick the deepest section whose body bracket contains `offset`.
  let best: SectionBinding | undefined;
  for (const s of sections) {
    if (offset >= s.bodyStart && offset < s.bodyEnd) {
      if (best === undefined || s.heading.level > best.heading.level) {
        best = s;
      }
    }
  }
  return best?.id;
}

function resolveLinkTarget(
  rawPath: string,
  importerDir: string,
  pathSet: ReadonlySet<string>,
): string | undefined {
  // Decode percent-escapes and strip leading `./`.
  let p = rawPath;
  try {
    p = decodeURIComponent(p);
  } catch {
    // leave raw path in place if it's not valid percent-encoded
  }
  if (p.startsWith("/")) {
    const candidate = p.slice(1);
    return pathSet.has(candidate) ? candidate : undefined;
  }
  const joined = posixJoin(importerDir, p);
  const normalized = normalizePath(joined);
  if (pathSet.has(normalized)) return normalized;
  return undefined;
}

function extOf(relPath: string): string {
  const e = path.extname(relPath);
  return e.toLowerCase();
}

function basename(p: string): string {
  const idx = p.lastIndexOf("/");
  if (idx < 0) return p;
  return p.slice(idx + 1);
}

function parentDir(p: string): string {
  const idx = p.lastIndexOf("/");
  if (idx <= 0) return "";
  return p.slice(0, idx);
}

function posixJoin(dir: string, rel: string): string {
  if (dir === "") return rel;
  if (rel === "") return dir;
  return `${dir}/${rel}`;
}

function normalizePath(p: string): string {
  const parts = p.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}
