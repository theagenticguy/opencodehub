/**
 * @opencodehub/pack — deterministic code-pack BOM.
 *
 * Public surface:
 *   - generatePack(opts): assembles the 9-item BOM (manifest + skeleton +
 *     file-tree + deps + ast-chunks + xrefs + findings + licenses.md +
 *     context-bom.json), plus a consumer-facing readme.md derived from the
 *     manifest.
 *   - buildManifest / serializeManifest: BOM manifest + pack_hash.
 *   - Per-BOM-item builders re-exported for direct use (skeleton, file-tree,
 *     deps, ast-chunker, xrefs, findings, licenses, readme).
 *   - Type surface: {BomItem, DeterminismClass, PackManifest, PackOpts, PackPins}.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "@opencodehub/core-types";
import type { IGraphStore, Store } from "@opencodehub/storage";
import {
  type AstChunkerInternalOpts,
  type AstChunkerResult,
  buildAstChunks,
} from "./ast-chunker.js";
import { type ByteSpan, buildContextBom, type ContextFile } from "./context-bom.js";
import { buildDeps } from "./deps.js";
import { buildFileTree } from "./file-tree.js";
import { buildFindings } from "./findings.js";
import { buildLicenses } from "./licenses.js";
import { buildManifest, serializeManifest } from "./manifest.js";
import { buildReadme } from "./readme.js";
import { buildSkeleton } from "./skeleton.js";
import type { BomItem, DeterminismClass, PackManifest, PackOpts, PackPins } from "./types.js";
import { buildXrefs } from "./xrefs.js";

export type { AstChunk, AstChunkerOpts, AstChunkerResult } from "./ast-chunker.js";
export { buildAstChunks } from "./ast-chunker.js";
export type {
  AttestationBomItem,
  ContextAttestationPredicate,
  DigestSet,
  InTotoStatement,
  InTotoSubject,
} from "./attestation.js";
export {
  buildContextAttestation,
  CONTEXT_ATTESTATION_PREDICATE_TYPE,
  CONTEXT_ATTESTATION_SUBJECT_NAME,
  IN_TOTO_STATEMENT_TYPE,
  serializeAttestation,
} from "./attestation.js";
export type {
  ByteSpan,
  ContextBomDocument,
  ContextBomOpts,
  ContextBomResult,
  ContextFile,
} from "./context-bom.js";
export { buildContextBom, mergeSpans } from "./context-bom.js";
export {
  canonicalDecisionSet,
  type DecisionDiff,
  type DecisionSet,
  decisionHash,
  decisionSetFromByteRanges,
  decisionSetFromChunks,
  diffDecisionSets,
  type RangeTuple,
  type Selection,
} from "./decision-set.js";
export type { DepRow, DepsOpts } from "./deps.js";
export { buildDeps } from "./deps.js";
export type { FileTreeNode, FileTreeOpts } from "./file-tree.js";
export { buildFileTree } from "./file-tree.js";
export type { FindingExample, FindingGroup, FindingSeverity, FindingsOpts } from "./findings.js";
export { buildFindings } from "./findings.js";
export type { LicensesContent, LicensesOpts } from "./licenses.js";
export { buildLicenses } from "./licenses.js";
export type { BuildManifestOpts } from "./manifest.js";
export { buildManifest, serializeManifest } from "./manifest.js";
export type { ReadmeOpts } from "./readme.js";
export { buildReadme } from "./readme.js";
export type { SkeletonOpts, SkeletonRow } from "./skeleton.js";
export { buildSkeleton } from "./skeleton.js";
export type { BomItem, DeterminismClass, PackManifest, PackOpts, PackPins } from "./types.js";
export type { XrefRow, XrefsOpts } from "./xrefs.js";
export { buildXrefs } from "./xrefs.js";

/**
 * Internal seam — tests inject everything `generatePack` would otherwise
 * resolve from the filesystem or process state (the open store, the git
 * commit, the repo origin URL, the AST-chunk source files, the chonkie
 * loader). Callers in production never set this; the public `PackOpts`
 * surface is unchanged.
 *
 * `store` is the composed {@link Store} (= `OpenStoreResult`); the BOM
 * bodies read from its `graph` view. Tests that only need graph-side
 * reads can pass an {@link IGraphStore} via the `graphOnly` field, which
 * is wrapped into a minimal {@link Store}.
 */
