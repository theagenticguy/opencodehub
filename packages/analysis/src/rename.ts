/**
 * Text-level rename driven by the code graph.
 *
 * The graph tells us which symbols reference the target (high-confidence
 * hits); for everything else we fall back to a repo-wide word-boundary
 * regex sweep (low-confidence hits, surfaced in the hint so the caller
 * can review). This module only *generates* edits in dry-run mode; the
 * actual file write happens via the injected {@link FsAbstraction} when
 * `dryRun` is explicitly false.
 */

import { isAbsolute, join } from "node:path";
import type { IGraphStore } from "@opencodehub/storage";
import type { FsAbstraction, NodeRef, RenameEdit, RenameQuery, RenameResult } from "./types.js";

interface SymbolLocation extends NodeRef {
  readonly startLine: number;
  readonly endLine: number;
}

const GRAPH_REFERRER_RELATIONS: readonly string[] = [
  "CALLS",
  "ACCESSES",
  "EXTENDS",
  "IMPLEMENTS",
  "METHOD_OVERRIDES",
  "METHOD_IMPLEMENTS",
  "HAS_METHOD",
];

/**
 * Escape characters that would otherwise be interpreted by the RegExp
 * constructor. We pin the call sites to identifier names (letters,
 * digits, underscores) so escaping should never fire in practice, but
 * defensive escaping keeps us correct if someone routes a renamed
 * operator through this helper.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveAbs(repoRoot: string, relPath: string): string {
  return isAbsolute(relPath) ? relPath : join(repoRoot, relPath);
}

async function findCandidates(
  store: IGraphStore,
  symbolName: string,
  scopeFile: string | undefined,
): Promise<readonly SymbolLocation[]> {
  const base = "SELECT id, name, file_path, kind, start_line, end_line FROM nodes WHERE name = ?";
  let sql = base;
  const params: (string | number)[] = [symbolName];
  if (scopeFile) {
    sql += " AND file_path = ?";
    params.push(scopeFile);
  }
  sql += " ORDER BY id";
  const rows = await store.query(sql, params);
  const out: SymbolLocation[] = [];
  for (const row of rows) {
    const start = Number(row["start_line"] ?? Number.NaN);
    const end = Number(row["end_line"] ?? Number.NaN);
    out.push({
      id: String(row["id"] ?? ""),
      name: String(row["name"] ?? ""),
      filePath: String(row["file_path"] ?? ""),
      kind: String(row["kind"] ?? ""),
      startLine: Number.isFinite(start) ? start : 0,
      endLine: Number.isFinite(end) ? end : 0,
    });
  }
  return out;
}

async function referrersOf(
  store: IGraphStore,
  targetId: string,
): Promise<readonly SymbolLocation[]> {
  const typePlaceholders = GRAPH_REFERRER_RELATIONS.map(() => "?").join(",");
  const rows = await store.query(
    `SELECT DISTINCT n.id, n.name, n.file_path, n.kind, n.start_line, n.end_line
       FROM relations r JOIN nodes n ON n.id = r.from_id
      WHERE r.to_id = ? AND r.type IN (${typePlaceholders})`,
    [targetId, ...GRAPH_REFERRER_RELATIONS],
  );
  const out: SymbolLocation[] = [];
  for (const row of rows) {
    const start = Number(row["start_line"] ?? Number.NaN);
    const end = Number(row["end_line"] ?? Number.NaN);
    out.push({
      id: String(row["id"] ?? ""),
      name: String(row["name"] ?? ""),
      filePath: String(row["file_path"] ?? ""),
      kind: String(row["kind"] ?? ""),
      startLine: Number.isFinite(start) ? start : 0,
      endLine: Number.isFinite(end) ? end : 0,
    });
  }
  return out;
}

async function allRepoFiles(store: IGraphStore): Promise<readonly string[]> {
  const rows = await store.query(
    "SELECT DISTINCT file_path FROM nodes WHERE kind = 'File' ORDER BY file_path",
  );
  const out: string[] = [];
  for (const row of rows) {
    const p = String(row["file_path"] ?? "");
    if (p.length > 0) out.push(p);
  }
  return out;
}

/** Sweep a buffer for every word-bounded hit. Returns edits in source order. */
function findMatches(
  content: string,
  needle: string,
  replacement: string,
  filePath: string,
  source: "graph" | "text",
  confidence: number,
  lineRange?: { readonly start: number; readonly end: number },
): readonly RenameEdit[] {
  const edits: RenameEdit[] = [];
  const re = new RegExp(`\\b${escapeRegex(needle)}\\b`, "g");
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const lineNumber = i + 1;
    if (lineRange && (lineNumber < lineRange.start || lineNumber > lineRange.end)) {
      continue;
    }
    const lineText = lines[i];
    if (lineText === undefined) continue;
    re.lastIndex = 0;
    for (;;) {
      const match = re.exec(lineText);
      if (match === null) break;
      edits.push({
        filePath,
        line: lineNumber,
        column: match.index + 1,
        before: needle,
        after: replacement,
        confidence,
        source,
      });
    }
  }
  return edits;
}

