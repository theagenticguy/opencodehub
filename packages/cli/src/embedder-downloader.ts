/**
 * SHA256-pinned downloader for Arctic Embed XS weights.
 *
 * Resolves the target directory via {@link resolveModelDir}, then for each
 * pinned file in {@link ARCTIC_EMBED_XS_PINS}:
 *   1. Skip when the file already exists and its SHA256 matches the pin.
 *   2. Otherwise stream-download to `<target>.tmp`, hash during write, verify
 *      hash, and atomically rename to the final path.
 *
 * Retries transient network errors (ECONNRESET / timeout / 5xx) up to 3 times
 * with exponential backoff (100ms, 500ms, 2s). A SHA256 mismatch is a hard
 * error — the `.tmp` file is deleted and the error thrown. We never ship
 * weights that don't match the pin.
 *
 * All disk access is streaming; we never buffer a 90 MB file in memory.
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { setTimeout as delay } from "node:timers/promises";

import { ARCTIC_EMBED_XS_PINS, type PinnedFile, resolveModelDir } from "@opencodehub/embedder";

/** Fetch function signature for dependency injection (tests mock this). */
export type FetchFn = typeof fetch;

/** Options accepted by {@link downloadEmbedderWeights}. */
export interface DownloadEmbedderOptions {
  /** Which variant to install. Defaults to `fp32`. */
  readonly variant: "fp32" | "int8";
  /** Override target directory. Defaults to the standard model path. */
  readonly modelDir?: string;
  /**
   * Re-download every file even if the existing copy's SHA256 matches. Used
   * by `--force`. When false, files that already match the pin are skipped.
   */
  readonly force?: boolean;
  /**
   * Called before each file starts downloading. `pct` is a whole-suite
   * percentage (0-100) and `file` is the base name of the current file.
   */
  readonly onProgress?: (pct: number, file: string) => void;
  /**
   * Fetch implementation. Tests inject a stub; production uses global `fetch`.
   */
  readonly fetchImpl?: FetchFn;
  /**
   * Max retry attempts for a single file. Default 3. Must be >= 1.
   */
  readonly maxRetries?: number;
  /**
   * Retry backoff ladder in ms. Used positionally by retry index. Default
   * `[100, 500, 2000]` per the v1.0 spec.
   */
  readonly backoffMs?: readonly number[];
}

/** Summary returned by {@link downloadEmbedderWeights}. */
export interface DownloadEmbedderResult {
  readonly downloaded: number;
  readonly skipped: number;
  readonly totalBytes: number;
  readonly modelDir: string;
}

const DEFAULT_BACKOFF_MS: readonly number[] = [100, 500, 2000];
const DEFAULT_MAX_RETRIES = 3;

/**
 * Thrown when a downloaded file's SHA256 doesn't match the pinned value.
 *
 * The temp file is deleted before this throws so partial corrupt payloads
 * never linger on disk.
 */
export class Sha256MismatchError extends Error {
  readonly code = "EMBEDDER_SHA256_MISMATCH" as const;
  readonly fileName: string;
  readonly expected: string;
  readonly actual: string;