export interface GeneratePackInternalOpts {
  readonly store?: Store;
  /**
   * Backwards-compatible escape hatch — tests can supply an
   * {@link IGraphStore} alone. Internally wrapped into a minimal
   * {@link Store}; the temporal view is a typed alias of the graph value,
   * sufficient for the graph-tier reads the BOM bodies perform.
   */
  readonly graphOnly?: IGraphStore;
  readonly commit?: string;
  readonly repoOriginUrl?: string | null;
  readonly chunkerFiles?: ReadonlyArray<{
    readonly path: string;
    readonly bytes: Uint8Array;
    readonly language?: string;
  }>;
  readonly chonkieLoader?: AstChunkerInternalOpts["_loadChonkie"];
  readonly grammarCommits?: Readonly<Record<string, string>>;
}

/**
 * Generate the deterministic 9-item code-pack.
 *
 * Writes the 8 BOM body files plus the manifest into `opts.outDir`, plus a
 * consumer-facing readme.md derived from the manifest:
 *   - skeleton.jsonl
 *   - file-tree.jsonl
 *   - deps.jsonl
 *   - ast-chunks.jsonl
 *   - xrefs.jsonl
 *   - findings.jsonl
 *   - licenses.md
 *   - context-bom.json
 *   - manifest.json
 *   - readme.md (consumer-facing metadata; not a manifest BomItem)
 *
 * Determinism class:
 *   - `"strict"` by default.
 *   - `"best_effort"` when `tokenizerId` starts with `"anthropic:"` (Claude
 *     tokenizers are not guaranteed stable across versions).
 *   - `"degraded"` when the AST chunker fell back to line-split.
 *
 * The function always writes the manifest LAST so a partial run never
 * leaves a manifest pointing at hashes that don't match the on-disk
 * payloads.
 */
