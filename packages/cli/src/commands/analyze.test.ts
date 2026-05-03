/**
 * Unit tests for `codehub analyze` helpers.
 *
 * P04 deliverables covered here:
 *   - `resolveMaxSummariesCap` arithmetic for `--max-summaries auto`:
 *     prior-run seed → floor(count × 0.1) clamped at 500; first-run
 *     fallback → 50; explicit numbers pass through; summaries disabled
 *     → 0 regardless of input.
 *   - `CODEHUB_BEDROCK_DISABLED=1` env kill-switch semantics: when the
 *     caller short-circuits `summariesEnabled` to false (mirroring how
 *     `runAnalyze` and the CLI entry point honor the env var) the cap
 *     collapses to 0 even under `auto`.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { upsertRegistry } from "../registry.js";
import { checkFastPath, resolveMaxSummariesCap, resolveSummariesEnabled } from "./analyze.js";

/**
 * Run a subprocess and resolve once it exits. Returns the exit code so
 * callers can treat `git init` / `git commit` setup failures as hard
 * failures instead of silently skipping. stdout/stderr are dropped — the
 * dirty-tree tests only care about exit codes.
 */
function runQuiet(cmd: string, args: readonly string[], cwd: string): Promise<number> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(cmd, args, { cwd, stdio: "ignore" });
    child.on("error", rejectP);
    child.on("close", (code) => resolveP(code ?? -1));
  });
}

async function initGitRepo(dir: string): Promise<string> {
  // `-b main` keeps the default branch deterministic regardless of the
  // host `init.defaultBranch` config. `-c user.*` is set per-call to
  // avoid mutating the caller's global git identity.
  const envFlags = [
    "-c",
    "user.email=codehub-test@example.com",
    "-c",
    "user.name=codehub-test",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "init.defaultBranch=main",
  ];
  assert.equal(await runQuiet("git", [...envFlags, "init", "-q"], dir), 0, "git init");
  await writeFile(join(dir, "README.md"), "seed\n", "utf8");
  assert.equal(await runQuiet("git", [...envFlags, "add", "."], dir), 0, "git add");
  assert.equal(
    await runQuiet("git", [...envFlags, "commit", "-q", "-m", "init"], dir),
    0,
    "git commit",
  );
  const headPromise = new Promise<string>((resolveP, rejectP) => {
    let out = "";
    const child = spawn("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      out += c;
    });
    child.on("error", rejectP);
    child.on("close", (code) => {
      if (code === 0) resolveP(out.trim());
      else rejectP(new Error(`git rev-parse exit ${code}`));
    });
  });
  return headPromise;
}

test("resolveMaxSummariesCap: auto resolves to floor(count × 0.1) when seed is known", async () => {
  // 1234 callables → 10% = 123.4 → floor = 123.
  const cap = await resolveMaxSummariesCap("/unused", "auto", true, async () => 1234);
  assert.equal(cap, 123);
});

test("resolveMaxSummariesCap: auto clamps at the 500 cap for large repos", async () => {
  // 10_000 callables would be 1000 uncapped; the policy clamps at 500.
  const cap = await resolveMaxSummariesCap("/unused", "auto", true, async () => 10_000);
  assert.equal(cap, 500);
});

test("resolveMaxSummariesCap: auto falls back to 50 on first run (no prior seed)", async () => {
  // `undefined` models "no prior DuckDB store at the expected path".
  const cap = await resolveMaxSummariesCap("/unused", "auto", true, async () => undefined);
  assert.equal(cap, 50);
});

test("resolveMaxSummariesCap: undefined defaults to the auto path", async () => {
  // A caller that doesn't pass --max-summaries at all gets the same
  // behavior as explicit `auto`.
  const cap = await resolveMaxSummariesCap("/unused", undefined, true, async () => 200);
  assert.equal(cap, 20);
});

test("resolveMaxSummariesCap: explicit numbers pass through unchanged", async () => {
  const cap = await resolveMaxSummariesCap("/unused", 42, true, async () => 999);
  assert.equal(cap, 42);
});

test("resolveMaxSummariesCap: negative integers clamp to 0 (dry-run)", async () => {
  const cap = await resolveMaxSummariesCap("/unused", -5, true, async () => 999);
  assert.equal(cap, 0);
});

test("resolveMaxSummariesCap: non-integer numbers are floored", async () => {
  const cap = await resolveMaxSummariesCap(
    "/unused",
    7.9 as unknown as number,
    true,
    async () => 0,
  );
  assert.equal(cap, 7);
});

