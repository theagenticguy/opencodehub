/**
 * Structure phase — projects the filesystem spine onto the graph.
 *
 * Consumes the scan phase output and emits:
 *  - One `File` node per scanned file (id includes the relative path so
 *    downstream IDs compose deterministically).
 *  - One `Folder` node per unique ancestor directory.
 *  - `CONTAINS` edges from each parent → child along the folder tree.
 *
 * Determinism: relative paths are sorted before processing so node and
 * edge insertion order is reproducible across machines.
 */

import type { FileNode, FolderNode } from "@opencodehub/core-types";
import { makeNodeId } from "@opencodehub/core-types";
import type { PipelineContext, PipelinePhase } from "../types.js";
import { SCAN_PHASE_NAME, type ScanOutput } from "./scan.js";

export interface StructureOutput {
  readonly pathSet: ReadonlySet<string>;
  readonly folderCount: number;
  readonly fileCount: number;
}

export const STRUCTURE_PHASE_NAME = "structure";

export const structurePhase: PipelinePhase<StructureOutput> = {
  name: STRUCTURE_PHASE_NAME,
  deps: [SCAN_PHASE_NAME],
  async run(ctx, deps) {
    const scan = deps.get(SCAN_PHASE_NAME) as ScanOutput | undefined;
    if (scan === undefined) {
      throw new Error("structure: scan output missing from dependency map");
    }
    return runStructure(ctx, scan);
  },
};

function runStructure(ctx: PipelineContext, scan: ScanOutput): StructureOutput {
  const relPaths = [...scan.files.map((f) => f.relPath)].sort();

  // Pre-compute the set of every folder path that must exist.
  const folderPaths = new Set<string>();
  for (const rel of relPaths) {
    let parent = parentDir(rel);
    while (parent !== "") {
      folderPaths.add(parent);
      parent = parentDir(parent);
    }
    // Root folder handled as an implicit anchor; we expose it as `"."` so
    // it has a stable qualified name without being confused with files.
  }

  const sortedFolders = [...folderPaths].sort();
  const rootFolder = ".";
  folderPaths.add(rootFolder);

  // Emit the root folder first so later CONTAINS edges point at an
  // existing node.
  const rootNode: FolderNode = {
    id: makeNodeId("Folder", rootFolder, rootFolder),
    kind: "Folder",
    name: rootFolder,
    filePath: rootFolder,
  };
  ctx.graph.addNode(rootNode);

  for (const folder of sortedFolders) {
    const node: FolderNode = {
      id: makeNodeId("Folder", folder, folder),
      kind: "Folder",
      name: basename(folder),
      filePath: folder,
    };
    ctx.graph.addNode(node);
  }

  // CONTAINS edges from parent folder to child folder.
  for (const folder of sortedFolders) {
    const parent = parentDir(folder);
    const parentPath = parent === "" ? rootFolder : parent;
    ctx.graph.addEdge({
      from: makeNodeId("Folder", parentPath, parentPath),
      to: makeNodeId("Folder", folder, folder),
      type: "CONTAINS",
      confidence: 1,
      reason: "folder-to-folder",
    });
  }

  // File nodes + CONTAINS from owning folder.
  const pathSet = new Set<string>();
  for (const file of scan.files) {
    pathSet.add(file.relPath);
    const fileId = makeNodeId("File", file.relPath, file.relPath);
    const fileNode: FileNode = {
      id: fileId,
      kind: "File",
      name: basename(file.relPath),
      filePath: file.relPath,
      contentHash: file.sha256,
      ...(file.language !== undefined ? { language: file.language } : {}),
    };
    ctx.graph.addNode(fileNode);

    const parent = parentDir(file.relPath);
    const parentPath = parent === "" ? rootFolder : parent;
    ctx.graph.addEdge({
      from: makeNodeId("Folder", parentPath, parentPath),
      to: fileId,
      type: "CONTAINS",
      confidence: 1,
      reason: "folder-to-file",
    });
  }

  return {
    pathSet,
    folderCount: folderPaths.size,
    fileCount: scan.files.length,
  };
}

function parentDir(p: string): string {
  const idx = p.lastIndexOf("/");
  if (idx <= 0) return "";
  return p.slice(0, idx);
}

function basename(p: string): string {
  const idx = p.lastIndexOf("/");
  if (idx < 0) return p;
  return p.slice(idx + 1);
}
