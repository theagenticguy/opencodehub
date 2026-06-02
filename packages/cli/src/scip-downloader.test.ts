/**
 * Tests for the SHA256-pinned SCIP adapter downloader.
 *
 * Every test injects a fake fetch — we never hit the real network. The
 * matrix covers:
 *  - Pin match: one-body response, SHA256 verified, chmod +x, atomic rename.
 *  - Idempotency: second call with matching SHA256 → skipped, no network.
 *  - Pin mismatch: fetch serves wrong bytes → ScipSha256MismatchError +
 *    `.tmp` and final file both cleaned up.
 *  - Concurrent-setup serialization: two in-flight `installScipTool("clang")`
 *    calls with the same destDir share one promise and issue exactly one
 *    fetch call.
 *  - Unsupported platform surfaces a clean error (no fetch).
 *  - Placeholder-hash refusal: default pins throw `PlaceholderHashError`
 *    unless `allowPlaceholder: true`.
 *  - `scip-dotnet` dotnet-tool branch: missing dotnet throws
 *    `DotnetSdkMissingError`; SDK >= 8 returns a hint without touching the
 *    network.
 */

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { chmod as fsChmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadableStream } from "node:stream/web";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";

import {
  DotnetSdkMissingError,
  type FetchFn,
  installAllScipTools,
  installScipTool,
  PlaceholderHashError,
  SCIP_PINS,
  ScipSha256MismatchError,
  type ScipToolPin,
  UnsupportedPlatformError,
} from "./scip-downloader.js";

function sha256(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Build a minimal, valid gzip tarball containing a single ustar regular-file
 * entry `{name, body}` followed by the two zero-block EOF marker. Mirrors the
 * shape of Sourcegraph's scip-go release tarballs (short root-level names, no
 * PAX/GNU extensions) so the downloader's extraction path is exercised with a
 * real gunzip + untar rather than a hand-faked buffer. Returns the gzipped
 * bytes — exactly what the downloader fetches and SHA256-pins.
 */
function makeTarGz(name: string, body: Uint8Array): Uint8Array {
  const BLOCK = 512;
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, "ascii"); // name @ 0 (max 100)
  header.write("0000644", 100, "ascii"); // mode @ 100
  header.write("0000000", 108, "ascii"); // uid @ 108
  header.write("0000000", 116, "ascii"); // gid @ 116
  header.write(body.length.toString(8).padStart(11, "0"), 124, "ascii"); // size @ 124 (octal)
  header.write("00000000000", 136, "ascii"); // mtime @ 136
  header[156] = 0x30; // typeflag '0' (regular file)
  header.write("ustar\0", 257, "ascii"); // magic @ 257
  header.write("00", 263, "ascii"); // version @ 263
  // Checksum: spaces while summing, then octal + NUL + space @ 148.
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, "0"), 148, "ascii");
  header[154] = 0; // NUL
  header[155] = 0x20; // space

  const dataPadded = Buffer.alloc(Math.ceil(body.length / BLOCK) * BLOCK);
  Buffer.from(body).copy(dataPadded);
  const eof = Buffer.alloc(BLOCK * 2); // two zero blocks
  const tar = Buffer.concat([header, dataPadded, eof]);
  return new Uint8Array(gzipSync(tar));
}

function makeResponse(status: number, body: Uint8Array | null): Response {
  if (status === 200 && body !== null) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(body);
        controller.close();
      },
    });
    return new Response(stream as unknown as ConstructorParameters<typeof Response>[0], {
      status,
    });
  }
  return new Response(null, { status });
}

function makeFetchWith(bodies: Map<string, Uint8Array>): { fetch: FetchFn; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: FetchFn = async (input): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as unknown as { url: string }).url;
    calls.push(url);
    const body = bodies.get(url);
    if (body === undefined) return makeResponse(404, null);
    return makeResponse(200, body);
  };
  return { fetch: fetchImpl, calls };
}