/** Key used to dedupe edits across graph-phase and text-phase sweeps. */
function editKey(e: RenameEdit): string {
  return `${e.filePath}|${e.line}|${e.column}`;
}

/** Apply edits to a single file buffer. Edits must target the same file. */
function applyEdits(content: string, edits: readonly RenameEdit[]): string {
  if (edits.length === 0) return content;
  const byLine = new Map<number, RenameEdit[]>();
  for (const e of edits) {
    const bucket = byLine.get(e.line) ?? [];
    bucket.push(e);
    byLine.set(e.line, bucket);
  }
  const lines = content.split("\n");
  const sortedLineNumbers = [...byLine.keys()].sort((a, b) => b - a);
  for (const ln of sortedLineNumbers) {
    const idx = ln - 1;
    if (idx < 0 || idx >= lines.length) continue;
    const edits = byLine.get(ln) ?? [];
    // Apply right-to-left within the line so earlier column offsets stay valid.
    const sorted = [...edits].sort((a, b) => b.column - a.column);
    let line = lines[idx] ?? "";
    for (const e of sorted) {
      const col = e.column - 1;
      line = line.slice(0, col) + e.after + line.slice(col + e.before.length);
    }
    lines[idx] = line;
  }
  return lines.join("\n");
}

export async function runRename(
  store: IGraphStore,
  q: RenameQuery,
  fs: FsAbstraction,
  repoRoot: string,
): Promise<RenameResult> {
  const dryRun = q.dryRun !== false; // default true — destructive writes are opt-in.
  const scopeFile = q.scope?.filePath;

  // 1. Resolve target.
  const candidates = await findCandidates(store, q.symbolName, scopeFile);
  if (candidates.length === 0) {
    return {
      edits: [],
      applied: false,
      skipped: [],
      ambiguous: false,
      hint: `Symbol "${q.symbolName}" was not found in the graph.`,
    };
  }
  if (candidates.length > 1 && !scopeFile) {
    const locations = candidates.map((c) => `${c.filePath}:${c.startLine}`).join(", ");
    return {
      edits: [],
      applied: false,
      skipped: [],
      ambiguous: true,
      hint: `Multiple symbols named "${q.symbolName}" were found (${locations}). Rerun with scope.filePath to disambiguate.`,
    };
  }

  const targets = candidates.length === 1 ? candidates : candidates;

  // 2. Graph-backed referrer edits (confidence 1.0). Also emit the
  // definition site so the rename actually touches the declaration.
  const graphEditsByKey = new Map<string, RenameEdit>();
  const graphFilesCovered = new Set<string>();
  const readCache = new Map<string, string>();

  async function readFileCached(abs: string, rel: string): Promise<string | undefined> {
    if (readCache.has(rel)) return readCache.get(rel);
    try {
      const content = await fs.readFile(abs);
      readCache.set(rel, content);
      return content;
    } catch {
      return undefined;
    }
  }

  for (const tgt of targets) {
    const abs = resolveAbs(repoRoot, tgt.filePath);
    const defContent = await readFileCached(abs, tgt.filePath);
    if (defContent !== undefined && tgt.startLine > 0) {
      const defEdits = findMatches(
        defContent,
        q.symbolName,
        q.newName,
        tgt.filePath,
        "graph",
        1.0,
        { start: tgt.startLine, end: Math.max(tgt.startLine, tgt.endLine) },
      );
      for (const e of defEdits) {
        graphEditsByKey.set(editKey(e), e);
        graphFilesCovered.add(e.filePath);
      }
    }

    const referrers = await referrersOf(store, tgt.id);
    // Group referrers by file so we only read each file once.
    const referrersByFile = new Map<string, SymbolLocation[]>();
    for (const r of referrers) {
      // Skip self-references at the exact definition site; they're already
      // covered by the defEdits sweep above.
      if (r.id === tgt.id) continue;
      const bucket = referrersByFile.get(r.filePath) ?? [];
      bucket.push(r);
      referrersByFile.set(r.filePath, bucket);
    }
    for (const [relPath, refs] of referrersByFile) {
      const absPath = resolveAbs(repoRoot, relPath);
      const content = await readFileCached(absPath, relPath);
      if (content === undefined) continue;
      for (const ref of refs) {
        if (ref.startLine <= 0 || ref.endLine <= 0) continue;
        const edits = findMatches(content, q.symbolName, q.newName, relPath, "graph", 1.0, {
          start: ref.startLine,
          end: ref.endLine,
        });
        for (const e of edits) {
          graphEditsByKey.set(editKey(e), e);
          graphFilesCovered.add(e.filePath);
        }
      }
    }
  }

  // 3. Text-fallback sweep (confidence 0.5) over every file not yet
  // covered by a graph edit. Honors `scope.filePath` if set.
  const textEditsByKey = new Map<string, RenameEdit>();
  const filesToSweep = scopeFile ? [scopeFile] : await allRepoFiles(store);
  for (const rel of filesToSweep) {
    if (graphFilesCovered.has(rel)) continue;
    const abs = resolveAbs(repoRoot, rel);
    const content = await readFileCached(abs, rel);
    if (content === undefined) continue;
    const matches = findMatches(content, q.symbolName, q.newName, rel, "text", 0.5);
    for (const e of matches) {
      const key = editKey(e);
      if (graphEditsByKey.has(key)) continue;
      textEditsByKey.set(key, e);
    }
  }

  const graphEdits = [...graphEditsByKey.values()];
  const textEdits = [...textEditsByKey.values()];
  const combined = [...graphEdits, ...textEdits].sort((a, b) => {
    const byFile = a.filePath.localeCompare(b.filePath);
    if (byFile !== 0) return byFile;
    if (a.line !== b.line) return a.line - b.line;
    return a.column - b.column;
  });

  if (dryRun) {
    const hint =
      textEdits.length > 0
        ? `Includes ${textEdits.length} text-only edit${textEdits.length === 1 ? "" : "s"} (confidence 0.5). Review before applying.`
        : undefined;
    return {
      edits: combined,
      applied: false,
      skipped: [],
      ambiguous: false,
      ...(hint ? { hint } : {}),
    };
  }

  // 4. Apply. Group edits by file, rewrite in-memory, then write atomically.
  const editsByFile = new Map<string, RenameEdit[]>();
  for (const e of combined) {
    const bucket = editsByFile.get(e.filePath) ?? [];
    bucket.push(e);
    editsByFile.set(e.filePath, bucket);
  }

  const skipped: { filePath: string; reason: string }[] = [];
  for (const [rel, edits] of editsByFile) {
    const abs = resolveAbs(repoRoot, rel);
    const original = readCache.get(rel);
    if (original === undefined) {
      skipped.push({ filePath: rel, reason: "Could not read file for rewrite" });
      continue;
    }
    const rewritten = applyEdits(original, edits);
    if (rewritten === original) continue;
    try {
      await fs.writeFileAtomic(abs, rewritten);
    } catch (err) {
      skipped.push({
        filePath: rel,
        reason: `Write failed: ${(err as Error).message}`,
      });
    }
  }

  const hintParts: string[] = [];
  if (textEdits.length > 0) {
    hintParts.push(
      `Applied ${textEdits.length} text-only edit${textEdits.length === 1 ? "" : "s"}; verify the changes compile.`,
    );
  }
  if (skipped.length > 0) {
    hintParts.push(
      `${skipped.length} file${skipped.length === 1 ? "" : "s"} skipped — see skipped[].`,
    );
  }
  const hint = hintParts.length > 0 ? hintParts.join(" ") : undefined;

  return {
    edits: combined,
    applied: true,
    skipped,
    ambiguous: false,
    ...(hint ? { hint } : {}),
  };
}
