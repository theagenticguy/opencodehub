/**
 * Unit tests for `codehub ci-init` — Stream M.
 *
 * Covers:
 *   1. Fresh repo + `--platform github` → writes 4 workflow files.
 *   2. Existing workflow + no `--force` → refuses, error names the conflicts.
 *   3. Every emitted workflow parses as valid YAML.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { runCiInit } from "./ci-init.js";

async function mkRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), "codehub-ci-init-"));
}

test("runCiInit: fresh repo + --platform github writes 4 workflow files", async () => {
  const repo = await mkRepo();
  try {
    await runCiInit({ repo, platform: "github", mainBranch: "main" });

    const wfDir = join(repo, ".github", "workflows");
    const names = [
      "opencodehub-verdict.yml",
      "opencodehub-nightly.yml",
      "opencodehub-weekly.yml",
      "opencodehub-rescan.yml",
    ];
    for (const name of names) {
      const body = await readFile(join(wfDir, name), "utf8");
      assert.ok(body.length > 0, `${name} should be non-empty`);
      // Variable substitution happened — templates must not leak raw placeholders.
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting literal absence
      assert.ok(!body.includes("${MAIN_BRANCH}"), `${name}: MAIN_BRANCH unsubstituted`);
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting literal absence
      assert.ok(!body.includes("${REPO_NAME}"), `${name}: REPO_NAME unsubstituted`);
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("runCiInit: existing workflow without --force refuses and lists conflicts", async () => {
  const repo = await mkRepo();
  try {
    const wfDir = join(repo, ".github", "workflows");
    await mkdir(wfDir, { recursive: true });
    const conflict = join(wfDir, "opencodehub-verdict.yml");
    await writeFile(conflict, "name: pre-existing\non: [push]\n", "utf8");

    await assert.rejects(
      () => runCiInit({ repo, platform: "github", mainBranch: "main" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /refusing to overwrite/);
        assert.match(err.message, /opencodehub-verdict\.yml/);
        assert.match(err.message, /--force/);
        return true;
      },
    );

    // Pre-existing file must not have been clobbered.
    const stillThere = await readFile(conflict, "utf8");
    assert.match(stillThere, /pre-existing/);

    // --force overwrites.
    await runCiInit({ repo, platform: "github", mainBranch: "main", force: true });
    const afterForce = await readFile(conflict, "utf8");
    assert.ok(!afterForce.includes("pre-existing"));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("runCiInit: every emitted workflow parses as valid YAML (platform=both)", async () => {
  const repo = await mkRepo();
  try {
    await runCiInit({ repo, platform: "both", mainBranch: "trunk" });

    const paths = [
      join(repo, ".github", "workflows", "opencodehub-verdict.yml"),
      join(repo, ".github", "workflows", "opencodehub-nightly.yml"),
      join(repo, ".github", "workflows", "opencodehub-weekly.yml"),
      join(repo, ".github", "workflows", "opencodehub-rescan.yml"),
      join(repo, ".gitlab-ci.yml"),
    ];

    for (const p of paths) {
      const body = await readFile(p, "utf8");
      const parsed = parseYaml(body) as unknown;
      assert.ok(parsed !== null && typeof parsed === "object", `${p} should parse to an object`);
    }

    // Idempotence: second run with --force produces byte-identical output.
    const before = await readFile(paths[0] as string, "utf8");
    await runCiInit({ repo, platform: "both", mainBranch: "trunk", force: true });
    const after = await readFile(paths[0] as string, "utf8");
    assert.equal(before, after);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
