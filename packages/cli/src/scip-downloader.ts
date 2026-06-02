/**
 * SHA256-pinned downloader for external SCIP adapter binaries.
 *
 * Mirrors the shape of `embedder-downloader.ts` but is scoped per-tool rather
 * than per-variant. Each call installs one tool into `~/.codehub/bin/`:
 *
 *   1. Detect the running platform (`process.platform` + `process.arch`).
 *      Unsupported combinations throw a clear "unsupported platform" error.
 *   2. Resolve the per-platform pin from `SCIP_PINS`.
 *   3. If the target path already exists and its SHA256 matches the pin, skip.
 *   4. Otherwise stream-download to `<target>.tmp`, hash during write, verify,
 *      `chmod +x`, and atomic-rename into place.
 *
 * `scip-dotnet` is a special case: upstream does NOT ship a self-contained
 * binary — it is installed via `dotnet tool install --global scip-dotnet` and
 * needs .NET SDK 8+. The downloader probes `dotnet --version` first; if the
 * SDK is missing or too old, it surfaces the specific install hint instead of
 * attempting a binary download.
 *
 * Concurrency: concurrent calls for the same tool on the same process are
 * serialized via an in-memory promise map keyed by `(tool, destDir)`. This
 * avoids two parallel `installScipTool("clang")` invocations each writing the
 * same `<target>.tmp` and corrupting each other's output. Cross-process
 * concurrent setup is out of scope — the atomic-rename still means no half-
 * written binary ever appears at the final path.
 *
 * Placeholder SHA256 handling: some pins ship with all-zero placeholder
 * hashes in `scip-pins.ts`. We refuse to verify against placeholder hashes
 * at runtime. Each adapter's first-install smoke test passes
 * `allowPlaceholder: true` so it can compute the real hash and substitute
 * it back into the pin file.
 */

import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

import {
  SCIP_PINS,
  SCIP_TOOL_ORDER,
  type ScipArch,
  type ScipOs,
  type ScipPlatformPin,
  type ScipTool,
  type ScipToolPin,
} from "./scip-pins.js";

export type { ScipTool, ScipToolPin } from "./scip-pins.js";
export { isScipTool, SCIP_PINS, SCIP_TOOL_ORDER } from "./scip-pins.js";

const execFile = promisify(execFileCb);

/** Fetch function signature for dependency injection (tests mock this). */
export type FetchFn = typeof fetch;

/** Probe callback for `dotnet --version`. Tests inject a stub. */
export type DotnetProbe = () => Promise<string | undefined>;

/** Platform discriminator consumed by pin lookup. */
export interface DetectedPlatform {
  readonly os: ScipOs;
  readonly arch: ScipArch;
}

/** Options for {@link installScipTool}. */
export interface InstallScipOptions {
  /** Re-download even if the on-disk binary's SHA256 already matches. */
  readonly force?: boolean;
  /** Override the install dir. Defaults to `~/.codehub/bin/`. */
  readonly destDir?: string;
  /** Dependency-inject fetch (tests). */
  readonly fetchImpl?: FetchFn;
  /**
   * Allow installation against a pin that still carries placeholder SHA256
   * digests. Only the adapter first-install smoke tests should set this —
   * normal users must get a hard error instead of a silent install against a
   * zeroed-out hash.
   */
  readonly allowPlaceholder?: boolean;
  /** Override platform detection (tests). */
  readonly platform?: DetectedPlatform;
  /** Override `dotnet --version` probe (tests). */
  readonly dotnetProbe?: DotnetProbe;
  /** Structured logger. Defaults to a silent sink. */
  readonly log?: (message: string) => void;
}

/** Result returned by {@link installScipTool}. */
export interface InstallScipResult {
  readonly tool: ScipTool;
  readonly installed: boolean;
  readonly skipped: boolean;
  readonly version: string;
  /** Absolute path on disk. For `dotnet-tool` installs this is a hint string. */
  readonly path: string;
  /** Set when `installerKind === "dotnet-tool"`. */
  readonly dotnetToolHint?: string;
}

