/**
 * Content-addressed parse cache (Stream E, W2-E.1).
 *
 * Per-file JSON sidecar under `<repo>/.codehub/parse-cache/`, keyed on
 * `sha256(content) + grammarSha + pipelineVersion`. Grammar and pipeline
 * version changes invalidate cleanly because they participate in the cache
 * filename — readers that look up the fresh key just miss on old entries.
 *
 * Layout (matches research-mcp-groups-cache.yaml topic_5):
 *
 *   .codehub/parse-cache/<contentSha[0..2]>/<contentSha>-<grammarSha[0..6]>-<pipelineVersion>.json
 *
 * The 2-char shard prefix keeps each directory under ~2k entries at 100k
 * file scale, which most filesystems handle well. Short grammarSha + full
 * pipelineVersion in the filename keep the disk layout human-inspectable
 * (you can `rm -rf .codehub/parse-cache/` at any time without corruption —
 * the cache is purely a latency optimization, never source of truth).
 *
 * This module is a **utility**, not a pipeline phase:
 *   - Scan writes `grammarSha` onto each `ScannedFile`.
 *   - `parse.ts` consumes the utility: lookup → replay → fill. Hits bypass
 *     the worker pool entirely; misses go through the worker pool and then
 *     serialize their {@link CachedExtractions} back to disk for next time.
 *
 * Atomic writes go through `write-file-atomic` (reused helper pattern from
 * `packages/cli/src/fs-atomic.ts`): temp file + fsync + rename. Reads
 * tolerate missing or malformed files by returning `null` — a cache miss
 * is normal behavior, never an error.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { default as wfa } from "write-file-atomic";
import type {
  ExtractedCall,
  ExtractedDefinition,
  ExtractedHeritage,
  ExtractedImport,
} from "../../providers/extraction-types.js";

/** Current cache envelope schema. Bump in lockstep with breaking changes. */
export const CACHE_VERSION = 2;
/** Shard prefix length; 2 chars → 256 buckets, each <~400 entries at 100k. */
const SHARD_PREFIX_LEN = 2;
/** Grammar SHA bytes embedded in the filename (first 6 hex chars). */
const GRAMMAR_SHA_IN_FILENAME_LEN = 6;

/** Serialization-friendly mirror of {@link ParseCapture}. */
export interface CachedCapture {
  /** Capture tag, e.g. `@definition.function`. */
  readonly tag: string;
  /** Byte offset of capture start (0-indexed). */
  readonly startByte: number;
  /** Byte offset of capture end (exclusive). */
  readonly endByte: number;
  /** 1-indexed start line. */
  readonly startLine: number;
  /** 1-indexed end line. */
  readonly endLine: number;
  /** 0-indexed start column. */
  readonly startCol: number;
  /** 0-indexed end column. */
  readonly endCol: number;
  /** Source-text slice the capture refers to. */
  readonly text: string;
  /** Underlying tree-sitter node type. */
  readonly nodeType: string;
}

/**
 * Extraction payload produced by the language-provider extractors. This is
 * the canonical cached unit — the v2 cache stores post-extraction results
 * rather than raw captures, because captures alone cannot reconstruct the
 * downstream nodes/edges without re-running provider logic that in turn
 * requires the original source text.
 */
export interface CachedExtractions {
  readonly definitions: readonly ExtractedDefinition[];
  readonly calls: readonly ExtractedCall[];
  readonly imports: readonly ExtractedImport[];
  readonly heritage: readonly ExtractedHeritage[];
}

/**
 * Single-file parse artifact cached alongside the repo.
 *
 * v2 (current): stores {@link CachedExtractions}. `captures` is retained as
 * an optional field so intermediate-stage tooling (e.g. debugging queries)
 * can still attach raw captures without breaking the consumer contract.
 */
export interface CacheEntry {
  readonly cacheVersion: typeof CACHE_VERSION;
  readonly grammarSha: string;
  readonly pipelineVersion: string;
  readonly extractions: CachedExtractions;
  /** Raw captures — optional at v2; present only when debug/tooling writes them. */
  readonly captures?: readonly CachedCapture[];
  readonly metadata: {
    readonly language: string;
    readonly byteSize: number;
  };
}

/** Composite key that addresses one cache entry deterministically. */
export interface CacheKey {
  readonly contentSha: string;
  readonly grammarSha: string;
  readonly pipelineVersion: string;
}

/**
 * Build a cache key from its three components. Pure; performs no IO.
 * Inputs must already be content-addressed (sha256 hex) or semver strings —
 * no normalization is applied here.
 */
export function deriveCacheKey(
  contentSha: string,
  grammarSha: string,
  pipelineVersion: string,
): CacheKey {
  return { contentSha, grammarSha, pipelineVersion };
}