export async function generatePack(
  opts: PackOpts,
  internal: GeneratePackInternalOpts = {},
): Promise<PackManifest> {
  const store = await resolveStore(internal, opts.repoPath);
  const graph = store.graph;
  const commit = internal.commit ?? "";
  const repoOriginUrl = internal.repoOriginUrl !== undefined ? internal.repoOriginUrl : null;

  // --- BOM bodies (5 in-graph + chunker on raw files; context-bom below). ---
  const [skeletonRows, fileTreeRows, depsRows, xrefRows, findingGroups, licensesContent] =
    await Promise.all([
      buildSkeleton({ store: graph }),
      buildFileTree({ store: graph }),
      buildDeps({ store: graph }),
      buildXrefs({ store: graph }),
      buildFindings({ store: graph }),
      buildLicenses({ store: graph, repoPath: opts.repoPath }),
    ]);

  const chunkerFiles = internal.chunkerFiles ?? [];
  const astResult: AstChunkerResult = await buildAstChunks(
    {
      files: chunkerFiles,
      budgetTokens: opts.budgetTokens,
      tokenizerId: opts.tokenizerId,
    },
    internal.chonkieLoader !== undefined ? { _loadChonkie: internal.chonkieLoader } : {},
  );

  // --- Context read-receipt (item 9). Anchored on File nodes (populated by
  //     analyze on every real pack) so the receipt is complete in production;
  //     byte ranges layer on from the chunker when present (today only in
  //     tests, where chunkerFiles is supplied). ---
  const contextFiles = await collectContextFiles(graph);
  const byteRangesByPath = collectByteRanges(astResult.chunks);
  const contextBom = buildContextBom({
    files: contextFiles,
    byteRangesByPath,
    commit,
    repoOriginUrl,
  });
  const contextBomBytes = encodeUtf8(contextBom.canonical);

  // --- Serialize bodies. ---
  const skeletonBytes = encodeJsonl(skeletonRows);
  const fileTreeBytes = encodeJsonl(fileTreeRows);
  const depsBytes = encodeJsonl(depsRows);
  const xrefsBytes = encodeJsonl(xrefRows);
  const findingsBytes = encodeJsonl(findingGroups);
  const astChunksBytes = encodeJsonl(astResult.chunks);
  const licensesBytes = encodeUtf8(licensesContent.licensesMd);

  // --- Compute BomItem[] (manifest + readme are appended last so the
  //     manifest knows about its own readme without depending on read order). ---
  const items: BomItem[] = [
    bomItem("skeleton", "skeleton.jsonl", skeletonBytes),
    bomItem("file-tree", "file-tree.jsonl", fileTreeBytes),
    bomItem("deps", "deps.jsonl", depsBytes),
    bomItem("ast-chunks", "ast-chunks.jsonl", astChunksBytes),
    bomItem("xrefs", "xrefs.jsonl", xrefsBytes),
    bomItem("findings", "findings.jsonl", findingsBytes),
    bomItem("licenses", "licenses.md", licensesBytes),
    bomItem("context-bom", "context-bom.json", contextBomBytes),
  ];

  await mkdir(opts.outDir, { recursive: true });

  // --- Resolve the determinism class + pins object. A `degraded` chunker
  //     (AST chunker fell back to line-split) dominates the class via the
  //     precedence rule: `degraded` wins over `best_effort`, which wins over
  //     `strict`. ---
  const determinismClass = resolveDeterminism(opts.tokenizerId, astResult.determinismClass);
  const pins: PackPins = {
    chonkieVersion: astResult.pinsHint.chonkieVersion ?? "unknown",
    grammarCommits: internal.grammarCommits ?? {},
  };

  // --- Build the manifest (without README; README is consumer-facing
  //     metadata derived from the manifest, not part of the manifest's
  //     hash preimage). The manifest's `files[]` lists every BOM item we
  //     wrote to disk — including itself? No: the manifest's own hash
  //     is computed BEFORE it knows its own file_hash, so we omit it
  //     from `files[]`. The on-disk `manifest.json` byte-equals the
  //     `pack_hash` preimage modulo the `pack_hash` field. ---
  const manifest = buildManifest({
    commit,
    repoOriginUrl,
    tokenizerId: opts.tokenizerId,
    determinismClass,
    budgetTokens: opts.budgetTokens,
    pins,
    files: items,
    contextBomHash: contextBom.contextBomHash,
  });

  const manifestJson = serializeManifest(manifest);
  const manifestBytes = encodeUtf8(manifestJson);

  const readmeMd = buildReadme({
    manifest,
    bomItemPaths: [...items.map((i) => i.path), "manifest.json"],
  });
  const readmeBytes = encodeUtf8(readmeMd);

  // --- Write everything. The outDir was already created above; the bodies
  //     share it.
  // BOM bodies first, then manifest, then readme. Order is irrelevant for
  // byte-identity (writes are independent), but we serialize manifest
  // last so a crash mid-write leaves an obviously-incomplete pack.
  await Promise.all([
    writeBytes(path.join(opts.outDir, "skeleton.jsonl"), skeletonBytes),
    writeBytes(path.join(opts.outDir, "file-tree.jsonl"), fileTreeBytes),
    writeBytes(path.join(opts.outDir, "deps.jsonl"), depsBytes),
    writeBytes(path.join(opts.outDir, "ast-chunks.jsonl"), astChunksBytes),
    writeBytes(path.join(opts.outDir, "xrefs.jsonl"), xrefsBytes),
    writeBytes(path.join(opts.outDir, "findings.jsonl"), findingsBytes),
    writeBytes(path.join(opts.outDir, "licenses.md"), licensesBytes),
    writeBytes(path.join(opts.outDir, "context-bom.json"), contextBomBytes),
    writeBytes(path.join(opts.outDir, "readme.md"), readmeBytes),
  ]);
  await writeBytes(path.join(opts.outDir, "manifest.json"), manifestBytes);

  return manifest;
}

/**
 * Encode an array of objects as canonical-JSON JSONL — one canonical-form
 * line per row, LF-only, trailing newline. Empty arrays produce an empty
 * file (zero bytes). Canonical JSON guarantees byte-identity per row.
 */
function encodeJsonl(rows: readonly unknown[]): Uint8Array {
  if (rows.length === 0) return new Uint8Array(0);
  const lines: string[] = [];
  for (const r of rows) lines.push(canonicalJson(r));
  return encodeUtf8(`${lines.join("\n")}\n`);
}