  constructor(fileName: string, expected: string, actual: string) {
    super(`SHA256 mismatch for ${fileName}: expected ${expected}, got ${actual}`);
    this.name = "Sha256MismatchError";
    this.fileName = fileName;
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Thrown for all non-hash download failures (404, network, etc.). Carries the
 * URL in the message so operators can reproduce with curl.
 */
export class DownloadError extends Error {
  readonly code = "EMBEDDER_DOWNLOAD_FAILED" as const;
  readonly url: string;

  constructor(url: string, message: string, options?: ErrorOptions) {
    super(`Download failed for ${url}: ${message}`, options);
    this.name = "DownloadError";
    this.url = url;
  }
}

/**
 * Hash an existing file on disk in streaming fashion.
 *
 * Returns `undefined` if the file does not exist — callers use that as the
 * "not yet downloaded" signal rather than a dedicated stat() probe.
 */
async function hashFileIfExists(path: string): Promise<string | undefined> {
  try {
    await stat(path);
  } catch {
    return undefined;
  }
  const hasher = createHash("sha256");
  const rs = createReadStream(path);
  await streamPipeline(
    rs,
    new Writable({
      write(chunk: Buffer, _enc, cb): void {
        // Convert Buffer → Uint8Array view so strict TS typings accept it.
        hasher.update(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        cb();
      },
    }),
  );
  return hasher.digest("hex");
}

/**
 * Decide whether a network error is retryable. We treat `ECONNRESET`,
 * `ETIMEDOUT`, `EAI_AGAIN`, `ECONNREFUSED`, generic `AbortError` on timeout,
 * and 5xx HTTP responses as transient. SHA mismatch and 4xx are permanent.
 */
function isRetryableError(err: unknown): boolean {
  if (err instanceof Sha256MismatchError) return false;
  if (!(err instanceof Error)) return false;

  const transientCodes = new Set([
    "ECONNRESET",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ECONNREFUSED",
    "ENETUNREACH",
    "UND_ERR_SOCKET",
  ]);

  // Walk the error + its .cause chain; the network-layer code lives on the
  // underlying cause when we've wrapped the error as a DownloadError.
  let cur: unknown = err;
  let hops = 0;
  while (cur instanceof Error && hops < 8) {
    const codeCandidate = (cur as { code?: unknown }).code;
    if (typeof codeCandidate === "string" && transientCodes.has(codeCandidate)) {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
    hops += 1;
  }
  // DownloadError with a 5xx status is retryable; the message encodes the code.
  if (err instanceof DownloadError && /HTTP 5\d\d/.test(err.message)) {
    return true;
  }
  return false;
}

/**
 * Stream one pinned file to disk. Hash-as-we-write, verify, and atomic rename.
 * Does NOT retry — that's the caller's job via {@link withRetry}.
 */
async function downloadOne(
  pin: PinnedFile,
  targetPath: string,
  fetchImpl: FetchFn,
): Promise<number> {
  const tmpPath = `${targetPath}.tmp`;
  // Best-effort cleanup of any stale tmp from a previous failed run.
  try {
    await unlink(tmpPath);
  } catch {
    // Doesn't exist — fine.
  }

  let res: Response;
  try {
    res = await fetchImpl(pin.url, { redirect: "follow" });
  } catch (err) {
    throw new DownloadError(
      pin.url,
      err instanceof Error ? err.message : String(err),
      err instanceof Error ? { cause: err } : undefined,
    );
  }
  if (!res.ok) {
    throw new DownloadError(pin.url, `HTTP ${res.status} ${res.statusText}`);
  }
  if (res.body === null) {
    throw new DownloadError(pin.url, "response body is null");
  }

  const hasher = createHash("sha256");
  let bytesWritten = 0;
  const writeStream = createWriteStream(tmpPath);
  // Web ReadableStream → Node Readable bridge. `fetch` returns a Web stream
  // in all Node releases we support (>=20). We assert through the Node
  // stream/web type because `fetch`'s global typings reference lib.dom which
  // we deliberately exclude from this package.
  const bodyAsNode = Readable.fromWeb(res.body as unknown as NodeReadableStream<Uint8Array>);

  try {
    await streamPipeline(
      bodyAsNode,
      new Writable({
        write(chunk: Buffer, _enc, cb): void {
          const view = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          hasher.update(view);
          bytesWritten += chunk.byteLength;
          if (!writeStream.write(chunk)) {
            writeStream.once("drain", () => cb());
          } else {
            cb();
          }
        },
        final(cb): void {
          writeStream.end(() => cb());
        },
      }),
    );
  } catch (err) {
    // Clean up partial tmp before bubbling — no corrupt files on disk.
    try {
      await unlink(tmpPath);
    } catch {
      // Nothing to do.
    }
    throw new DownloadError(
      pin.url,
      err instanceof Error ? err.message : String(err),
      err instanceof Error ? { cause: err } : undefined,
    );
  }

  const actual = hasher.digest("hex");
  if (actual !== pin.sha256) {
    try {
      await unlink(tmpPath);
    } catch {
      // Nothing to do.
    }
    throw new Sha256MismatchError(pin.name, pin.sha256, actual);
  }

  await rename(tmpPath, targetPath);
  return bytesWritten;
}

/**
 * Run `task` with exponential backoff. The error type determines whether a
 * retry is attempted; non-transient errors bubble immediately.
 */
async function withRetry<T>(
  task: () => Promise<T>,
  maxRetries: number,
  backoffMs: readonly number[],
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await task();
    } catch (err) {
      lastErr = err;
      if (!isRetryableError(err) || attempt === maxRetries - 1) {
        throw err;
      }
      const waitMs = backoffMs[attempt] ?? backoffMs[backoffMs.length - 1] ?? 0;
      if (waitMs > 0) {
        await delay(waitMs);
      }
    }
  }
  // Unreachable — the loop always either returns or throws.
  throw lastErr as Error;
}

/**
 * Download every pinned file for the requested variant, skipping files whose
 * on-disk SHA256 already matches the pin (unless `force` is set).
 *
 * Returns `{downloaded, skipped, totalBytes}` where `totalBytes` counts the
 * newly-downloaded bytes only (skipped files are not re-hashed into the
 * total).
 */
export async function downloadEmbedderWeights(
  opts: DownloadEmbedderOptions,
): Promise<DownloadEmbedderResult> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchFn);
  if (typeof fetchImpl !== "function") {
    throw new Error(
      "Global fetch is not available. Node >= 18 required; supply opts.fetchImpl otherwise.",
    );
  }
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const modelDir = resolveModelDir(opts.modelDir, opts.variant);
  await mkdir(modelDir, { recursive: true });

  const files = ARCTIC_EMBED_XS_PINS[opts.variant].files;
  let downloaded = 0;
  let skipped = 0;
  let totalBytes = 0;

  for (let i = 0; i < files.length; i++) {
    const pin = files[i] as PinnedFile;
    const target = join(modelDir, pin.name);
    const pct = Math.round((i / files.length) * 100);
    opts.onProgress?.(pct, pin.name);

    if (!opts.force) {
      const existing = await hashFileIfExists(target);
      if (existing === pin.sha256) {
        skipped += 1;
        continue;
      }
    }

    // Ensure parent dir exists (target itself lives directly under modelDir
    // so this is mostly belt-and-suspenders for unusual overrides).
    await mkdir(dirname(target), { recursive: true });

    const bytes = await withRetry(() => downloadOne(pin, target, fetchImpl), maxRetries, backoffMs);
    downloaded += 1;
    totalBytes += bytes;
  }

  opts.onProgress?.(100, "done");
  return { downloaded, skipped, totalBytes, modelDir };
}
