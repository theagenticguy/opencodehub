import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as TOML from "@iarna/toml";
import type { EditorId } from "../editors/types.js";
import { type FsApi, runSetup, runSetupPlugin, type SetupResult } from "./setup.js";

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

  // All 5 slash commands.
  for (const cmd of ["probe", "verdict", "owners", "audit-deps", "rename"]) {
    const p = join(targetDir, "commands", `${cmd}.md`);
    assert.ok((await stat(p)).isFile(), `missing command: ${cmd}`);
  }

  // The one agent.
  const agentPath = join(targetDir, "agents", "code-analyst.md");
  assert.ok((await stat(agentPath)).isFile(), "missing code-analyst agent");
  const agentBody = await readFile(agentPath, "utf8");
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
