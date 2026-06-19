/**
 * @opencodehub/pack — deterministic code-pack BOM.
 *
 * Public surface:
 *   - generatePack(opts): assembles the 9-item BOM (skeleton, file-tree,
 *     deps, ast-chunks, xrefs, findings, licenses.md, readme.md, optional
 *     Parquet embeddings sidecar) plus the manifest. The Parquet sidecar
 *     is absent when no embeddings exist.
 *   - buildManifest / serializeManifest: BOM manifest + pack_hash.
 *   - Per-BOM-item builders re-exported for direct use (skeleton, file-tree,
 *     deps, ast-chunker, xrefs, findings, licenses, readme,
 *     embeddings-sidecar).
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
import { buildDeps } from "./deps.js";
import { type SidecarDeterminismClass, writeEmbeddingsSidecar } from "./embeddings-sidecar.js";
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
export type {
  SidecarDeterminismClass,
  SidecarOptions,
  SidecarResult,
  SidecarWriterBackend,
} from "./embeddings-sidecar.js";
export { writeEmbeddingsSidecar } from "./embeddings-sidecar.js";
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
 * `store` is the composed {@link Store} (= `OpenStoreResult`) — the
 * embeddings sidecar dispatches on `store.backend` and reaches the
 * temporal-tier DuckDB COPY helper through this seam. Tests that only
 * need graph-side reads can pass an {@link IGraphStore} via the
 * `graphOnly` field; the sidecar then takes the absent path automatically.
 */
