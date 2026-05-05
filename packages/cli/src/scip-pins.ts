/**
 * Pinned external SCIP adapter binaries.
 *
 * This is the single source of truth for every downloadable SCIP indexer we
 * ship via `codehub setup --scip=<tool>`. Each entry carries:
 *
 *   - `tool`:        the indexer family.
 *   - `version`:     upstream release tag (no `v` prefix).
 *   - `platforms[]`: per-platform download metadata. Each lists the target
 *                    `{os, arch}`, the direct release URL, the expected SHA256
 *                    digest, and (optionally) the binary's executable name on
 *                    disk.
 *
 * AC-M4-0 ships PLACEHOLDER SHA256 hashes (64 zeros) for the standalone
 * binaries. The real digests get computed and substituted when the
 * corresponding adapter (AC-M4-1..4) first runs its install smoke test against
 * the upstream release asset. The `placeholder: true` flag is the canonical
 * "do NOT trust this hash at runtime" marker — `installScipTool()` refuses to
 * run when the selected pin has `placeholder: true` unless the caller sets
 * `opts.allowPlaceholder` (reserved for adapter first-install smoke tests).
 *
 * `scip-dotnet` is the odd one out: upstream does NOT ship a self-contained
 * release binary, so its install path goes through
 * `dotnet tool install --global scip-dotnet`. Its entry therefore carries an
 * empty `platforms` array and a sentinel `installerKind: "dotnet-tool"`. The
 * downloader dispatches on that kind and skips the fetch/verify path entirely.
 */

/** Platform = `${os}-${arch}`. Matches what we read from `process.platform` + `process.arch`. */
export type ScipOs = "linux" | "darwin";
export type ScipArch = "x64" | "arm64";

/** The four binary-backed SCIP tools plus the .NET tool-sourced adapter. */
export type ScipTool = "clang" | "ruby" | "dotnet" | "kotlin";

/** Per-platform download descriptor. */
export interface ScipPlatformPin {
  readonly os: ScipOs;
  readonly arch: ScipArch;
  readonly url: string;
  /** Hex-encoded SHA256 (64 chars). PLACEHOLDER when `placeholder` is true. */
  readonly sha256: string;
  /**
   * Optional: name of the archive entry that contains the binary. When absent
   * the downloader treats the URL's payload as the binary itself.
   *
   * We currently download raw binaries (the Sourcegraph release artifacts are
   * standalone executables), so this stays undefined for now. Reserved for
   * future tools that publish tarballs or zips.
   */
  readonly archiveEntry?: string;
  /**
   * True when upstream does NOT publish a release asset for this `{os, arch}`
   * pair. The entry is retained so the pin documents the gap explicitly
   * (vs. silently omitting the row, which would leave callers guessing).
   * The downloader refuses to install against an unavailable platform and
   * surfaces a specific "upstream does not ship this platform" error. The
   * `sha256` and `url` stay for traceability but must never be fetched.
   */
  readonly platformUnavailable?: boolean;
}

/** Canonical pin shape shared by every tool. */
export interface ScipToolPin {
  readonly tool: ScipTool;
  readonly version: string;
  /** How the installer should source the binary. */
  readonly installerKind: "download" | "dotnet-tool";
  /**
   * True while the per-platform SHA256 digests are placeholders (all zeros).
   * Downloader refuses to verify against placeholder hashes unless the caller
   * opts in with `allowPlaceholder: true` (used by the first-install smoke
   * test in each adapter PR).
   */
  readonly placeholder: boolean;
  /**
   * Platforms covered by this tool. Empty for `installerKind === "dotnet-tool"`.
   */
  readonly platforms: readonly ScipPlatformPin[];
  /**
   * Name the binary is installed under inside `~/.codehub/bin/`. Usually
   * `scip-<tool>`. Set explicitly so each pin is self-describing.
   */
  readonly binName: string;
  /**
   * `dotnet tool install --global scip-dotnet` runtime requirement — minimum
   * .NET SDK major version (probed via `dotnet --version`). Only consulted
   * when `installerKind === "dotnet-tool"`.
   */
  readonly minDotnetMajor?: number;
}