function encodeUtf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function bomItem(kind: BomItem["kind"], filePath: string, bytes: Uint8Array): BomItem {
  return { kind, path: filePath, fileHash: sha256HexBytes(bytes) };
}

function sha256HexBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeBytes(p: string, bytes: Uint8Array): Promise<void> {
  await writeFile(p, bytes);
}

/**
 * Resolve the determinism class. A `degraded` chunker (AST chunker fell back
 * to line-split) dominates everything; Anthropic tokenizers downgrade to
 * `best_effort`; otherwise `strict`.
 */
function resolveDeterminism(
  tokenizerId: string,
  chunkerClass: AstChunkerResult["determinismClass"],
): DeterminismClass {
  if (chunkerClass === "degraded") return "degraded";
  if (tokenizerId.startsWith("anthropic:")) return "best_effort";
  return "strict";
}

/**
 * Project `File` graph nodes onto the context-receipt's `ContextFile` shape.
 * Reads the same fields `file-tree` does (path, contentHash, lineCount,
 * language). Folders are excluded — the receipt records files only. The
 * builder sorts, so order here is irrelevant.
 */
async function collectContextFiles(graph: IGraphStore): Promise<ContextFile[]> {
  const nodes = await graph.listNodes({ kinds: ["File"] });
  const files: ContextFile[] = [];
  for (const node of nodes) {
    if (node.kind !== "File") continue;
    files.push({
      path: node.filePath,
      ...(node.contentHash !== undefined ? { contentHash: node.contentHash } : {}),
      ...(node.lineCount !== undefined ? { lineCount: node.lineCount } : {}),
      ...(node.language !== undefined ? { language: node.language } : {}),
    });
  }
  return files;
}

/**
 * Group AST chunks into per-path byte spans for the context receipt. Empty
 * when the chunker produced no chunks (the production default, since raw
 * file bytes are supplied only in tests) — the builder then omits the
 * `byteRanges` property rather than recording empty ranges.
 */
function collectByteRanges(chunks: AstChunkerResult["chunks"]): ReadonlyMap<string, ByteSpan[]> {
  const byPath = new Map<string, ByteSpan[]>();
  for (const chunk of chunks) {
    const spans = byPath.get(chunk.path);
    const span: ByteSpan = { start: chunk.startByte, end: chunk.endByte };
    if (spans === undefined) byPath.set(chunk.path, [span]);
    else spans.push(span);
  }
  return byPath;
}

/**
 * Resolve the composed store. The seam accepts a composed `Store`; tests
 * can still pass an `IGraphStore` alone via `internal.graphOnly` and we
 * wrap it into a minimal `Store` shape — the BOM bodies read only the
 * `graph` view.
 */
async function resolveStore(internal: GeneratePackInternalOpts, repoPath: string): Promise<Store> {
  if (internal.store !== undefined) return internal.store;
  if (internal.graphOnly !== undefined) return wrapGraphOnly(internal.graphOnly);
  return openStoreFromRepoPath(repoPath);
}

/**
 * Wrap a graph-only store so the legacy test seam (`internal.graphOnly`)
 * resolves into the `Store` shape `generatePack` expects. The temporal
 * view is unused by the BOM bodies (they read only `store.graph`), so it
 * is a typed alias of the graph value.
 */
function wrapGraphOnly(graph: IGraphStore): Store {
  return {
    graph,
    temporal: graph as unknown as Store["temporal"],
    graphFile: ":memory:",
    temporalFile: ":memory:",
    close: async () => {
      // Caller owns the graph lifecycle when passing `graphOnly`.
    },
  };
}

/**
 * Open a store from the repo path. Tests inject `internal.store` (or
 * `internal.graphOnly`) instead; production store lookup is wired by the
 * CLI integration layer.
 */
async function openStoreFromRepoPath(_repoPath: string): Promise<Store> {
  // Production store lookup is wired by the CLI integration layer.
  // Keep a clear failure mode here so callers that forget to inject a
  // store in tests (or skip the CLI in production) fail loudly.
  throw new Error(
    "generatePack: production store lookup is wired by the CLI; pass internal.store in tests.",
  );
}