export interface GeneratePackInternalOpts {
  readonly store?: Store;
  /**
   * Backwards-compatible escape hatch — tests can supply an
   * {@link IGraphStore} alone when they don't exercise the sidecar.
   * Internally wrapped into a minimal {@link Store}; the temporal view is
   * a typed alias of the graph value, sufficient for tests that only
   * exercise the graph-tier reads.
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
  readonly duckdbVersion?: string;
  readonly grammarCommits?: Readonly<Record<string, string>>;
}

/**
 * Generate the deterministic 9-item code-pack.
 *
 * Writes the 8 always-present BOM files plus the manifest into
 * `opts.outDir`, plus an optional Parquet sidecar when the underlying
 * embeddings table has rows:
 *   - skeleton.jsonl
 *   - file-tree.jsonl
 *   - deps.jsonl
 *   - ast-chunks.jsonl
 *   - xrefs.jsonl
 *   - findings.jsonl
 *   - licenses.md
 *   - readme.md
 *   - embeddings.parquet (optional — absent when no embeddings)
 *   - manifest.json
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

  // --- BOM bodies (5 in-graph + chunker on raw files). ---
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

  // --- Serialize bodies. ---
  const skeletonBytes = encodeJsonl(skeletonRows);
  const fileTreeBytes = encodeJsonl(fileTreeRows);
  const depsBytes = encodeJsonl(depsRows);
  const xrefsBytes = encodeJsonl(xrefRows);
  const findingsBytes = encodeJsonl(findingGroups);
  const astChunksBytes = encodeJsonl(astResult.chunks);
  const licensesBytes = encodeUtf8(licensesContent.licensesMd);

  // --- Compute BomItem[] in cache-prefix-stable order: most-stable items
  //     first, most-volatile last. The array order flows into
  //     manifest.files[] (manifest.ts:85) and therefore into the packHash
  //     preimage, so it ALSO defines the order in which a consumer that
  //     concatenates the BOM into a prompt would lay the bytes down. A
  //     prompt cache matches the longest 100%-identical byte prefix and
  //     invalidates at the first differing byte, so emitting the items
  //     least likely to differ commit-to-commit FIRST maximizes the
  //     cache-eligible prefix length:
  //       1. skeleton  — symbol structure; changes only on symbol churn.
  //       2. file-tree — file paths + framework labels; file-set churn only.
  //       3. deps      — lockfile versions; dependency-bump churn only.
  //       4. licenses  — derived from deps + repo NOTICE files; downstream
  //                      of deps, so ~equally stable.
  //       5. xrefs     — SCIP communities + calls; shifts with the call
  //                      graph / community detection.
  //       6. ast-chunks — token-budget + tokenizer sensitive (volatile).
  //       7. findings  — scanner-run sensitive; SARIF churns every scan.
  //     The optional embeddings sidecar (most volatile) is pushed last,
  //     after this static body. (manifest + readme are derived AFTER, so
  //     the manifest knows about its own readme without depending on read
  //     order.) ---
  const items: BomItem[] = [
    bomItem("skeleton", "skeleton.jsonl", skeletonBytes),
    bomItem("file-tree", "file-tree.jsonl", fileTreeBytes),
    bomItem("deps", "deps.jsonl", depsBytes),
    bomItem("licenses", "licenses.md", licensesBytes),
    bomItem("xrefs", "xrefs.jsonl", xrefsBytes),
    bomItem("ast-chunks", "ast-chunks.jsonl", astChunksBytes), // volatile (budget/tokenizer)
    bomItem("findings", "findings.jsonl", findingsBytes), // volatile (scan run)
  ];

  // --- Optional Parquet embeddings sidecar (BOM item #7). Embeddings live
  //     in the lbug graph; the sidecar streams them through the DuckDB
  //     temporal store's deterministic COPY-to-Parquet path. When written,
  //     the sidecar's runtime `SELECT version()` overrides
  //     `pins.duckdbVersion` so the manifest binds determinism to the engine
  //     version that produced the file — the parquet `created_by` metadata
  //     embeds it. ---
  await mkdir(opts.outDir, { recursive: true });
  const sidecarPath = path.join(opts.outDir, "embeddings.parquet");
  const sidecar = await writeEmbeddingsSidecar({ store, outPath: sidecarPath });
  if (sidecar.written && sidecar.fileHash !== undefined) {
    items.push({
      kind: "embeddings-sidecar",
      path: "embeddings.parquet",
      fileHash: sidecar.fileHash,
    });
  }

  // --- Resolve the determinism class + pins object. A `degraded` chunker
  //     (AST chunker fell back to line-split) dominates the class via the
  //     precedence rule: `degraded` wins over `best_effort`, which wins over
  //     `strict`. The sidecar is always `strict`, so it never downgrades. ---
  const determinismClass = resolveDeterminism(
    opts.tokenizerId,
    astResult.determinismClass,
    sidecar.determinismClass,
  );
  const pins: PackPins = {
    chonkieVersion: astResult.pinsHint.chonkieVersion ?? "unknown",
    // Prefer the runtime DuckDB engine version reported by the sidecar
    // when it actually wrote a file — that string is what the parquet
    // `created_by` metadata carries. Fall back to the test-injectable
    // override, then the @duckdb/node-api package version, then "unknown".
    duckdbVersion:
      sidecar.pinsHint.duckdbVersion ??
      internal.duckdbVersion ??
      (await readDuckdbVersion()) ??
      "unknown",
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

  // --- Write everything. The outDir was already created above to host
  //     the optional Parquet sidecar; the bodies share it.
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
 * Resolve the determinism class. A `degraded` chunker (AST chunker fell back
 * to line-split) dominates everything; Anthropic tokenizers downgrade to
 * `best_effort`; otherwise `strict`. The sidecar's own class is always
 * `"strict"` ({@link SidecarDeterminismClass}) post-ADR-0016 — the
 * DuckDB-temporal writer is the only sidecar path — so it never downgrades
 * the result and is accepted only to keep the precedence rule explicit.
 */
function resolveDeterminism(
  tokenizerId: string,
  chunkerClass: AstChunkerResult["determinismClass"],
  _sidecarClass: SidecarDeterminismClass,
): DeterminismClass {
  if (chunkerClass === "degraded") return "degraded";
  if (tokenizerId.startsWith("anthropic:")) return "best_effort";
  return "strict";
}

/**
 * Resolve the composed store. The seam accepts a composed `Store`; tests
 * that don't exercise the sidecar can still pass an `IGraphStore` via
 * `internal.graphOnly` and we wrap it into a minimal `Store` shape that
 * funnels the sidecar to its absent path automatically (no `temporal`
 * DuckDB → no COPY helper → `writerBackend: "absent"`).
 */
async function resolveStore(internal: GeneratePackInternalOpts, repoPath: string): Promise<Store> {
  if (internal.store !== undefined) return internal.store;
  if (internal.graphOnly !== undefined) return wrapGraphOnly(internal.graphOnly);
  return openStoreFromRepoPath(repoPath);
}

/**
 * Wrap a graph-only store so the legacy test seam (`internal.graphOnly`)
 * resolves into the `Store` shape `generatePack` now expects. The temporal
 * view is a stub that drains the embeddings stream and reports `rowCount:
 * 0` — sufficient for tests that don't exercise sidecar emission.
 */
function wrapGraphOnly(graph: IGraphStore): Store {
  // Drain the stream without writing anything — graph-only tests don't
  // exercise the COPY path, so reporting rowCount: 0 keeps the sidecar
  // result `absent` regardless of how many embeddings the fake produces.
  const stubTemporal = {
    exportEmbeddingsToParquet: async (
      rows: AsyncIterable<unknown>,
    ): Promise<{ rowCount: number; duckdbVersion: string }> => {
      for await (const _row of rows) {
        // drain
      }
      return { rowCount: 0, duckdbVersion: "stub" };
    },
  };
  return {
    graph,
    temporal: stubTemporal as unknown as Store["temporal"],
    graphFile: ":memory:",
    temporalFile: ":memory:",
    close: async () => {
      // Caller owns the graph lifecycle when passing `graphOnly`.
    },
  };
}

/**
 * Open a store from the repo path. Lazily imports `@opencodehub/storage`
 * to keep the pack package importable in environments where DuckDB
 * native bindings can't load. Tests inject `internal.store` (or
 * `internal.graphOnly`) instead.
 */
async function openStoreFromRepoPath(_repoPath: string): Promise<Store> {
  // Production store lookup is wired by the CLI integration layer.
  // Keep a clear failure mode here so callers that forget to inject a
  // store in tests (or skip the CLI in production) fail loudly.
  throw new Error(
    "generatePack: production store lookup is wired by the CLI; pass internal.store in tests.",
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