/**
 * Thrown when a downloaded file's SHA256 doesn't match the pinned value.
 * The temp file is deleted before this throws so partial payloads never
 * linger on disk.
 */
export class ScipSha256MismatchError extends Error {
  readonly code = "SCIP_SHA256_MISMATCH" as const;
  readonly tool: ScipTool;
  readonly expected: string;
  readonly actual: string;

  constructor(tool: ScipTool, expected: string, actual: string) {
    super(`SHA256 mismatch for scip-${tool}: expected ${expected}, got ${actual}`);
    this.name = "ScipSha256MismatchError";
    this.tool = tool;
    this.expected = expected;
    this.actual = actual;
  }
}

/** Thrown for all non-hash download failures (404, network, etc.). */
export class ScipDownloadError extends Error {
  readonly code = "SCIP_DOWNLOAD_FAILED" as const;
  readonly url: string;

  constructor(url: string, message: string, options?: ErrorOptions) {
    super(`Download failed for ${url}: ${message}`, options);
    this.name = "ScipDownloadError";
    this.url = url;
  }
}

/** Thrown when the current platform is not covered by a pin. */
export class UnsupportedPlatformError extends Error {
  readonly code = "SCIP_UNSUPPORTED_PLATFORM" as const;
  readonly os: string;
  readonly arch: string;

  constructor(os: string, arch: string, toolHint?: string) {
    super(
      `Unsupported platform for ${toolHint ?? "scip tool"}: ${os}-${arch}. ` +
        `Supported: linux-x64, linux-arm64, darwin-x64, darwin-arm64.`,
    );
    this.name = "UnsupportedPlatformError";
    this.os = os;
    this.arch = arch;
  }
}

/** Thrown when a pin still has placeholder SHA256 digests. */
export class PlaceholderHashError extends Error {
  readonly code = "SCIP_PLACEHOLDER_HASH" as const;
  readonly tool: ScipTool;

  constructor(tool: ScipTool) {
    super(
      `scip-${tool} pin still carries placeholder SHA256 digests. ` +
        `The real hash is computed at adapter first-install time. ` +
        `Pass allowPlaceholder: true from a smoke test, or wait for the adapter to land.`,
    );
    this.name = "PlaceholderHashError";
    this.tool = tool;
  }
}

/** Thrown when `scip-dotnet` requires `dotnet` SDK >= N and it is missing or older. */
export class DotnetSdkMissingError extends Error {
  readonly code = "SCIP_DOTNET_SDK_MISSING" as const;
  readonly minMajor: number;
  readonly detectedVersion: string | undefined;

  constructor(minMajor: number, detectedVersion: string | undefined) {
    const detected =
      detectedVersion === undefined
        ? "dotnet is not on PATH"
        : `detected dotnet --version: ${detectedVersion}`;
    super(
      `scip-dotnet requires .NET SDK ${minMajor}.0+ on PATH (${detected}). ` +
        `Install from https://dotnet.microsoft.com/download, then retry ` +
        `\`codehub setup --scip=dotnet\` (which runs ` +
        `\`dotnet tool install --global scip-dotnet\`).`,
    );
    this.name = "DotnetSdkMissingError";
    this.minMajor = minMajor;
    this.detectedVersion = detectedVersion;
  }
}

/**
 * Detect the running platform. Normalizes `process.arch` values into the
 * `x64` / `arm64` discriminator the pin file uses.
 */
export function detectPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): DetectedPlatform {
  let normalizedArch: ScipArch;
  if (arch === "x64") {
    normalizedArch = "x64";
  } else if (arch === "arm64") {
    normalizedArch = "arm64";
  } else {
    throw new UnsupportedPlatformError(platform, arch);
  }

  if (platform === "linux") {
    return { os: "linux", arch: normalizedArch };
  }
  if (platform === "darwin") {
    return { os: "darwin", arch: normalizedArch };
  }
  throw new UnsupportedPlatformError(platform, arch);
}

/** Resolve the default install dir: `~/.codehub/bin`. */
export function defaultScipBinDir(home: string = homedir()): string {
  return join(home, ".codehub", "bin");
}

