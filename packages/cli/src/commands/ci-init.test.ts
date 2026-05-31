/**
 * Unit tests for `codehub ci-init`
 *
 * Covers:
 *   1. Fresh repo + `--platform github` → writes 4 workflow files.
 *   2. Existing workflow + no `--force` → refuses, error names the conflicts.
 *   3. Every emitted workflow parses as valid YAML.
 *   4. Every `codehub <cmd> ...` line in the emitted workflows only uses
 *      flags that the CLI actually declares (template/CLI drift guard).
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

/**
 * Long-option flags declared per `codehub` subcommand in `src/index.ts`.
 * Kept in lock-step with the command wiring there — this is the source of
 * truth the templates must not drift away from. Only the subcommands the
 * emitted CI workflows actually invoke need an entry. Update both this map
 * and the matching `.option(...)` block in `index.ts` together.
 */
const DECLARED_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  analyze: new Set([
    "--force",
    "--embeddings",
    "--embeddings-int8",
    "--granularity",
    "--embeddings-workers",
    "--embeddings-batch-size",
    "--offline",
    "--verbose",
    "--skip-agents-md",
    "--sbom",
    "--no-sbom",
    "--coverage",
    "--no-coverage",
    "--scan",
    "--no-scan",
    "--summaries",
    "--no-summaries",
    "--max-summaries",
    "--summary-model",
    "--skills",
    "--strict-detectors",
    "--allow-build-scripts",
  ]),
  verdict: new Set(["--base", "--head", "--repo", "--json"]),
  scan: new Set([
    "--scanners",
    "--with",
    "--output",
    "--severity",
    "--repo",
    "--concurrency",
    "--timeout",
  ]),
};

/**
 * Walk a rendered workflow body and yield every `codehub <cmd>` invocation
 * with the long-option flags that follow it on the same logical command
 * (joined across `\`-continued lines). Quotes/values are ignored — we only
 * care about the `--flag` tokens.
 */
function extractCodehubInvocations(body: string): { cmd: string; flags: string[] }[] {
  // Collapse YAML/`shell line continuations so a wrapped command is one line.
  const flattened = body.replace(/\\\s*\n\s*/g, " ");
  const out: { cmd: string; flags: string[] }[] = [];
  const re = /\bcodehub\s+([a-z][a-z-]*)\b([^\n]*)/g;
  let m: RegExpExecArray | null = re.exec(flattened);
  while (m !== null) {
    const cmd = m[1] as string;
    const rest = m[2] as string;
    const flags = rest.match(/--[a-z][a-z-]*/g) ?? [];
    out.push({ cmd, flags: [...flags] });
    m = re.exec(flattened);
  }
  return out;
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

test("runCiInit: every emitted codehub invocation uses only CLI-declared flags", async () => {
  const repo = await mkRepo();
  try {
    await runCiInit({ repo, platform: "both", mainBranch: "main" });
    const paths = [
      join(repo, ".github", "workflows", "opencodehub-verdict.yml"),
      join(repo, ".github", "workflows", "opencodehub-nightly.yml"),
      join(repo, ".github", "workflows", "opencodehub-weekly.yml"),
      join(repo, ".github", "workflows", "opencodehub-rescan.yml"),
      join(repo, ".gitlab-ci.yml"),
    ];
    for (const p of paths) {
      const body = await readFile(p, "utf8");
      for (const { cmd, flags } of extractCodehubInvocations(body)) {
        const declared = DECLARED_FLAGS[cmd];
        if (declared === undefined) continue; // command not under audit here
        for (const flag of flags) {
          assert.ok(
            declared.has(flag),
            `${p}: \`codehub ${cmd}\` uses undeclared flag ${flag} — the CLI parser would exit non-zero`,
          );
        }
      }
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// Precise regression guard for the specific phantom flags that previously
// shipped in the verdict + gitlab templates: `analyze --incremental` (analyze
// is incremental by default; the flag is unregistered) and `verdict
// --output-format <fmt> --pr-comment` (never wired in index.ts). None may
// reappear in ANY emitted workflow.
test("runCiInit: emitted workflows never reference removed phantom flags", async () => {
  const repo = await mkRepo();
  try {
    await runCiInit({ repo, platform: "both", mainBranch: "main" });
    const bodies = await Promise.all(
      [
        join(repo, ".github", "workflows", "opencodehub-verdict.yml"),
        join(repo, ".github", "workflows", "opencodehub-nightly.yml"),
        join(repo, ".github", "workflows", "opencodehub-weekly.yml"),
        join(repo, ".github", "workflows", "opencodehub-rescan.yml"),
        join(repo, ".gitlab-ci.yml"),
      ].map((p) => readFile(p, "utf8")),
    );
    const combined = bodies.join("\n");
    assert.doesNotMatch(combined, /--incremental\b/, "analyze --incremental is unregistered");
    assert.doesNotMatch(combined, /--output-format\b/, "verdict --output-format is unwired");
    assert.doesNotMatch(combined, /--pr-comment\b/, "verdict --pr-comment is unwired");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
