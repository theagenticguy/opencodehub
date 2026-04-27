/**
 * Unit tests for `codehub init`
 *
 * Covers:
 *   1. Fresh repo → copies skills/agents/commands/hooks into `.claude/`,
 *      rewrites `hooks.json` to project-scope `.claude/settings.json`,
 *      writes `.mcp.json`, appends `.codehub/` to `.gitignore`, seeds policy.
 *   2. Re-running without `--force` against an existing `.claude/` refuses
 *      and names the conflicts.
 *   3. Re-running with `--force` is idempotent (byte-identical outputs).
 *   4. `--skip-mcp` and `--skip-policy` flags honored.
 *   5. Hook-token rewrite: `${CLAUDE_PLUGIN_ROOT}` becomes
 *      `${CLAUDE_PROJECT_DIR}/.claude`.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInit } from "./init.js";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
// Tests run against dist/, so plugin-assets is a sibling dir.
const BUNDLED_ASSETS = resolve(HERE, "..", "plugin-assets");

async function mkRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), "codehub-init-"));
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

test("runInit: fresh repo wires up .claude/, .mcp.json, .gitignore, policy", async () => {
  const repo = await mkRepo();
  const home = await mkdtemp(join(tmpdir(), "codehub-init-home-"));

  const result = await runInit({
    repo,
    sourceDir: BUNDLED_ASSETS,
    home,
    log: () => {},
    warn: () => {},
  });

  assert.equal(result.repoRoot, resolve(repo));
  assert.ok(result.filesCopied > 0, "should copy at least one plugin asset");
  assert.ok(result.hooksWrittenTo !== null, "should wire project-scope hooks");
  assert.ok(result.mcpResult !== null, "should emit .mcp.json");
  assert.equal(result.mcpResult?.editor, "claude-code");
  assert.ok(result.gitignoreUpdated, "fresh repo should get .codehub/ appended");
  assert.ok(result.policySeeded, "fresh repo should get opencodehub.policy.yaml seeded");

  // Skills made it into project-scope .claude/skills/
  for (const skill of [
    "codehub-document",
    "codehub-pr-description",
    "codehub-onboarding",
    "codehub-contract-map",
    "opencodehub-guide",
  ]) {
    const skillFile = join(repo, ".claude", "skills", skill, "SKILL.md");
    assert.ok(await pathExists(skillFile), `missing: ${skillFile}`);
  }

  // Agents, commands, hooks.
  assert.ok(await pathExists(join(repo, ".claude", "agents", "doc-architecture.md")));
  assert.ok(await pathExists(join(repo, ".claude", "agents", "code-analyst.md")));
  assert.ok(await pathExists(join(repo, ".claude", "hooks", "augment.sh")));
  assert.ok(await pathExists(join(repo, ".claude", "hooks", "docs-staleness.sh")));

  // Commands from the existing pre-artifact plugin (probe, verdict, etc.).
  assert.ok(await pathExists(join(repo, ".claude", "commands", "probe.md")));

  // settings.json with project-scope-rewritten hooks.
  const settings = await readFile(join(repo, ".claude", "settings.json"), "utf8");
  const parsedSettings = JSON.parse(settings) as Record<string, unknown>;
  assert.ok(parsedSettings["hooks"] !== undefined, "settings.json must have hooks key");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting literal absence
  assert.ok(!settings.includes("${CLAUDE_PLUGIN_ROOT}"), "CLAUDE_PLUGIN_ROOT must be rewritten");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting literal presence
  assert.ok(settings.includes("${CLAUDE_PROJECT_DIR}/.claude"), "must reference project-scope path");

  // .mcp.json has a codehub entry.
  const mcp = JSON.parse(await readFile(join(repo, ".mcp.json"), "utf8")) as {
    mcpServers?: Record<string, unknown>;
  };
  assert.ok(mcp.mcpServers?.["codehub"] !== undefined, ".mcp.json missing codehub entry");

  // .gitignore has .codehub/
  const gitignore = await readFile(join(repo, ".gitignore"), "utf8");
  assert.ok(gitignore.includes(".codehub/"), ".gitignore missing .codehub/");

  // Policy file exists and is fully commented out.
  const policy = await readFile(join(repo, "opencodehub.policy.yaml"), "utf8");
  assert.ok(policy.startsWith("# OpenCodeHub policy"), "policy starter banner missing");
  assert.ok(
    policy.split("\n").every((line) => line.length === 0 || line.startsWith("#")),
    "policy starter must be fully commented out",
  );
});

test("runInit: re-running without --force refuses and lists conflicts", async () => {
  const repo = await mkRepo();
  const home = await mkdtemp(join(tmpdir(), "codehub-init-home-"));
  await runInit({ repo, sourceDir: BUNDLED_ASSETS, home, log: () => {}, warn: () => {} });

  await assert.rejects(
    runInit({ repo, sourceDir: BUNDLED_ASSETS, home, log: () => {}, warn: () => {} }),
    /refusing to overwrite/,
  );
});

test("runInit: re-running with --force is idempotent (byte-identical)", async () => {
  const repo = await mkRepo();
  const home = await mkdtemp(join(tmpdir(), "codehub-init-home-"));
  await runInit({ repo, sourceDir: BUNDLED_ASSETS, home, log: () => {}, warn: () => {} });

  const settingsBefore = await readFile(join(repo, ".claude", "settings.json"), "utf8");
  const mcpBefore = await readFile(join(repo, ".mcp.json"), "utf8");
  const gitignoreBefore = await readFile(join(repo, ".gitignore"), "utf8");
  const policyBefore = await readFile(join(repo, "opencodehub.policy.yaml"), "utf8");

  await runInit({
    repo,
    sourceDir: BUNDLED_ASSETS,
    home,
    force: true,
    log: () => {},
    warn: () => {},
  });

  assert.equal(
    await readFile(join(repo, ".claude", "settings.json"), "utf8"),
    settingsBefore,
    "settings.json must be byte-identical on idempotent re-run",
  );
  assert.equal(
    await readFile(join(repo, ".mcp.json"), "utf8"),
    mcpBefore,
    ".mcp.json must be byte-identical on idempotent re-run",
  );
  assert.equal(
    await readFile(join(repo, ".gitignore"), "utf8"),
    gitignoreBefore,
    ".gitignore must be byte-identical on idempotent re-run",
  );
  assert.equal(
    await readFile(join(repo, "opencodehub.policy.yaml"), "utf8"),
    policyBefore,
    "policy must be byte-identical on idempotent re-run (existing file → no overwrite)",
  );
});

test("runInit: --skip-mcp skips .mcp.json write", async () => {
  const repo = await mkRepo();
  const home = await mkdtemp(join(tmpdir(), "codehub-init-home-"));
  const result = await runInit({
    repo,
    sourceDir: BUNDLED_ASSETS,
    home,
    skipMcp: true,
    log: () => {},
    warn: () => {},
  });
  assert.equal(result.mcpResult, null);
  assert.equal(await pathExists(join(repo, ".mcp.json")), false);
});

test("runInit: --skip-policy skips opencodehub.policy.yaml seeding", async () => {
  const repo = await mkRepo();
  const home = await mkdtemp(join(tmpdir(), "codehub-init-home-"));
  const result = await runInit({
    repo,
    sourceDir: BUNDLED_ASSETS,
    home,
    skipPolicy: true,
    log: () => {},
    warn: () => {},
  });
  assert.equal(result.policySeeded, false);
  assert.equal(await pathExists(join(repo, "opencodehub.policy.yaml")), false);
});