/**
 * Default `dotnet --version` probe. Returns the version string on success or
 * undefined when the binary isn't on PATH / fails to execute.
 */
const defaultDotnetProbe: DotnetProbe = async () => {
  try {
    const { stdout } = await execFile("dotnet", ["--version"], { timeout: 5000 });
    return stdout.trim();
  } catch {
    return undefined;
  }
};

/** Parse `dotnet --version` output and extract the major version number. */
function parseDotnetMajor(version: string | undefined): number | undefined {
  if (version === undefined) return undefined;
  const match = version.match(/^(\d+)\./);
  if (match === null) return undefined;
  const parsed = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Lookup the platform-specific pin for a tool. Throws on unsupported combos. */
function resolvePlatformPin(pin: ScipToolPin, platform: DetectedPlatform): ScipPlatformPin {
  const hit = pin.platforms.find((p) => p.os === platform.os && p.arch === platform.arch);
  if (hit === undefined) {
    throw new UnsupportedPlatformError(platform.os, platform.arch, `scip-${pin.tool}`);
  }
  if (hit.platformUnavailable === true) {
    throw new UnsupportedPlatformError(
      platform.os,
      platform.arch,
      `scip-${pin.tool} v${pin.version} (upstream does not ship a release asset for this platform)`,
    );
  }
  return hit;
}

/**
 * Hash an existing file in streaming fashion. Returns `undefined` if the file
 * does not exist — callers use that as the "not yet downloaded" signal.
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
        hasher.update(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        cb();
      },
    }),
  );
  return hasher.digest("hex");
}

/**
 * Stat a file, returning `undefined` if it does not exist. Used by the
 * archive-tool idempotency check (an extracted binary's hash can't be compared
 * to the tarball pin, so presence + non-empty size is the signal).
 */
async function statIfExists(path: string): Promise<{ size: number } | undefined> {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

/**
 * Stream one binary to disk: hash-as-we-write, verify, chmod +x, atomic
 * rename. Does NOT retry — the embedder downloader's retry ladder is
 * overkill for a single-binary install; a failed download surfaces directly.
 */
async function downloadBinary(
  tool: ScipTool,
  platformPin: ScipPlatformPin,
  targetPath: string,
  fetchImpl: FetchFn,
): Promise<number> {
  const tmpPath = `${targetPath}.tmp`;
  try {
    await unlink(tmpPath);
  } catch {
    // Doesn't exist — fine.
  }

  let res: Response;
  try {
    res = await fetchImpl(platformPin.url, { redirect: "follow" });
  } catch (err) {
    throw new ScipDownloadError(
      platformPin.url,
      err instanceof Error ? err.message : String(err),
      err instanceof Error ? { cause: err } : undefined,
    );
  }
  if (!res.ok) {
    throw new ScipDownloadError(platformPin.url, `HTTP ${res.status} ${res.statusText}`);
  }
  if (res.body === null) {
    throw new ScipDownloadError(platformPin.url, "response body is null");
  }

  const hasher = createHash("sha256");
  let bytesWritten = 0;
  const writeStream = createWriteStream(tmpPath);
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
    try {
      await unlink(tmpPath);
    } catch {
      // Nothing to do.
    }
    throw new ScipDownloadError(
      platformPin.url,
      err instanceof Error ? err.message : String(err),
      err instanceof Error ? { cause: err } : undefined,
    );
  }

  const actual = hasher.digest("hex");
  if (actual !== platformPin.sha256) {
    try {
      await unlink(tmpPath);
    } catch {
      // Nothing to do.
    }
    throw new ScipSha256MismatchError(tool, platformPin.sha256, actual);
  }

  // Archive path: the verified `tmpPath` holds a `.tar.gz` whose single
  // wanted entry (`archiveEntry`) is the executable. The SHA256 above already
  // covered the archive bytes, so integrity is intact; we now gunzip + untar
  // in-memory (release tarballs are a few MB) and replace `tmpPath` with the
  // extracted binary before the chmod + atomic rename.
  if (platformPin.archiveEntry !== undefined) {
    const extractedBytes = await extractFromTarGz(
      tmpPath,
      platformPin.archiveEntry,
      platformPin.url,
    );
    bytesWritten = extractedBytes;
  }

  // 0o755 — owner rwx, everyone rx. Matches what a release tarball extraction
  // would produce.
  await chmod(tmpPath, 0o755);
  await rename(tmpPath, targetPath);
  return bytesWritten;
}

/**
 * Gunzip + untar `archivePath` in place, extract the single entry named
 * `entryName`, and overwrite `archivePath` with the extracted bytes (so the
 * caller's existing chmod + atomic-rename of `archivePath` lands the binary).
 * Returns the extracted byte count.
 *
 * Scope: release tarballs from Sourcegraph (scip-go) are plain ustar with
 * short root-level names and no PAX/GNU long-name extensions, so this is a
 * deliberately minimal reader — not a general-purpose tar library. It does,
 * however, honor the ustar `prefix` field, reject reads past the buffer, and
 * skip non-matching entries (e.g. the sibling `LICENSE`).
 */
async function extractFromTarGz(
  archivePath: string,
  entryName: string,
  sourceUrl: string,
): Promise<number> {
  const gz = await readFile(archivePath);
  let tar: Buffer;
  try {
    tar = gunzipSync(gz);
  } catch (err) {
    throw new ScipDownloadError(
      sourceUrl,
      `gunzip failed: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? { cause: err } : undefined,
    );
  }

  const BLOCK = 512;
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    // Two consecutive all-zero blocks mark end-of-archive; a single zero
    // header (name byte 0) is the terminator in practice — stop scanning.
    if (header[0] === 0) break;

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const fullName = prefix.length > 0 ? `${prefix}/${name}` : name;
    const size = readTarOctal(header, 124, 12);
    const typeFlag = header[156];

    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) {
      throw new ScipDownloadError(
        sourceUrl,
        `corrupt tar: entry "${fullName}" claims ${size} bytes past end of archive`,
      );
    }

    // typeFlag '0' or NUL (0) is a regular file; anything else (dir '5',
    // symlink '2', GNU long-name 'L', …) is not the binary we want.
    const isRegularFile = typeFlag === 0x30 /* '0' */ || typeFlag === 0;
    if (isRegularFile && fullName === entryName) {
      await writeFile(archivePath, tar.subarray(dataStart, dataEnd));
      return size;
    }

    // Advance past this entry's data, rounded up to the next 512 boundary.
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }

  throw new ScipDownloadError(sourceUrl, `tar archive did not contain entry "${entryName}"`);
}

/** Read a NUL-terminated ASCII string from a fixed-width tar header field. */
function readTarString(header: Buffer, start: number, len: number): string {
  const slice = header.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return slice.toString("ascii", 0, nul === -1 ? len : nul).trim();
}

/**
 * Parse a tar numeric field: NUL/space-terminated OCTAL ASCII. Returns 0 for
 * an empty/whitespace field (the size of dir/marker entries).
 */
function readTarOctal(header: Buffer, start: number, len: number): number {
  const raw = header.subarray(start, start + len).toString("ascii");
  const cleaned = raw.replace(/\0/g, "").trim();
  if (cleaned === "") return 0;
  const parsed = Number.parseInt(cleaned, 8);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * In-memory guard against concurrent installs of the same tool in the same
 * process. Keyed by `${tool}:${destDir}` so parallel tests with distinct
 * temp dirs don't serialize against each other.
 */
const inFlight = new Map<string, Promise<InstallScipResult>>();

/**
 * Install one SCIP tool. Returns immediately with `skipped: true` when the
 * on-disk binary already matches the pin; downloads otherwise.
 */
export async function installScipTool(
  tool: ScipTool,
  opts: InstallScipOptions = {},
): Promise<InstallScipResult> {
  const destDir = opts.destDir ?? defaultScipBinDir();
  const key = `${tool}:${destDir}`;
  const existing = inFlight.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const task = installScipToolInner(tool, destDir, opts).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, task);
  return task;
}

async function installScipToolInner(
  tool: ScipTool,
  destDir: string,
  opts: InstallScipOptions,
): Promise<InstallScipResult> {
  const pin = SCIP_PINS[tool];
  const log = opts.log ?? ((): void => undefined);

  if (pin.installerKind === "dotnet-tool") {
    const probe = opts.dotnetProbe ?? defaultDotnetProbe;
    const version = await probe();
    const major = parseDotnetMajor(version);
    const minMajor = pin.minDotnetMajor ?? 8;
    if (major === undefined || major < minMajor) {
      throw new DotnetSdkMissingError(minMajor, version);
    }
    // We do NOT actually run `dotnet tool install` here — that is a
    // side-effectful system install the user should run explicitly. We
    // return the hint string so the setup command can print it.
    const hint = `dotnet tool install --global scip-${tool}`;
    log(`codehub setup --scip=${tool}: SDK ${major} detected; run \`${hint}\` to install`);
    return {
      tool,
      installed: false,
      skipped: true,
      version: pin.version,
      path: hint,
      dotnetToolHint: hint,
    };
  }

  if (pin.placeholder && opts.allowPlaceholder !== true) {
    throw new PlaceholderHashError(tool);
  }

  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchFn);
  if (typeof fetchImpl !== "function") {
    throw new Error(
      "Global fetch is not available. Node >= 18 required; supply opts.fetchImpl otherwise.",
    );
  }

  const platform = opts.platform ?? detectPlatform();
  const platformPin = resolvePlatformPin(pin, platform);
  const targetPath = join(destDir, pin.binName);

  await mkdir(dirname(targetPath), { recursive: true });

  if (opts.force !== true) {
    // Idempotency check. For raw-binary tools the on-disk file IS the hashed
    // payload, so we compare its SHA256 to the pin. For archive tools the pin
    // hashes the `.tar.gz` but the on-disk file is the EXTRACTED binary — the
    // two hashes can never match, so we fall back to a presence check (a
    // non-empty file at the target means a prior install already extracted it).
    // Re-downloading is the only way to re-verify an archive tool's integrity,
    // which `--force` still does.
    if (platformPin.archiveEntry !== undefined) {
      const existing = await statIfExists(targetPath);
      if (existing !== undefined && existing.size > 0) {
        log(
          `codehub setup --scip=${tool}: already installed at ${targetPath} (version ${pin.version})`,
        );
        return { tool, installed: false, skipped: true, version: pin.version, path: targetPath };
      }
    } else {
      const existingHash = await hashFileIfExists(targetPath);
      if (existingHash !== undefined && existingHash === platformPin.sha256) {
        log(
          `codehub setup --scip=${tool}: already installed at ${targetPath} (version ${pin.version})`,
        );
        return { tool, installed: false, skipped: true, version: pin.version, path: targetPath };
      }
    }
  }

  log(`codehub setup --scip=${tool}: downloading ${platformPin.url}`);
  const bytes = await downloadBinary(tool, platformPin, targetPath, fetchImpl);
  log(`codehub setup --scip=${tool}: installed ${bytes} bytes → ${targetPath}`);
  return {
    tool,
    installed: true,
    skipped: false,
    version: pin.version,
    path: targetPath,
  };
}

/**
 * Install every known SCIP tool in declaration order. Collects successes and
 * failures without short-circuiting — `scip-dotnet` missing `dotnet` on PATH
 * must not prevent the clang/ruby/kotlin installs from running. Returns the
 * per-tool result array; caller decides how to surface errors.
 */
export async function installAllScipTools(
  opts: InstallScipOptions = {},
): Promise<readonly (InstallScipResult | { tool: ScipTool; error: Error })[]> {
  const results: (InstallScipResult | { tool: ScipTool; error: Error })[] = [];
  for (const tool of SCIP_TOOL_ORDER) {
    try {
      results.push(await installScipTool(tool, opts));
    } catch (err) {
      results.push({ tool, error: err instanceof Error ? err : new Error(String(err)) });
    }
  }
  return results;
}
