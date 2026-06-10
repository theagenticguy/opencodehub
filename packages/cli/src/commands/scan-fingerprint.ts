/**
 * Scan-INPUT fingerprint sidecar — lets `codehub analyze` skip the
 * Priority-1 scanner pass (and reuse the prior `scan.sarif`) when the
 * scanned content and the selected scanner set are unchanged and `--force`
 * was not passed.
 *
 * Why a separate sidecar from `scan-state.json`: that file is a per-file SHA
 * manifest feeding the incremental GRAPH (`loadPreviousGraph`). This one
 * fingerprints the SCAN inputs — the same per-file SHAs PLUS the selected
 * scanner-id set — so installing or removing a scanner invalidates the cache
 * even when no source file moved. We keep it a `.codehub/` sibling rather
 * than folding it into `StoreMeta` so a meta-dir clean invalidates the index
 * and the scan cache together, and so the byte-stable `StoreMeta` /
 * `writeStoreMeta` canonical-order contract stays untouched.
 *
 * The fingerprint is order-independent: `(relPath, sha256)` pairs and
 * scanner ids are sorted before hashing, so a re-walk that yields the same
 * content in a different order still matches.
 */

import { join } from "node:path";
import { sha256Hex } from "@opencodehub/core-types";
import { resolveRepoMetaDir } from "@opencodehub/storage";

/** A scanned-file content reference — the slice of `ScannedFile` we hash. */
export interface FingerprintFile {
  readonly relPath: string;
  readonly sha256: string;
}

/** Persisted shape of `<repo>/.codehub/scan-fingerprint.json`. */
export interface ScanFingerprintSidecar {
  readonly schemaVersion: 1;
  readonly fingerprint: string;
  readonly scannedAt: string;
  readonly scannerIds: readonly string[];
}

/** Inputs to the skip decision. Kept as a flat record so the helper is pure. */
export interface ShouldSkipScanInput {
  readonly force: boolean;
  readonly priorFingerprint: string | undefined;
  readonly currentFingerprint: string;
  readonly sarifExists: boolean;
}

/**
 * Compute a stable hex fingerprint over the scan INPUTS: the per-file
 * `(relPath, sha256)` pairs and the selected scanner ids.
 *
 * Determinism + order-independence: both inputs are sorted before
 * serialization, so reordering the file list or the scanner list does not
 * change the result. Changing any file's sha256, adding/removing a file, or
 * adding/removing a scanner id all change the result. The serialization is a
 * single deterministic string hashed with sha256 (reusing the repo's
 * `sha256Hex` util so the hashing primitive stays single-source).
 */
export function computeScanFingerprint(
  files: readonly FingerprintFile[],
  scannerIds: readonly string[],
): string {
  const sortedFiles = [...files].sort((a, b) => {
    if (a.relPath !== b.relPath) return a.relPath < b.relPath ? -1 : 1;
    return a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0;
  });
  const sortedScanners = [...scannerIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // Newline/tab-delimited, explicitly framed sections. The `files:` /
  // `scanners:` markers keep an empty file set distinct from an empty
  // scanner set so two different-but-empty inputs can't collide.
  const filePart = sortedFiles.map((f) => `${f.relPath}\t${f.sha256}`).join("\n");
  const scannerPart = sortedScanners.join("\n");
  const serialized = `files:\n${filePart}\nscanners:\n${scannerPart}`;
  return sha256Hex(serialized);
}

/**
 * Pure skip decision. Skip the scan only when ALL hold:
 *   - `--force` was NOT passed,
 *   - a prior fingerprint exists AND equals the current one,
 *   - the prior `scan.sarif` still exists on disk.
 *
 * Any miss (force, no prior, mismatch, missing sarif) means "run the scan".
 */
export function shouldSkipScan(input: ShouldSkipScanInput): boolean {
  if (input.force) return false;
  if (input.priorFingerprint === undefined) return false;
  if (input.priorFingerprint !== input.currentFingerprint) return false;
  return input.sarifExists;
}

/** Absolute path to the fingerprint sidecar for a repo. */
export function scanFingerprintPath(repoPath: string): string {
  return join(resolveRepoMetaDir(repoPath), "scan-fingerprint.json");
}

/**
 * Read `<repo>/.codehub/scan-fingerprint.json`. Returns `undefined` on a
 * missing or corrupt file (treated as a cache miss → the scan re-runs).
 */
export async function readScanFingerprint(
  repoPath: string,
): Promise<ScanFingerprintSidecar | undefined> {
  const { readFile } = await import("node:fs/promises");
  try {
    const raw = await readFile(scanFingerprintPath(repoPath), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { schemaVersion?: unknown }).schemaVersion !== 1 ||
      typeof (parsed as { fingerprint?: unknown }).fingerprint !== "string" ||
      typeof (parsed as { scannedAt?: unknown }).scannedAt !== "string" ||
      !Array.isArray((parsed as { scannerIds?: unknown }).scannerIds)
    ) {
      return undefined;
    }
    const obj = parsed as ScanFingerprintSidecar;
    // Guard the array element type so a corrupt `scannerIds` can't smuggle
    // non-strings into a caller that treats the field as `string[]`.
    if (!obj.scannerIds.every((s) => typeof s === "string")) return undefined;
    return obj;
  } catch {
    return undefined;
  }
}

/**
 * Write `<repo>/.codehub/scan-fingerprint.json` with a deterministic key
 * order (`schemaVersion`, `fingerprint`, `scannedAt`, `scannerIds`) and a
 * sorted `scannerIds` array so the sidecar round-trips byte-stably.
 */
export async function writeScanFingerprint(
  repoPath: string,
  sidecar: ScanFingerprintSidecar,
): Promise<void> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(resolveRepoMetaDir(repoPath), { recursive: true });
  const payload: ScanFingerprintSidecar = {
    schemaVersion: 1,
    fingerprint: sidecar.fingerprint,
    scannedAt: sidecar.scannedAt,
    scannerIds: [...sidecar.scannerIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  };
  await writeFile(scanFingerprintPath(repoPath), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/**
 * Best-effort count of the findings recorded in a SARIF log on disk, used
 * only to enrich the skip log line. Returns `undefined` when the file is
 * missing or unparseable — callers omit the count rather than fail.
 */
export async function countSarifFindings(sarifPath: string): Promise<number | undefined> {
  const { readFile } = await import("node:fs/promises");
  try {
    const raw = await readFile(sarifPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const runs = (parsed as { runs?: unknown }).runs;
    if (!Array.isArray(runs)) return undefined;
    let total = 0;
    for (const run of runs) {
      const results = (run as { results?: unknown }).results;
      if (Array.isArray(results)) total += results.length;
    }
    return total;
  } catch {
    return undefined;
  }
}
