import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ReadableStream } from "node:stream/web";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as TOML from "@iarna/toml";
import type { EditorId } from "../editors/types.js";
import { detectPlatform, type FetchFn as ScipFetchFn } from "../scip-downloader.js";
import {
  type FsApi,
  parseScipFlag,
  runSetup,
  runSetupPlugin,
  runSetupScip,
  type SetupResult,
} from "./setup.js";

/**
 * In-memory `FsApi` used by every test in this file. Tracks which paths were
 * written to, whether a `.bak` was produced, and whether the merged content
 * differs from the prior content.
 */
function createMemoryFs(seed: Record<string, string> = {}): FsApi & {
  files: Map<string, string>;
  mkdirs: Set<string>;
  reads: string[];
  writes: Map<string, string>;
  copies: Map<string, string>;
} {
  const files = new Map<string, string>(Object.entries(seed));
  const mkdirs = new Set<string>();
  const reads: string[] = [];
  const writes = new Map<string, string>();
  const copies = new Map<string, string>();
  const api: FsApi = {
    async readFile(path) {
      reads.push(path);
      const f = files.get(path);
      if (f === undefined) {
        const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return f;
    },
    async writeFileAtomic(path, contents) {
      files.set(path, contents);
      writes.set(path, contents);
    },
    async copyFile(src, dest) {
      const existing = files.get(src);
      if (existing === undefined) {
        const err = new Error(`ENOENT: ${src}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      files.set(dest, existing);
      copies.set(dest, src);
    },
    async mkdir(path) {
      mkdirs.add(path);
    },
    async exists(path) {
      return files.has(path);
    },
  };
  return Object.assign(api, { files, mkdirs, reads, writes, copies });
}

function findResult(results: readonly SetupResult[], editor: EditorId): SetupResult {
  const hit = results.find((r) => r.editor === editor);
  if (!hit) throw new Error(`no result for editor ${editor}`);
  return hit;
}

const PROJECT_ROOT = "/tmp/project";
const HOME = "/tmp/home";

test("setup writes Claude Code .mcp.json with mcpServers.codehub", async () => {
  const fs = createMemoryFs();
  const results = await runSetup({
    editors: ["claude-code"],
    projectRoot: PROJECT_ROOT,
    home: HOME,
    fs,
    log: () => undefined,
    warn: () => undefined,
  });

  const result = findResult(results, "claude-code");
  assert.equal(result.action, "wrote");
  assert.equal(result.configPath, resolve(PROJECT_ROOT, ".mcp.json"));
  const written = fs.files.get(result.configPath);
  assert.ok(written, "config file must be written");
  const parsed = JSON.parse(written);
  assert.ok(parsed.mcpServers?.codehub, "mcpServers.codehub must be present");
  assert.equal(parsed.mcpServers.codehub.command, "codehub");
  assert.deepEqual(parsed.mcpServers.codehub.args, ["mcp"]);
});

test("setup writes Cursor mcp.json at ~/.cursor/mcp.json", async () => {
  const fs = createMemoryFs();
  const results = await runSetup({
    editors: ["cursor"],
    projectRoot: PROJECT_ROOT,
    home: HOME,
    fs,
    log: () => undefined,
    warn: () => undefined,
  });
  const result = findResult(results, "cursor");
  assert.equal(result.configPath, resolve(HOME, ".cursor", "mcp.json"));
  const written = fs.files.get(result.configPath);
  assert.ok(written);
  const parsed = JSON.parse(written);
  assert.ok(parsed.mcpServers?.codehub);
});

test("setup writes Windsurf mcp_config.json at ~/.codeium/windsurf/", async () => {
  const fs = createMemoryFs();
  const results = await runSetup({
    editors: ["windsurf"],
    projectRoot: PROJECT_ROOT,
    home: HOME,
    fs,
    log: () => undefined,
    warn: () => undefined,
  });
  const result = findResult(results, "windsurf");
  assert.equal(result.configPath, resolve(HOME, ".codeium", "windsurf", "mcp_config.json"));
  const parsed = JSON.parse(fs.files.get(result.configPath) ?? "{}");
  assert.ok(parsed.mcpServers?.codehub);
});

test("setup writes Codex config.toml with [mcp_servers.codehub]", async () => {
  const fs = createMemoryFs();
  const results = await runSetup({
    editors: ["codex"],
    projectRoot: PROJECT_ROOT,
    home: HOME,
    fs,
    log: () => undefined,
    warn: () => undefined,
  });
  const result = findResult(results, "codex");
  assert.equal(result.configPath, resolve(HOME, ".codex", "config.toml"));
  const raw = fs.files.get(result.configPath);
  assert.ok(raw);
  assert.match(raw, /\[mcp_servers\.codehub\]/);
  const parsed = TOML.parse(raw) as Record<string, unknown>;
  const servers = parsed["mcp_servers"] as Record<string, unknown>;
  const codehub = servers["codehub"] as Record<string, unknown>;
  assert.equal(codehub["command"], "codehub");
  assert.deepEqual(codehub["args"], ["mcp"]);
});

test("setup writes OpenCode opencode.json with top-level mcp.codehub.type=local", async () => {
  const fs = createMemoryFs();
  const results = await runSetup({
    editors: ["opencode"],
    projectRoot: PROJECT_ROOT,
    home: HOME,
    fs,
    log: () => undefined,
    warn: () => undefined,
  });
  const result = findResult(results, "opencode");
  assert.equal(result.configPath, resolve(PROJECT_ROOT, "opencode.json"));
  const parsed = JSON.parse(fs.files.get(result.configPath) ?? "{}");
  assert.ok(parsed.mcp?.codehub, "mcp.codehub must be present");
  assert.equal(parsed.mcp.codehub.type, "local");
  assert.ok(Array.isArray(parsed.mcp.codehub.command), "command must be an array");
  assert.deepEqual(parsed.mcp.codehub.command, ["codehub", "mcp"]);
  assert.equal(parsed.mcp.codehub.enabled, true);
  assert.equal(typeof parsed.mcp.codehub.timeout, "number");
});

test("setup preserves existing mcpServers entries on Claude Code", async () => {
  const existingPath = resolve(PROJECT_ROOT, ".mcp.json");
  const fs = createMemoryFs({
    [existingPath]: JSON.stringify(
      {
        mcpServers: {
          otherServer: { command: "other", args: ["--flag"] },
        },
      },
      null,
      2,
    ),
  });
  const results = await runSetup({
    editors: ["claude-code"],
    projectRoot: PROJECT_ROOT,
    home: HOME,
    fs,
    log: () => undefined,
    warn: () => undefined,
  });
  const result = findResult(results, "claude-code");
  assert.equal(result.action, "wrote");
  const parsed = JSON.parse(fs.files.get(existingPath) ?? "{}");
  assert.ok(parsed.mcpServers.otherServer, "other server must remain");
  assert.ok(parsed.mcpServers.codehub, "codehub must be added");
});

test("setup preserves existing mcp entries on OpenCode", async () => {
  const existingPath = resolve(PROJECT_ROOT, "opencode.json");
  const fs = createMemoryFs({
    [existingPath]: JSON.stringify(
      { mcp: { otherServer: { type: "local", command: ["other"] } } },
      null,
      2,
    ),
  });
  const results = await runSetup({
    editors: ["opencode"],
    projectRoot: PROJECT_ROOT,
    home: HOME,
    fs,
    log: () => undefined,
    warn: () => undefined,
  });
  const result = findResult(results, "opencode");
  assert.equal(result.action, "wrote");
  const parsed = JSON.parse(fs.files.get(existingPath) ?? "{}");
  assert.ok(parsed.mcp.otherServer);
  assert.ok(parsed.mcp.codehub);
});

test("setup writes a .bak before overwriting an existing config", async () => {
  const existingPath = resolve(PROJECT_ROOT, ".mcp.json");
  const fs = createMemoryFs({
    [existingPath]: JSON.stringify({ mcpServers: {} }),
  });
  await runSetup({
    editors: ["claude-code"],
    projectRoot: PROJECT_ROOT,
    home: HOME,
    fs,
    log: () => undefined,
    warn: () => undefined,
  });
  const backup = `${existingPath}.bak`;
  assert.ok(fs.files.has(backup), "backup file must exist");
  assert.equal(fs.copies.get(backup), existingPath);
});

test("setup on Windows wraps npx commands with cmd /c", async () => {
  const fs = createMemoryFs();
  const results = await runSetup({
    editors: ["claude-code"],
    projectRoot: PROJECT_ROOT,
    home: HOME,
    fs,
    platform: "win32",
    invocation: { command: "npx", args: ["codehub", "mcp"], env: {} },
    log: () => undefined,
    warn: () => undefined,
  });
  const result = findResult(results, "claude-code");
  const parsed = JSON.parse(fs.files.get(result.configPath) ?? "{}");
  assert.equal(parsed.mcpServers.codehub.command, "cmd");
  assert.deepEqual(parsed.mcpServers.codehub.args, ["/c", "npx", "codehub", "mcp"]);
});

test("setup on Windows does NOT wrap direct node commands", async () => {
  const fs = createMemoryFs();
  const results = await runSetup({
    editors: ["claude-code"],
    projectRoot: PROJECT_ROOT,
    home: HOME,
    fs,
    platform: "win32",
    invocation: { command: "node", args: ["/abs/cli.js", "mcp"], env: {} },
    log: () => undefined,
    warn: () => undefined,
  });
  const result = findResult(results, "claude-code");
  const parsed = JSON.parse(fs.files.get(result.configPath) ?? "{}");
  assert.equal(parsed.mcpServers.codehub.command, "node");
});

test("setup --undo restores from .bak", async () => {
  const existingPath = resolve(PROJECT_ROOT, ".mcp.json");
  const originalContent = JSON.stringify({ mcpServers: { legacy: { command: "legacy" } } });
  const bak = `${existingPath}.bak`;
  const fs = createMemoryFs({
    [existingPath]: '{"mcpServers":{"codehub":{"command":"codehub","args":["mcp"]}}}',
    [bak]: originalContent,
  });
  const results = await runSetup({
    editors: ["claude-code"],
    projectRoot: PROJECT_ROOT,
    home: HOME,
    fs,
    undo: true,
    log: () => undefined,
    warn: () => undefined,
  });
  const result = findResult(results, "claude-code");
  assert.equal(result.action, "restored");
  assert.equal(fs.files.get(existingPath), originalContent);
});

test("setup --plugin copies plugin tree into ~/.claude/plugins/opencodehub", async () => {
  // Locate the real in-repo plugin source. setup.test.ts lives at
  // packages/cli/dist/commands/ when compiled; go up 4 dirs to the repo root.
  const thisFile = fileURLToPath(import.meta.url);
  const repoRoot = resolve(dirname(thisFile), "..", "..", "..", "..");
  const sourceDir = join(repoRoot, "plugins", "opencodehub");

  // Sanity: bail out loudly if the plugin source has been moved/renamed so
  // the test doesn't silently pass against a missing target.
  const srcStat = await stat(sourceDir);
  assert.ok(srcStat.isDirectory(), `expected plugin source at ${sourceDir}`);

  const home = await mkdtemp(join(tmpdir(), "codehub-plugin-"));
  const result = await runSetupPlugin({
    home,
    sourceDir,
    log: () => undefined,
    warn: () => undefined,
  });

  const targetDir = join(home, ".claude", "plugins", "opencodehub");
  assert.equal(result.targetDir, targetDir);
  assert.ok(result.filesCopied >= 8, `expected >= 8 files, got ${result.filesCopied}`);

  // Manifest + README.
  const manifestPath = join(targetDir, ".claude-plugin", "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.name, "opencodehub");
  assert.equal(manifest.version, "0.1.0");
  assert.ok((await stat(join(targetDir, "README.md"))).isFile());

  // The one agent. Read once and infer existence from a successful
  // `readFile` instead of `stat` + `readFile` (closes the TOCTOU gap
  // js/file-system-race flags on path-based checks).
  const agentPath = join(targetDir, "agents", "code-analyst.md");
  const agentBody = await readFile(agentPath, "utf8");
  assert.ok(agentBody.length > 0, "missing code-analyst agent");
  assert.match(agentBody, /name: code-analyst/);

  // PostToolUse hook.
  const hooksPath = join(targetDir, "hooks.json");
  const hooks = JSON.parse(await readFile(hooksPath, "utf8"));
  assert.ok(Array.isArray(hooks.hooks?.PostToolUse), "hooks.PostToolUse must be an array");
  assert.equal(hooks.hooks.PostToolUse[0].matcher, "Bash");
});

test("setup writes all 5 editors at their expected config paths", async () => {
  const fs = createMemoryFs();
  const results = await runSetup({
    projectRoot: PROJECT_ROOT,
    home: HOME,
    fs,
    log: () => undefined,
    warn: () => undefined,
  });
  assert.equal(results.length, 5);
  const paths = results.map((r) => r.configPath).sort();
  assert.deepEqual(
    paths,
    [
      resolve(PROJECT_ROOT, ".mcp.json"),
      resolve(PROJECT_ROOT, "opencode.json"),
      resolve(HOME, ".codeium", "windsurf", "mcp_config.json"),
      resolve(HOME, ".codex", "config.toml"),
      resolve(HOME, ".cursor", "mcp.json"),
    ].sort(),
  );
  for (const r of results) {
    assert.equal(r.action, "wrote");
    assert.ok(fs.files.has(r.configPath));
  }
});

test("parseScipFlag accepts tool names and 'all'", () => {
  assert.equal(parseScipFlag("clang"), "clang");
  assert.equal(parseScipFlag("ruby"), "ruby");
  assert.equal(parseScipFlag("dotnet"), "dotnet");
  assert.equal(parseScipFlag("kotlin"), "kotlin");
  assert.equal(parseScipFlag("all"), "all");
  // Whitespace tolerance.
  assert.equal(parseScipFlag("  clang  "), "clang");
});

test("parseScipFlag rejects unknown values with a clear error", () => {
  assert.throws(() => parseScipFlag("rust"), /Unknown --scip value: "rust"/);
  assert.throws(() => parseScipFlag(""), /Unknown --scip value: ""/);
});

test("runSetupScip routes --scip=dotnet to the dotnet-tool hint path", async () => {
  const logs: string[] = [];
  const warns: string[] = [];
  const dir = await mkdtemp(join(tmpdir(), "och-scip-setup-"));
  try {
    // No fetch should fire because dotnet is the tool-install branch.
    const result = await runSetupScip({
      tool: "dotnet",
      destDir: dir,
      fetchImpl: (async () => {
        throw new Error("fetch should not be called for dotnet-tool installer");
      }) as ScipFetchFn,
      log: (m) => logs.push(m),
      warn: (m) => warns.push(m),
    });
    // In this test environment `dotnet` is likely absent — we accept either
    // outcome (installed hint OR failed DotnetSdkMissingError) and only
    // assert structural invariants.
    assert.equal(result.installed.length + result.failed.length, 1);
    if (result.installed.length === 1) {
      const r = result.installed[0];
      assert.ok(r !== undefined);
      assert.equal(r.tool, "dotnet");
      assert.ok(r.dotnetToolHint?.includes("dotnet tool install"));
    } else {
      const f = result.failed[0];
      assert.ok(f !== undefined);
      assert.equal(f.tool, "dotnet");
      assert.ok(/DOTNET|SDK|dotnet/i.test(f.error.message));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runSetupScip installs a single tool via injected fetch + allowPlaceholder", async () => {
  const dir = await mkdtemp(join(tmpdir(), "och-scip-setup-one-"));
  try {
    const body = new TextEncoder().encode("fake-scip-clang");
    const expected = createHash("sha256").update(body).digest("hex");
    // Override the pin in-place so the downloader verifies against the
    // injected hash rather than the placeholder.
    const pinsModule = await import("../scip-pins.js");
    type Pin = (typeof pinsModule.SCIP_PINS)["clang"];
    const mutable = pinsModule.SCIP_PINS as unknown as { clang: Pin };
    const original: Pin = mutable.clang;
    // Pin the platform entry to the ACTUAL host (detectPlatform reads
    // process.platform/arch) so the downloader finds a match wherever the
    // test runs — linux-x64 in CI, darwin-arm64 on a dev Mac. Hard-coding
    // linux-x64 made this test silently install nothing (0 tools) on macOS.
    const host = detectPlatform();
    mutable.clang = {
      tool: original.tool,
      version: original.version,
      installerKind: original.installerKind,
      binName: original.binName,
      placeholder: false,
      platforms: [
        { os: host.os, arch: host.arch, url: "https://example.test/clang", sha256: expected },
      ],
    };
    try {
      const fetchImpl: ScipFetchFn = async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(body);
            c.close();
          },
        });
        return new Response(stream as unknown as ConstructorParameters<typeof Response>[0], {
          status: 200,
        });
      };
      const logs: string[] = [];
      const result = await runSetupScip({
        tool: "clang",
        destDir: dir,
        fetchImpl,
        log: (m) => logs.push(m),
        warn: () => undefined,
      });
      assert.equal(result.installed.length, 1);
      assert.equal(result.failed.length, 0);
      assert.equal(result.installed[0]?.tool, "clang");
      // Binary landed at destDir/scip-clang with x bit.
      const st = await stat(join(dir, "scip-clang"));
      assert.equal((st.mode & 0o100) !== 0, true);
    } finally {
      mutable.clang = original;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
