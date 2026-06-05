/**
 * Unit tests for `codehub init`
 *
 * Covers:
 *   1. Fresh repo → copies skills/agents/hooks into `.claude/`,
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
import { statSync } from "node:fs";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInit } from "./init.js";

// The shipped CLI bundles plugin assets into `dist/plugin-assets/` (tsup
// onSuccess). The test runner, however, compiles to `dist-test/` (tsup does
// not emit *.test.ts), where no assets are staged — so resolve the canonical
// source tree `plugins/opencodehub/` by walking up from this module. That is
// the source of truth the copy step itself reads from, so the wiring assertions
// validate the real asset shape regardless of which build emitted the test.
function resolvePluginSource(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, "plugins", "opencodehub");
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`init.test: could not locate plugins/opencodehub from ${import.meta.url}`);
}

const BUNDLED_ASSETS = resolvePluginSource();

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

  // Agents and hooks.
  assert.ok(await pathExists(join(repo, ".claude", "agents", "code-analyst.md")));
  assert.ok(await pathExists(join(repo, ".claude", "hooks", "augment.sh")));
  assert.ok(await pathExists(join(repo, ".claude", "hooks", "docs-staleness.sh")));

  // settings.json with project-scope-rewritten hooks.
  const settings = await readFile(join(repo, ".claude", "settings.json"), "utf8");
  const parsedSettings = JSON.parse(settings) as Record<string, unknown>;
  assert.ok(parsedSettings["hooks"] !== undefined, "settings.json must have hooks key");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting literal absence
  assert.ok(!settings.includes("${CLAUDE_PLUGIN_ROOT}"), "CLAUDE_PLUGIN_ROOT must be rewritten");
  assert.ok(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting literal presence
    settings.includes("${CLAUDE_PROJECT_DIR}/.claude"),
    "must reference project-scope path",
  );

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