test("resolveMaxSummariesCap: summariesEnabled=false collapses to 0 regardless of input", async () => {
  // This is the behavior chain the CLI depends on when either
  // `--no-summaries` or `CODEHUB_BEDROCK_DISABLED=1` short-circuits
  // `summariesEnabled` upstream.
  const autoCap = await resolveMaxSummariesCap("/unused", "auto", false, async () => 1_000);
  assert.equal(autoCap, 0, "auto + disabled must dry-run");
  const numericCap = await resolveMaxSummariesCap("/unused", 100, false, async () => 1_000);
  assert.equal(numericCap, 0, "explicit cap + disabled must dry-run");
});

test("resolveMaxSummariesCap: seed of 0 yields a cap of 0 (no callables to summarize)", async () => {
  const cap = await resolveMaxSummariesCap("/unused", "auto", true, async () => 0);
  assert.equal(cap, 0);
});

test("resolveMaxSummariesCap: seed of 5 yields a cap of 0 under the 10% rule", async () => {
  // 5 × 0.1 = 0.5 → floor = 0. Tiny repos dry-run until they grow.
  const cap = await resolveMaxSummariesCap("/unused", "auto", true, async () => 5);
  assert.equal(cap, 0);
});

// ---------------------------------------------------------------------------
// resolveSummariesEnabled — env kill-switch + P04 default-on contract.
// ---------------------------------------------------------------------------

test("resolveSummariesEnabled: default-on when both env and flag are absent (P04)", () => {
  assert.equal(resolveSummariesEnabled(undefined, {}), true);
});

test("resolveSummariesEnabled: explicit --summaries keeps it on", () => {
  assert.equal(resolveSummariesEnabled(true, {}), true);
});

test("resolveSummariesEnabled: explicit --no-summaries turns it off", () => {
  assert.equal(resolveSummariesEnabled(false, {}), false);
});

test("resolveSummariesEnabled: CODEHUB_BEDROCK_DISABLED=1 kills the phase (SUM-S-001)", () => {
  assert.equal(resolveSummariesEnabled(undefined, { CODEHUB_BEDROCK_DISABLED: "1" }), false);
});

test("resolveSummariesEnabled: env kill-switch wins over --summaries=true", () => {
  // Operator passed --summaries explicitly but the env var forces off.
  // Required so CI / restricted environments can lock out Bedrock without
  // auditing every invocation site.
  assert.equal(resolveSummariesEnabled(true, { CODEHUB_BEDROCK_DISABLED: "1" }), false);
});

test("resolveSummariesEnabled: CODEHUB_BEDROCK_DISABLED=0 does not kill the phase", () => {
  // Only the literal "1" triggers the kill-switch — anything else is a
  // no-op. This keeps operator intent unambiguous.
  assert.equal(resolveSummariesEnabled(undefined, { CODEHUB_BEDROCK_DISABLED: "0" }), true);
  assert.equal(resolveSummariesEnabled(undefined, { CODEHUB_BEDROCK_DISABLED: "" }), true);
});

// ---------------------------------------------------------------------------
// Dirty-tree bypass on the analyze fast-path (T-M1-1 / EARS requirement).
// ---------------------------------------------------------------------------

test("checkFastPath: dirty working tree bypasses the fast-path even when HEAD matches", async () => {
  // Seed a real git repo with one committed file, record its HEAD in a
  // scratch registry, then confirm:
  //   1. a clean tree returns the cached entry (fast-path hit),
  //   2. editing a tracked file returns undefined (fast-path miss → full re-run).
  const repoPath = await mkdtemp(join(tmpdir(), "och-analyze-dirty-"));
  const home = await mkdtemp(join(tmpdir(), "och-analyze-registry-"));
  const head = await initGitRepo(repoPath);
  const repoName = repoPath.split("/").pop() ?? "test-repo";

  await upsertRegistry(
    {
      name: repoName,
      path: repoPath,
      indexedAt: "2026-05-03T00:00:00Z",
      nodeCount: 42,
      edgeCount: 10,
      lastCommit: head,
    },
    { home },
  );

  const cleanHit = await checkFastPath(repoName, repoPath, { home });
  assert.ok(cleanHit, "clean tree + matching HEAD should hit the fast-path");
  assert.equal(cleanHit.lastCommit, head);

  // Dirty the tree — edit the tracked file without committing.
  await writeFile(join(repoPath, "README.md"), "dirty edit\n", "utf8");

  const dirtyHit = await checkFastPath(repoName, repoPath, { home });
  assert.equal(
    dirtyHit,
    undefined,
    "dirty working tree must bypass the fast-path so analyze re-runs against edits",
  );
});
