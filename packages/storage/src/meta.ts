/**
 * Sidecar metadata reader / writer for `<repo>/.codehub/meta.json`.
 *
 * The DuckDB database stores the same information in its `store_meta` table,
 * but the sidecar is plain JSON so tools outside the OpenCodeHub runtime (e.g.
 * CI staleness probes) can read it without linking libduckdb.
 *
 * Writes are atomic: the payload is written to a temp file in the target
 * directory and renamed over the destination. `fs.rename` is atomic on POSIX
 * and Windows when source and destination sit on the same filesystem, which
 * is guaranteed here because both live inside `<repo>/.codehub`.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { StoreMeta } from "./interface.js";
import { resolveMetaFilePath } from "./paths.js";

const ENCODING = "utf8";

export async function readStoreMeta(repoPath: string): Promise<StoreMeta | undefined> {
  const target = resolveMetaFilePath(repoPath);
  let raw: string;
  try {
    raw = await readFile(target, ENCODING);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const parsed = JSON.parse(raw) as StoreMeta;
  validateStoreMeta(parsed, target);
  return parsed;
}

export async function writeStoreMeta(repoPath: string, meta: StoreMeta): Promise<void> {
  const target = resolveMetaFilePath(repoPath);
  const dir = dirname(target);
  await mkdir(dir, { recursive: true });

  // Canonicalize field order so two independent writes with identical data
  // produce identical bytes (makes snapshot tests stable). v1.1 adds three
  // optional cache-health fields; they sort alphabetically among themselves
  // and are appended after the existing v1.0 canonical block so pre-v1.1
  // snapshots continue to byte-match when the new fields are absent.
  const ordered: StoreMeta = {
    schemaVersion: meta.schemaVersion,
    ...(meta.lastCommit !== undefined ? { lastCommit: meta.lastCommit } : {}),
    indexedAt: meta.indexedAt,
    nodeCount: meta.nodeCount,
    edgeCount: meta.edgeCount,
    ...(meta.stats !== undefined ? { stats: sortKeys(meta.stats) } : {}),
    ...(meta.cacheHitRatio !== undefined ? { cacheHitRatio: meta.cacheHitRatio } : {}),
    ...(meta.cacheSizeBytes !== undefined ? { cacheSizeBytes: meta.cacheSizeBytes } : {}),
    ...(meta.lastCompaction !== undefined ? { lastCompaction: meta.lastCompaction } : {}),
  };

  const payload = `${JSON.stringify(ordered, null, 2)}\n`;
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, payload, { encoding: ENCODING, mode: 0o644 });
  await rename(tmp, target);
}

function sortKeys(o: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(o).sort()) {
    const v = o[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function validateStoreMeta(value: unknown, source: string): asserts value is StoreMeta {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Invalid meta.json at ${source}: not an object`);
  }
  const v = value as Record<string, unknown>;
  // Bracket access required by tsconfig's `noPropertyAccessFromIndexSignature`.
  // biome-ignore lint/complexity/useLiteralKeys: dot-access is disallowed on Record index signatures
  if (typeof v["schemaVersion"] !== "string") {
    throw new Error(`Invalid meta.json at ${source}: schemaVersion missing`);
  }
  // biome-ignore lint/complexity/useLiteralKeys: dot-access is disallowed on Record index signatures
  if (typeof v["indexedAt"] !== "string") {
    throw new Error(`Invalid meta.json at ${source}: indexedAt missing`);
  }
  // biome-ignore lint/complexity/useLiteralKeys: dot-access is disallowed on Record index signatures
  if (typeof v["nodeCount"] !== "number" || typeof v["edgeCount"] !== "number") {
    throw new Error(`Invalid meta.json at ${source}: counts missing`);
  }
  // biome-ignore lint/complexity/useLiteralKeys: dot-access is disallowed on Record index signatures
  const cacheHitRatio = v["cacheHitRatio"];
  if (cacheHitRatio !== undefined && typeof cacheHitRatio !== "number") {
    throw new Error(`Invalid meta.json at ${source}: cacheHitRatio must be a number`);
  }
  // biome-ignore lint/complexity/useLiteralKeys: dot-access is disallowed on Record index signatures
  const cacheSizeBytes = v["cacheSizeBytes"];
  if (cacheSizeBytes !== undefined && typeof cacheSizeBytes !== "number") {
    throw new Error(`Invalid meta.json at ${source}: cacheSizeBytes must be a number`);
  }
  // biome-ignore lint/complexity/useLiteralKeys: dot-access is disallowed on Record index signatures
  const lastCompaction = v["lastCompaction"];
  if (lastCompaction !== undefined && typeof lastCompaction !== "string") {
    throw new Error(`Invalid meta.json at ${source}: lastCompaction must be a string`);
  }
}