/** PLACEHOLDER HASH — compute at implementation time. */
const PLACEHOLDER_SHA256 = "0".repeat(64);

/**
 * scip-clang v0.4.0 — Sourcegraph C/C++ indexer, released 2026-02-23.
 * Releases: `github.com/sourcegraph/scip-clang/releases/tag/v0.4.0`.
 *
 * Upstream ships release assets for exactly two `{arch, os}` pairs at
 * v0.4.0 (per `api.github.com/repos/sourcegraph/scip-clang/releases/tags/v0.4.0`):
 *
 *   - x86_64-linux   — scip-clang-x86_64-linux
 *   - arm64-darwin   — scip-clang-arm64-darwin
 *
 * The matching SCIP-CLANG README Supported Platforms section states plainly:
 * "Binary releases are available for x86_64 Linux (glibc 2.16 or newer) and
 * arm64 macOS." x86_64-darwin and aarch64-linux are NOT shipped; the two
 * unavailable rows stay in the pin marked `platformUnavailable: true` so the
 * gap is documented rather than silently omitted.
 */
const SCIP_CLANG_PIN: ScipToolPin = {
  tool: "clang",
  version: "0.4.0",
  installerKind: "download",
  placeholder: false,
  binName: "scip-clang",
  platforms: [
    {
      os: "linux",
      arch: "x64",
      url: "https://github.com/sourcegraph/scip-clang/releases/download/v0.4.0/scip-clang-x86_64-linux",
      // Verified 2026-05-05 via `curl -sL <url> | sha256sum` against the
      // upstream release asset (149 MB binary).
      sha256: "06fd18c576f979a726c651594644ec4a35db4f471f2160b3f72eb89fa6001784",
    },
    {
      os: "linux",
      arch: "arm64",
      url: "https://github.com/sourcegraph/scip-clang/releases/download/v0.4.0/scip-clang-aarch64-linux",
      // Upstream does NOT ship a linux-arm64 binary at v0.4.0 (asset URL 404s).
      sha256: PLACEHOLDER_SHA256,
      platformUnavailable: true,
    },
    {
      os: "darwin",
      arch: "x64",
      url: "https://github.com/sourcegraph/scip-clang/releases/download/v0.4.0/scip-clang-x86_64-darwin",
      // Upstream does NOT ship a darwin-x64 binary at v0.4.0 (asset URL 404s).
      sha256: PLACEHOLDER_SHA256,
      platformUnavailable: true,
    },
    {
      os: "darwin",
      arch: "arm64",
      url: "https://github.com/sourcegraph/scip-clang/releases/download/v0.4.0/scip-clang-arm64-darwin",
      // Verified 2026-05-05 via `curl -sL <url> | sha256sum` against the
      // upstream release asset (71 MB binary).
      sha256: "ff042fbc8a029f09f4b69fc7692e290e21c52923593207ee52d4e7439473ec64",
    },
  ],
};

/**
 * scip-ruby v0.4.7 — Sourcegraph Ruby indexer, released 2024-11-07.
 * Releases: `github.com/sourcegraph/scip-ruby/releases/tag/scip-ruby-v0.4.7`.
 */
const SCIP_RUBY_PIN: ScipToolPin = {
  tool: "ruby",
  version: "0.4.7",
  installerKind: "download",
  placeholder: true,
  binName: "scip-ruby",
  platforms: [
    {
      os: "linux",
      arch: "x64",
      url: "https://github.com/sourcegraph/scip-ruby/releases/download/scip-ruby-v0.4.7/scip-ruby-x86_64-linux",
      // PLACEHOLDER HASH — compute at implementation time
      sha256: PLACEHOLDER_SHA256,
    },
    {
      os: "linux",
      arch: "arm64",
      url: "https://github.com/sourcegraph/scip-ruby/releases/download/scip-ruby-v0.4.7/scip-ruby-aarch64-linux",
      // PLACEHOLDER HASH — compute at implementation time
      sha256: PLACEHOLDER_SHA256,
    },
    {
      os: "darwin",
      arch: "x64",
      url: "https://github.com/sourcegraph/scip-ruby/releases/download/scip-ruby-v0.4.7/scip-ruby-x86_64-darwin",
      // PLACEHOLDER HASH — compute at implementation time
      sha256: PLACEHOLDER_SHA256,
    },
    {
      os: "darwin",
      arch: "arm64",
      url: "https://github.com/sourcegraph/scip-ruby/releases/download/scip-ruby-v0.4.7/scip-ruby-aarch64-darwin",
      // PLACEHOLDER HASH — compute at implementation time
      sha256: PLACEHOLDER_SHA256,
    },
  ],
};

