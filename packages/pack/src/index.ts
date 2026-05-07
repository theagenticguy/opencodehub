/**
 * @opencodehub/pack — deterministic M5 code-pack BOM.
 *
 * Public surface:
 *   - generatePack(opts): assembles the 8-item BOM (skeleton, file-tree,
 *     deps, ast-chunks, xrefs, findings, licenses.md, readme.md) plus the
 *     manifest. Parquet sidecar is owned by T-W3-1 and intentionally NOT
 *     emitted here.
 *   - buildManifest / serializeManifest: BOM manifest + pack_hash (AC-M5-3).
 *   - Per-BOM-item builders re-exported for direct use (skeleton, file-tree,
 *     deps, ast-chunker, xrefs, findings, licenses, readme).
 *   - Type surface: {BomItem, DeterminismClass, PackManifest, PackOpts, PackPins}.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "@opencodehub/core-types";
import type { IGraphStore } from "@opencodehub/storage";
import {
  type AstChunkerInternalOpts,
  type AstChunkerResult,
  buildAstChunks,
} from "./ast-chunker.js";
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
 */
export interface GeneratePackInternalOpts {
  readonly store?: IGraphStore;
  readonly commit?: string;
  readonly repoOriginUrl?: string | null;
  readonly chunkerFiles?: ReadonlyArray<{
    readonly path: string;
    readonly bytes: Uint8Array;
    readonly language?: string;
  }>;
  readonly chonkieLoader?: AstChunkerInternalOpts["_loadChonkie"];
  readonly duckdbVersion?: string;
  readonly grammarCommits?: Readonly<Record<string, string>>;
}

/**
 * Generate the deterministic 9-item code-pack (8 files in this M5 cut;
 * the Parquet sidecar lands in T-W3-1 and is intentionally absent here).
 *
 * Writes 8 files plus the manifest into `opts.outDir`:
 *   - skeleton.jsonl
 *   - file-tree.jsonl
 *   - deps.jsonl
 *   - ast-chunks.jsonl
 *   - xrefs.jsonl
 *   - findings.jsonl
 *   - licenses.md
 *   - readme.md
 *   - manifest.json
 *
 * Determinism class:
 *   - `"strict"` by default.
 *   - `"best_effort"` when `tokenizerId` starts with `"anthropic:"` (S-M5-2).
 *   - `"degraded"` when the AST chunker fell back to line-split (S-M5-1).
 *
 * The function always writes the manifest LAST so a partial run never
 * leaves a manifest pointing at hashes that don't match the on-disk
 * payloads.
 */
export async function generatePack(
  opts: PackOpts,
  internal: GeneratePackInternalOpts = {},
): Promise<PackManifest> {
  const store = internal.store ?? (await openStoreFromRepoPath(opts.repoPath));
  const commit = internal.commit ?? "";
  const repoOriginUrl = internal.repoOriginUrl !== undefined ? internal.repoOriginUrl : null;

  // --- BOM bodies (5 in-graph + chunker on raw files). ---
  const [skeletonRows, fileTreeRows, depsRows, xrefRows, findingGroups, licensesContent] =
    await Promise.all([
      buildSkeleton({ store }),
      buildFileTree({ store }),
      buildDeps({ store }),
      buildXrefs({ store }),
      buildFindings({ store }),
      buildLicenses({ store, repoPath: opts.repoPath }),
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
  ];

  // --- Resolve the determinism class + pins object. ---
  const determinismClass = resolveDeterminism(opts.tokenizerId, astResult.determinismClass);
  const pins: PackPins = {
    chonkieVersion: astResult.pinsHint.chonkieVersion ?? "unknown",
    duckdbVersion: internal.duckdbVersion ?? (await readDuckdbVersion()) ?? "unknown",
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
  });

  const manifestJson = serializeManifest(manifest);
  const manifestBytes = encodeUtf8(manifestJson);

  const readmeMd = buildReadme({
    manifest,
    bomItemPaths: [...items.map((i) => i.path), "manifest.json"],
  });
  const readmeBytes = encodeUtf8(readmeMd);

  // --- Write everything. mkdirp the outDir first. ---
  await mkdir(opts.outDir, { recursive: true });
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
 * Resolve the determinism class. `degraded` from the chunker dominates;
 * Anthropic tokenizers downgrade to `best_effort`; otherwise `strict`.
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
 * Open a store from the repo path. Lazily imports `@opencodehub/storage`
 * to keep the pack package importable in environments where DuckDB
 * native bindings can't load. Tests inject `internal.store` instead.
 */
async function openStoreFromRepoPath(_repoPath: string): Promise<IGraphStore> {
  // M5 leaves the production lookup wiring to AC-M5-7 (CLI integration).
  // Keep a clear failure mode here so the wiring AC catches it loudly.
  throw new Error(
    "generatePack: production store lookup is owned by AC-M5-7; pass internal.store in tests.",
  );
}

/**
 * Read `@duckdb/node-api`'s package.json for the version pin. Returns
 * `undefined` if the package isn't installed (e.g. browser build), so
 * the pins object falls back to `"unknown"`.
 */
async function readDuckdbVersion(): Promise<string | undefined> {
  try {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const pkg = require("@duckdb/node-api/package.json") as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}
