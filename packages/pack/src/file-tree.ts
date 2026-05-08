/**
 * BOM body item: framework-labelled file tree (AC-M5-4 — item 3/9).
 *
 * Enumerates every `File`/`Folder` node and decorates each with the repo's
 * detected framework set. The `ProjectProfile` singleton (one per repo)
 * carries two redundant framework surfaces:
 *
 *   - `frameworksDetected: FrameworkDetection[]` (preferred — structured,
 *     carries variant/version/confidence/evidence).
 *   - `frameworks: string[]` (legacy v1.0 flat list).
 *
 * We prefer the structured surface and fall back to the legacy list only
 * when `frameworksDetected` is absent. Either way the output is
 * alpha-sorted + deduped so byte-identity holds across runs.
 *
 * Determinism contract:
 *   - Rows are sorted by `path ASC` (single primary key, no tie possible
 *     since file paths are unique).
 *   - Per-row `frameworks` lists are alpha-sorted and deduped before
 *     being copied onto every row — no per-row variation at v1.0 since
 *     the singleton applies repo-wide.
 *   - Two consecutive calls on the same store return identical rows.
 *
 * Path strings come straight from the FileNode/FolderNode `filePath`
 * field; we deliberately do NOT walk `CONTAINS` edges to reconstruct
 * the tree (the file/folder set already conveys structure via path
 * prefixes — see anti-goals in the task packet).
 */

import type { GraphNode } from "@opencodehub/core-types";
import type { IGraphStore } from "@opencodehub/storage";

/** A single row in the file-tree BOM file. */
export interface FileTreeNode {
  /** Repo-relative POSIX path. */
  readonly path: string;
  /** Discriminator — files vs folders. */
  readonly kind: "File" | "Folder";
  /** Source language (FileNode only). */
  readonly language?: string;
  /** Repo-wide framework labels — alpha-sorted, deduped. */
  readonly frameworks: readonly string[];
  /** Content sha256 (FileNode only). */
  readonly contentHash?: string;
}

/** Inputs to {@link buildFileTree}. */
export interface FileTreeOpts {
  readonly store: IGraphStore;
}

/**
 * Build the framework-labelled file tree.
 *
 * Empty graphs (no `File` or `Folder` nodes) return `[]`. Repos with
 * no `ProjectProfile` row (legacy graphs) return rows with empty
 * `frameworks` lists.
 */
export async function buildFileTree(opts: FileTreeOpts): Promise<readonly FileTreeNode[]> {
  const { store } = opts;

  // Pull every kind we need in one pass so the listNodes seam is hit
  // a known number of times (helps tests assert behavior cheaply).
  const profileNodes = await store.listNodes({ kinds: ["ProjectProfile"] });
  const fsNodes = await store.listNodes({ kinds: ["File", "Folder"] });

  const frameworks = resolveFrameworks(profileNodes);

  const rows: FileTreeNode[] = [];
  for (const node of fsNodes) {
    if (node.kind !== "File" && node.kind !== "Folder") continue;
    if (node.kind === "File") {
      const file = node;
      const row: FileTreeNode = {
        path: file.filePath,
        kind: "File",
        frameworks,
        ...(file.language !== undefined ? { language: file.language } : {}),
        ...(file.contentHash !== undefined ? { contentHash: file.contentHash } : {}),
      };
      rows.push(row);
    } else {
      rows.push({
        path: node.filePath,
        kind: "Folder",
        frameworks,
      });
    }
  }

  // path ASC. File paths are unique within a graph so no secondary
  // tiebreak is necessary, but we still use a strict lex compare so
  // the output is locale-independent.
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return rows;
}

/**
 * Resolve the repo-wide framework label list from the ProjectProfile
 * singleton. Precedence: structured `frameworksDetected` > legacy
 * `frameworks` > `[]`.
 */
function resolveFrameworks(profileNodes: readonly GraphNode[]): readonly string[] {
  const profile = profileNodes.find((n) => n.kind === "ProjectProfile");
  if (profile === undefined) return [];

  const detected = profile.frameworksDetected;
  if (detected !== undefined && detected.length > 0) {
    const names: string[] = [];
    for (const d of detected) names.push(d.name);
    return dedupeAndSort(names);
  }

  if (profile.frameworks.length > 0) {
    return dedupeAndSort([...profile.frameworks]);
  }
  return [];
}

/** Alpha-sort + dedupe (case-sensitive lex) for byte-identity. */
function dedupeAndSort(xs: readonly string[]): readonly string[] {
  const set = new Set<string>(xs);
  const arr = [...set];
  arr.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return arr;
}
