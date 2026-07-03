/**
 * Pack provenance resolution — shared by the CLI `code-pack` command and the
 * MCP `pack_codebase` tool so BOTH production entry points feed `generatePack`
 * the same `internal` inputs and therefore produce the SAME `packHash` for a
 * given repo + commit.
 *
 * This lived privately in `packages/cli/src/commands/code-pack.ts`, which the
 * MCP tool cannot import (it would invert the `cli → mcp` dependency and cycle).
 * Hosting it in `@opencodehub/pack` — which both `cli` and `mcp` already depend
 * on — lets the MCP path wire real provenance instead of shipping a hollow pack
 * (empty ast-chunks, `commit=""`, `chonkieVersion="unknown"`) with a packHash
 * that silently diverges from the CLI's for the identical input.
 *
 * Every field is best-effort: a graph missing the data (or a stubbed store in
 * tests) yields safe empties, never a throw, so packing never fails on absent
 * provenance.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FileNode, GraphNode, RepoNode } from "@opencodehub/core-types";
import { sha256Hex } from "@opencodehub/core-types";
import { parse as ingestionParse } from "@opencodehub/ingestion";
import type { IGraphStore } from "@opencodehub/storage";

/**
 * Production provenance the pack manifest records, derived from the indexed
 * graph + the working tree. Each field maps to a `generatePack` `internal`
 * input.
 */
export interface PackProvenance {
  readonly commit: string;
  readonly repoOriginUrl: string | null;
  readonly chunkerFiles: ReadonlyArray<{
    readonly path: string;
    readonly bytes: Uint8Array;
    readonly language?: string;
  }>;
  readonly grammarCommits: Readonly<Record<string, string>>;
}

/**
 * Derive {@link PackProvenance} from the opened graph and the repo working
 * tree.
 *
 *   - commit / repoOriginUrl: read from the singleton `Repo` node, so the
 *     pack stays a pure read of the indexed state (no `git` spawn here).
 *   - chunkerFiles: every indexed `File` node's bytes, read from disk and
 *     **hash-verified against the node's `contentHash`**. A file whose
 *     working-tree bytes drifted from the index is skipped, so the pack never
 *     chunks content that disagrees with what was analyzed — preserving the
 *     "pack reflects the indexed commit" contract.
 *   - grammarCommits: the vendored grammar version pins.
 *
 * A `graph` of `undefined` (no store) or one lacking `listNodes` (a bare test
 * stub) yields empty file/commit provenance but still returns grammar pins.
 */
export async function resolvePackProvenance(
  graph: IGraphStore | undefined,
  repoPath: string,
): Promise<PackProvenance> {
  const grammarCommits = await loadGrammarCommits();

  const canList = typeof graph?.listNodes === "function";
  if (graph === undefined || !canList) {
    return { commit: "", repoOriginUrl: null, chunkerFiles: [], grammarCommits };
  }

  const [repoNodes, fileNodes] = await Promise.all([
    graph.listNodes({ kinds: ["Repo"] }),
    graph.listNodes({ kinds: ["File"] }),
  ]);

  const repo = repoNodes.find((n): n is RepoNode => n.kind === "Repo");
  const commit = repo?.commitSha ?? "";
  const repoOriginUrl = repo?.originUrl ?? null;

  const chunkerFiles = await collectChunkerFiles(fileNodes, repoPath);
  return { commit, repoOriginUrl, chunkerFiles, grammarCommits };
}

/**
 * Read + hash-verify the bytes of every indexed `File` node. Only files whose
 * on-disk sha256 matches the indexed `contentHash` are returned, so a pack run
 * against a dirty working tree silently drops drifted files rather than
 * chunking stale bytes. Files with no recorded `contentHash` are read as-is
 * (the index never claimed a hash to verify against).
 */
async function collectChunkerFiles(
  fileNodes: readonly GraphNode[],
  repoPath: string,
): Promise<PackProvenance["chunkerFiles"]> {
  const out: Array<{ path: string; bytes: Uint8Array; language?: string }> = [];
  for (const node of fileNodes) {
    if (node.kind !== "File") continue;
    const file = node as FileNode;
    let buf: Buffer;
    try {
      buf = await readFile(resolve(repoPath, file.filePath));
    } catch {
      continue; // file vanished from the tree since indexing — skip it
    }
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    if (file.contentHash !== undefined && sha256Hex(bytes) !== file.contentHash) {
      continue; // working-tree bytes drifted from the indexed state — skip
    }
    out.push({
      path: file.filePath,
      bytes,
      ...(file.language !== undefined ? { language: file.language } : {}),
    });
  }
  return out;
}

/**
 * Load the vendored grammar version pins for the manifest. Best-effort: an
 * unreadable manifest yields `{}` rather than failing the pack.
 */
async function loadGrammarCommits(): Promise<Readonly<Record<string, string>>> {
  try {
    return await ingestionParse.grammarVersions();
  } catch {
    return {};
  }
}