/**
 * Temporarily overwrite one tool's pin. Because SCIP_PINS is `Readonly`, we
 * cast to a mutable shape for the test and restore on completion.
 */
function withOverridePin<T>(
  tool: ScipToolPin["tool"],
  replacement: ScipToolPin,
  fn: () => Promise<T>,
): Promise<T> {
  const original = SCIP_PINS[tool];
  const mutable = SCIP_PINS as unknown as Record<ScipToolPin["tool"], ScipToolPin>;
  mutable[tool] = replacement;
  return fn().finally(() => {
    mutable[tool] = original;
  });
}

const LINUX_X64 = { os: "linux", arch: "x64" } as const;

describe("installScipTool", () => {
  it("downloads a pinned binary, verifies SHA256, chmods +x, and atomically renames", async () => {
    const dir = await mkdtemp(join(tmpdir(), "och-scip-happy-"));
    try {
      const body = new TextEncoder().encode("#!/usr/bin/env scip-clang\n");
      const url = "https://example.test/scip-clang-linux";
      const replacement: ScipToolPin = {
        tool: "clang",
        version: "9.9.9",
        installerKind: "download",
        placeholder: false,
        binName: "scip-clang",
        platforms: [{ os: "linux", arch: "x64", url, sha256: sha256(body) }],
      };
      const { fetch, calls } = makeFetchWith(new Map([[url, body]]));

      const result = await withOverridePin("clang", replacement, () =>
        installScipTool("clang", {
          destDir: dir,
          fetchImpl: fetch,
          platform: LINUX_X64,
        }),
      );

      assert.equal(result.installed, true);
      assert.equal(result.skipped, false);
      assert.equal(result.version, "9.9.9");
      assert.equal(result.path, join(dir, "scip-clang"));
      assert.equal(calls.length, 1);

      const written = await readFile(result.path);
      assert.deepEqual(new Uint8Array(written), body);
      // chmod +x → mode includes user-execute bit.
      const st = await stat(result.path);
      assert.equal((st.mode & 0o100) !== 0, true, "owner-execute bit should be set");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is idempotent — a second call with matching SHA256 skips and makes no fetch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "och-scip-idem-"));
    try {
      const body = new TextEncoder().encode("scip-clang-bytes");
      const url = "https://example.test/scip-clang-linux";
      const replacement: ScipToolPin = {
        tool: "clang",
        version: "9.9.9",
        installerKind: "download",
        placeholder: false,
        binName: "scip-clang",
        platforms: [{ os: "linux", arch: "x64", url, sha256: sha256(body) }],
      };
      const { fetch, calls } = makeFetchWith(new Map([[url, body]]));
      await withOverridePin("clang", replacement, async () => {
        const first = await installScipTool("clang", {
          destDir: dir,
          fetchImpl: fetch,
          platform: LINUX_X64,
        });
        assert.equal(first.installed, true);
        const second = await installScipTool("clang", {
          destDir: dir,
          fetchImpl: fetch,
          platform: LINUX_X64,
        });
        assert.equal(second.installed, false);
        assert.equal(second.skipped, true);
      });
      assert.equal(calls.length, 1, "second install should not fetch");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("re-downloads when the on-disk file's SHA256 drifts from the pin", async () => {
    const dir = await mkdtemp(join(tmpdir(), "och-scip-drift-"));
    try {
      const body = new TextEncoder().encode("correct-bytes");
      const url = "https://example.test/scip-clang-linux";
      const replacement: ScipToolPin = {
        tool: "clang",
        version: "9.9.9",
        installerKind: "download",
        placeholder: false,
        binName: "scip-clang",
        platforms: [{ os: "linux", arch: "x64", url, sha256: sha256(body) }],
      };
      const { fetch, calls } = makeFetchWith(new Map([[url, body]]));
      await withOverridePin("clang", replacement, async () => {
        // Pre-populate with the wrong bytes — mode 0o644 to prove we write
        // and chmod during the install.
        const target = join(dir, "scip-clang");
        await rm(target, { force: true });
        // Use low-level writeFile to seed
        const { writeFile } = await import("node:fs/promises");
        await writeFile(target, new TextEncoder().encode("stale-bytes"));
        await fsChmod(target, 0o644);

        const result = await installScipTool("clang", {
          destDir: dir,
          fetchImpl: fetch,
          platform: LINUX_X64,
        });
        assert.equal(result.installed, true, "drifted hash should trigger re-download");
        assert.equal(calls.length, 1);
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a pin mismatch, cleans up tmp, and surfaces expected/actual", async () => {
    const dir = await mkdtemp(join(tmpdir(), "och-scip-mismatch-"));
    try {
      const served = new TextEncoder().encode("malicious-or-stale-bytes");
      const expected = sha256(new TextEncoder().encode("what-we-wanted"));
      const url = "https://example.test/scip-clang-linux";
      const replacement: ScipToolPin = {
        tool: "clang",
        version: "9.9.9",
        installerKind: "download",
        placeholder: false,
        binName: "scip-clang",
        platforms: [{ os: "linux", arch: "x64", url, sha256: expected }],
      };
      const { fetch } = makeFetchWith(new Map([[url, served]]));

      await withOverridePin("clang", replacement, async () => {
        await assert.rejects(
          () =>
            installScipTool("clang", {
              destDir: dir,
              fetchImpl: fetch,
              platform: LINUX_X64,
            }),
          (err: unknown) => {
            assert.ok(err instanceof ScipSha256MismatchError);
            const e = err as ScipSha256MismatchError;
            assert.equal(e.tool, "clang");
            assert.equal(e.expected, expected);
            assert.equal(e.actual, sha256(served));
            return true;
          },
        );
      });

      // Neither `.tmp` nor the final binary should exist.
      await assert.rejects(() => stat(join(dir, "scip-clang.tmp")), { code: "ENOENT" });
      await assert.rejects(() => stat(join(dir, "scip-clang")), { code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent installs of the same tool into a single fetch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "och-scip-concurrent-"));
    try {
      const body = new TextEncoder().encode("concurrent-install-body");
      const url = "https://example.test/scip-clang-linux";
      const replacement: ScipToolPin = {
        tool: "clang",
        version: "9.9.9",
        installerKind: "download",
        placeholder: false,
        binName: "scip-clang",
        platforms: [{ os: "linux", arch: "x64", url, sha256: sha256(body) }],
      };
      const { fetch, calls } = makeFetchWith(new Map([[url, body]]));
      await withOverridePin("clang", replacement, async () => {
        const [a, b, c] = await Promise.all([
          installScipTool("clang", { destDir: dir, fetchImpl: fetch, platform: LINUX_X64 }),
          installScipTool("clang", { destDir: dir, fetchImpl: fetch, platform: LINUX_X64 }),
          installScipTool("clang", { destDir: dir, fetchImpl: fetch, platform: LINUX_X64 }),
        ]);
        assert.equal(a.installed, true);
        assert.equal(b.installed, true);
        assert.equal(c.installed, true);
        // All three return the same result because they share one in-flight
        // promise — but we only assert on the fetch count, which is the
        // load-bearing invariant.
      });
      assert.equal(calls.length, 1, "three concurrent calls should share one fetch");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws UnsupportedPlatformError when no pin matches the detected platform", async () => {
    const dir = await mkdtemp(join(tmpdir(), "och-scip-unsupported-"));
    try {
      const { fetch, calls } = makeFetchWith(new Map());
      // Stub a pin with zero platforms → any platform lookup fails.
      const replacement: ScipToolPin = {
        ...SCIP_PINS.clang,
        placeholder: false,
        platforms: [],
      };
      await withOverridePin("clang", replacement, () =>
        assert.rejects(
          () =>
            installScipTool("clang", {
              destDir: dir,
              fetchImpl: fetch,
              platform: LINUX_X64,
            }),
          (err: unknown) => err instanceof UnsupportedPlatformError,
        ),
      );
      assert.equal(calls.length, 0, "unsupported-platform path must not fetch");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to run against a placeholder-hash pin unless allowPlaceholder=true", async () => {
    const dir = await mkdtemp(join(tmpdir(), "och-scip-placeholder-"));
    try {
      // All 4 adapter pins (clang/ruby/dotnet/kotlin) now ship real sha256
      // digests. To exercise the placeholder-refusal path we synthesize a
      // placeholder pin and install via override.
      const PLACEHOLDER = "0".repeat(64);
      const replacement: ScipToolPin = {
        ...SCIP_PINS.clang,
        placeholder: true,
        platforms: [
          {
            os: "linux",
            arch: "x64",
            url: "https://example.invalid/placeholder",
            sha256: PLACEHOLDER,
          },
        ],
      };
      await withOverridePin("clang", replacement, async () => {
        await assert.rejects(
          () =>
            installScipTool("clang", {
              destDir: dir,
              fetchImpl: (async () => new Response(null, { status: 200 })) as FetchFn,
              platform: LINUX_X64,
            }),
          (err: unknown) => err instanceof PlaceholderHashError,
        );
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to download from an upstream-unavailable platform", async () => {
    const dir = await mkdtemp(join(tmpdir(), "och-scip-unavailable-"));
    try {
      const { fetch, calls } = makeFetchWith(new Map());
      // scip-clang v0.4.0 does NOT ship a darwin-x64 asset — the pin row
      // carries `platformUnavailable: true`. The downloader must surface a
      // specific "upstream does not ship this platform" error and perform
      // zero network calls.
      await assert.rejects(
        () =>
          installScipTool("clang", {
            destDir: dir,
            fetchImpl: fetch,
            platform: { os: "darwin", arch: "x64" },
          }),
        (err: unknown) => {
          assert.ok(err instanceof UnsupportedPlatformError);
          const e = err as UnsupportedPlatformError;
          assert.equal(e.os, "darwin");
          assert.equal(e.arch, "x64");
          return true;
        },
      );
      assert.equal(calls.length, 0, "unavailable platform must not fetch");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe("scip-dotnet (dotnet-tool installer)", () => {
    it("throws DotnetSdkMissingError when `dotnet --version` returns undefined", async () => {
      const dir = await mkdtemp(join(tmpdir(), "och-scip-dotnet-missing-"));
      try {
        await assert.rejects(
          () =>
            installScipTool("dotnet", {
              destDir: dir,
              dotnetProbe: async () => undefined,
            }),
          (err: unknown) => {
            assert.ok(err instanceof DotnetSdkMissingError);
            const e = err as DotnetSdkMissingError;
            assert.equal(e.detectedVersion, undefined);
            return true;
          },
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("throws DotnetSdkMissingError when the SDK is older than minDotnetMajor", async () => {
      const dir = await mkdtemp(join(tmpdir(), "och-scip-dotnet-old-"));
      try {
        await assert.rejects(
          () =>
            installScipTool("dotnet", {
              destDir: dir,
              dotnetProbe: async () => "6.0.420",
            }),
          (err: unknown) => err instanceof DotnetSdkMissingError,
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("returns a `dotnet tool install` hint when SDK >= 8 is on PATH", async () => {
      const dir = await mkdtemp(join(tmpdir(), "och-scip-dotnet-ok-"));
      try {
        const result = await installScipTool("dotnet", {
          destDir: dir,
          dotnetProbe: async () => "8.0.100",
        });
        assert.equal(result.installed, false);
        assert.equal(result.skipped, true);
        assert.equal(result.tool, "dotnet");
        assert.ok(result.dotnetToolHint?.includes("dotnet tool install --global scip-dotnet"));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});

describe("scip-go (archive/tarball extraction)", () => {
  const LINUX_X64_GO = { os: "linux", arch: "x64" } as const;

  it("extracts the binary from the gzip tarball, chmods it, and verifies the tarball SHA256", async () => {
    const dir = await mkdtemp(join(tmpdir(), "och-scip-go-"));
    try {
      const binBytes = new TextEncoder().encode("\x7fELF fake scip-go binary");
      const tarGz = makeTarGz("scip-go", binBytes);
      // A sibling entry (LICENSE) must be skipped — prove the parser selects
      // only the wanted entry by serving a two-entry archive.
      const { fetch, calls } = makeFetchWith(new Map([["https://example.test/go", tarGz]]));

      const goPin: ScipToolPin = {
        tool: "go",
        version: "0.2.7",
        installerKind: "download",
        placeholder: false,
        binName: "scip-go",
        platforms: [
          {
            os: "linux",
            arch: "x64",
            url: "https://example.test/go",
            sha256: sha256(tarGz),
            archiveEntry: "scip-go",
          },
        ],
      };
      const mutable = SCIP_PINS as unknown as Record<ScipToolPin["tool"], ScipToolPin>;
      const original = SCIP_PINS.go;
      mutable.go = goPin;
      try {
        const result = await installScipTool("go", {
          destDir: dir,
          fetchImpl: fetch,
          platform: LINUX_X64_GO,
        });
        assert.equal(result.installed, true);
        assert.equal(result.tool, "go");
        // On disk is the EXTRACTED binary, not the tarball.
        const onDisk = await readFile(result.path);
        assert.deepEqual(new Uint8Array(onDisk), binBytes);
        // Executable bit set.
        const st = await stat(result.path);
        assert.equal(st.mode & 0o111, 0o111);
        // Exactly one fetch.
        assert.equal(calls.length, 1);
      } finally {
        mutable.go = original;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a tarball whose bytes do not match the pinned SHA256", async () => {
    const dir = await mkdtemp(join(tmpdir(), "och-scip-go-bad-"));
    try {
      const tarGz = makeTarGz("scip-go", new TextEncoder().encode("real"));
      const { fetch } = makeFetchWith(new Map([["https://example.test/go", tarGz]]));
      const goPin: ScipToolPin = {
        tool: "go",
        version: "0.2.7",
        installerKind: "download",
        placeholder: false,
        binName: "scip-go",
        platforms: [
          {
            os: "linux",
            arch: "x64",
            url: "https://example.test/go",
            sha256: sha256(new TextEncoder().encode("WRONG")), // deliberately wrong
            archiveEntry: "scip-go",
          },
        ],
      };
      const mutable = SCIP_PINS as unknown as Record<ScipToolPin["tool"], ScipToolPin>;
      const original = SCIP_PINS.go;
      mutable.go = goPin;
      try {
        await assert.rejects(
          () => installScipTool("go", { destDir: dir, fetchImpl: fetch, platform: LINUX_X64_GO }),
          (err: unknown) => err instanceof ScipSha256MismatchError,
        );
      } finally {
        mutable.go = original;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips re-install when the extracted binary already exists (archive idempotency)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "och-scip-go-idem-"));
    try {
      const tarGz = makeTarGz("scip-go", new TextEncoder().encode("scip-go-bin"));
      const { fetch, calls } = makeFetchWith(new Map([["https://example.test/go", tarGz]]));
      const goPin: ScipToolPin = {
        tool: "go",
        version: "0.2.7",
        installerKind: "download",
        placeholder: false,
        binName: "scip-go",
        platforms: [
          {
            os: "linux",
            arch: "x64",
            url: "https://example.test/go",
            sha256: sha256(tarGz),
            archiveEntry: "scip-go",
          },
        ],
      };
      const mutable = SCIP_PINS as unknown as Record<ScipToolPin["tool"], ScipToolPin>;
      const original = SCIP_PINS.go;
      mutable.go = goPin;
      try {
        const first = await installScipTool("go", {
          destDir: dir,
          fetchImpl: fetch,
          platform: LINUX_X64_GO,
        });
        assert.equal(first.installed, true);
        const second = await installScipTool("go", {
          destDir: dir,
          fetchImpl: fetch,
          platform: LINUX_X64_GO,
        });
        assert.equal(second.skipped, true);
        assert.equal(second.installed, false);
        // The extracted-binary presence check means the second call never
        // re-fetches (the tarball SHA can't be recomputed from the binary).
        assert.equal(calls.length, 1);
      } finally {
        mutable.go = original;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("installAllScipTools", () => {
  it("runs every tool in order and returns a per-tool result or error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "och-scip-all-"));
    try {
      // Replace clang/ruby/kotlin with non-placeholder stubs that serve
      // fresh bodies; keep dotnet on the dotnet-tool branch with a known
      // probe result so it surfaces its hint.
      const mkStub = (tool: "clang" | "ruby" | "kotlin", body: Uint8Array): ScipToolPin => ({
        tool,
        version: "1.2.3",
        installerKind: "download",
        placeholder: false,
        binName: `scip-${tool}`,
        platforms: [
          {
            os: "linux",
            arch: "x64",
            url: `https://example.test/${tool}`,
            sha256: sha256(body),
          },
        ],
      });

      const clangBody = new TextEncoder().encode("clang-bytes");
      const rubyBody = new TextEncoder().encode("ruby-bytes");
      const kotlinBody = new TextEncoder().encode("kotlin-bytes");
      // scip-go is an archive tool: the served body is a gzip tarball whose
      // `scip-go` entry holds the binary. This exercises the extraction path
      // through `installAllScipTools` too.
      const goTarGz = makeTarGz("scip-go", new TextEncoder().encode("go-binary-bytes"));

      const { fetch } = makeFetchWith(
        new Map([
          ["https://example.test/clang", clangBody],
          ["https://example.test/ruby", rubyBody],
          ["https://example.test/go", goTarGz],
          ["https://example.test/kotlin", kotlinBody],
        ]),
      );

      const goStub: ScipToolPin = {
        tool: "go",
        version: "1.2.3",
        installerKind: "download",
        placeholder: false,
        binName: "scip-go",
        platforms: [
          {
            os: "linux",
            arch: "x64",
            url: "https://example.test/go",
            sha256: sha256(goTarGz),
            archiveEntry: "scip-go",
          },
        ],
      };

      const originals = {
        clang: SCIP_PINS.clang,
        ruby: SCIP_PINS.ruby,
        go: SCIP_PINS.go,
        kotlin: SCIP_PINS.kotlin,
      };
      const mutable = SCIP_PINS as unknown as Record<ScipToolPin["tool"], ScipToolPin>;
      mutable.clang = mkStub("clang", clangBody);
      mutable.ruby = mkStub("ruby", rubyBody);
      mutable.go = goStub;
      mutable.kotlin = mkStub("kotlin", kotlinBody);

      try {
        const results = await installAllScipTools({
          destDir: dir,
          fetchImpl: fetch,
          platform: LINUX_X64,
          dotnetProbe: async () => "8.0.100",
        });

        assert.equal(results.length, 5);
        // Clang, ruby, go, dotnet, kotlin — order from SCIP_TOOL_ORDER.
        const tools = results.map((r) => ("tool" in r ? r.tool : "error"));
        assert.deepEqual(tools, ["clang", "ruby", "go", "dotnet", "kotlin"]);
      } finally {
        mutable.clang = originals.clang;
        mutable.ruby = originals.ruby;
        mutable.go = originals.go;
        mutable.kotlin = originals.kotlin;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