/**
 * scip-dotnet v0.2.12 — installed via `dotnet tool install --global scip-dotnet`.
 * Upstream does NOT ship a self-contained release binary; the installer needs
 * .NET SDK 8 or later on PATH.
 */
const SCIP_DOTNET_PIN: ScipToolPin = {
  tool: "dotnet",
  version: "0.2.12",
  installerKind: "dotnet-tool",
  placeholder: false,
  binName: "scip-dotnet",
  platforms: [],
  minDotnetMajor: 8,
};

/**
 * scip-kotlin v0.6.0 — released 2024-09-08.
 * Standalone binary under
 * `github.com/sourcegraph/scip-kotlin/releases/tag/v0.6.0`. Kotlin is a
 * promotion from "rides on scip-java" — v0.6.0 is the first release that is
 * distinct from scip-java and must be downloaded separately.
 *
 * Upstream publishes a single `scip-kotlin` JVM-based launcher (platform
 * independent but requires JRE 11+ on PATH). We still record per-platform
 * entries so the downloader's platform-detection path is uniform — each
 * platform just points at the same URL / SHA256.
 */
const SCIP_KOTLIN_PIN: ScipToolPin = {
  tool: "kotlin",
  version: "0.6.0",
  installerKind: "download",
  placeholder: true,
  binName: "scip-kotlin",
  platforms: [
    {
      os: "linux",
      arch: "x64",
      url: "https://github.com/sourcegraph/scip-kotlin/releases/download/v0.6.0/scip-kotlin",
      // PLACEHOLDER HASH — compute at implementation time
      sha256: PLACEHOLDER_SHA256,
    },
    {
      os: "linux",
      arch: "arm64",
      url: "https://github.com/sourcegraph/scip-kotlin/releases/download/v0.6.0/scip-kotlin",
      // PLACEHOLDER HASH — compute at implementation time
      sha256: PLACEHOLDER_SHA256,
    },
    {
      os: "darwin",
      arch: "x64",
      url: "https://github.com/sourcegraph/scip-kotlin/releases/download/v0.6.0/scip-kotlin",
      // PLACEHOLDER HASH — compute at implementation time
      sha256: PLACEHOLDER_SHA256,
    },
    {
      os: "darwin",
      arch: "arm64",
      url: "https://github.com/sourcegraph/scip-kotlin/releases/download/v0.6.0/scip-kotlin",
      // PLACEHOLDER HASH — compute at implementation time
      sha256: PLACEHOLDER_SHA256,
    },
  ],
};

/** Single source of truth. Keep insertion order stable for `--scip=all`. */
export const SCIP_PINS: Readonly<Record<ScipTool, ScipToolPin>> = {
  clang: SCIP_CLANG_PIN,
  ruby: SCIP_RUBY_PIN,
  dotnet: SCIP_DOTNET_PIN,
  kotlin: SCIP_KOTLIN_PIN,
};

/** Ordered list used by `--scip=all`. */
export const SCIP_TOOL_ORDER: readonly ScipTool[] = ["clang", "ruby", "dotnet", "kotlin"];

/** True when `value` is a known SCIP tool name. Used to validate CLI input. */
export function isScipTool(value: string): value is ScipTool {
  return value === "clang" || value === "ruby" || value === "dotnet" || value === "kotlin";
}