/**
 * Resolve the on-disk path for a cache key under `cacheDir`.
 *
 * Layout:
 *   `<cacheDir>/<contentSha[0..2]>/<contentSha>-<grammarSha[0..6]>-<pipelineVersion>.json`
 *
 * The grammarSha/pipelineVersion suffix ensures two simultaneous entries
 * for the same content (e.g. before/after a grammar bump) cannot clobber
 * each other — older entries simply become unreachable and are cleaned up
 * lazily by a future eviction pass (W2-E.4).
 */
export function cacheFilePath(cacheDir: string, key: CacheKey): string {
  const shard = key.contentSha.slice(0, SHARD_PREFIX_LEN);
  const shortGrammar = key.grammarSha.slice(0, GRAMMAR_SHA_IN_FILENAME_LEN);
  const filename = `${key.contentSha}-${shortGrammar}-${key.pipelineVersion}.json`;
  return path.join(cacheDir, shard, filename);
}

/**
 * Read a cache entry. Returns `null` on any failure (missing file, read
 * error, JSON parse error, shape mismatch) — a cache miss is never fatal.
 *
 * This deliberately does NOT validate the envelope deeply; downstream
 * consumers treat the shape as advisory and will rebuild on any surprise.
 */
export async function readCacheEntry(cacheDir: string, key: CacheKey): Promise<CacheEntry | null> {
  const filePath = cacheFilePath(cacheDir, key);
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isCacheEntry(parsed)) {
    return null;
  }
  // Double-check the envelope matches the composed key — protects against a
  // filesystem races where a stale/misnamed file could shadow a fresh one.
  if (parsed.grammarSha !== key.grammarSha || parsed.pipelineVersion !== key.pipelineVersion) {
    return null;
  }
  return parsed;
}

/**
 * Write a cache entry atomically. Creates the shard directory if missing.
 * Never throws on `mkdir EEXIST`; other IO failures propagate to the caller.
 */
export async function writeCacheEntry(
  cacheDir: string,
  key: CacheKey,
  entry: CacheEntry,
): Promise<void> {
  const filePath = cacheFilePath(cacheDir, key);
  const parentDir = path.dirname(filePath);
  // recursive:true already tolerates EEXIST; kept explicit for readability.
  await fs.mkdir(parentDir, { recursive: true });
  const payload = `${JSON.stringify(entry, null, 2)}\n`;
  await writeFileAtomicAsync(filePath, payload);
}

/**
 * Walk `cacheDir` and report total file count + byte size. Used by the
 * meta-sidecar cache-stats path (W2-E.4). Returns zeros when the directory
 * does not exist.
 */
export async function computeCacheSize(
  cacheDir: string,
): Promise<{ readonly fileCount: number; readonly bytes: number }> {
  let fileCount = 0;
  let bytes = 0;
  try {
    const shards = await fs.readdir(cacheDir, { withFileTypes: true });
    // Sort for deterministic traversal — size totals are commutative but
    // deterministic iteration makes error messages reproducible.
    shards.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const shard of shards) {
      if (!shard.isDirectory()) continue;
      const shardPath = path.join(cacheDir, shard.name);
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(shardPath, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const e of entries) {
        if (!e.isFile()) continue;
        const entryPath = path.join(shardPath, e.name);
        try {
          const s = await fs.stat(entryPath);
          fileCount += 1;
          bytes += s.size;
        } catch {
          // Skip files that disappeared during traversal.
        }
      }
    }
  } catch {
    // Missing cache dir → zeroes.
  }
  return { fileCount, bytes };
}

/** Promise wrapper around write-file-atomic's callback/promise dual API. */
async function writeFileAtomicAsync(filePath: string, contents: string): Promise<void> {
  await wfa(filePath, contents, { encoding: "utf8", fsync: true });
}

function isCacheEntry(v: unknown): v is CacheEntry {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o["cacheVersion"] !== CACHE_VERSION) return false;
  if (typeof o["grammarSha"] !== "string") return false;
  if (typeof o["pipelineVersion"] !== "string") return false;
  const ex = o["extractions"];
  if (ex === null || typeof ex !== "object") return false;
  const e = ex as Record<string, unknown>;
  if (!Array.isArray(e["definitions"])) return false;
  if (!Array.isArray(e["calls"])) return false;
  if (!Array.isArray(e["imports"])) return false;
  if (!Array.isArray(e["heritage"])) return false;
  // `captures` is optional at v2 — validate only if present.
  if (o["captures"] !== undefined && !Array.isArray(o["captures"])) return false;
  const md = o["metadata"];
  if (md === null || typeof md !== "object") return false;
  const m = md as Record<string, unknown>;
  if (typeof m["language"] !== "string") return false;
  if (typeof m["byteSize"] !== "number") return false;
  return true;
}
