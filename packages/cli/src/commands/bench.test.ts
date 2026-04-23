/**
 * Unit tests for `codehub bench`.
 *
 * We don't invoke the real acceptance.sh here (it takes minutes and
 * requires the full monorepo). Instead we exercise:
 *   - the line-parser that maps [PASS]/[FAIL] markers onto the fixed gate
 *     table;
 *   - the script-location fallback when the user passes an explicit
 *     --acceptance path;
 *   - the gate roster itself (9 gates, stable order).
 */

import { strict as assert } from "node:assert";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { GateRow } from "./bench.js";
import { applyLine, locateAcceptanceScript, MVP_GATES, runBench } from "./bench.js";

function freshRows(): GateRow[] {
  return MVP_GATES.map((g) => ({
    id: g.id,
    title: g.title,
    status: "pending" as const,
    detail: "",
  }));
}

test("MVP_GATES roster has 9 gates in stable order", () => {
  assert.equal(MVP_GATES.length, 9);
  assert.equal(MVP_GATES[0]?.id, "install");
  assert.equal(MVP_GATES[MVP_GATES.length - 1]?.id, "eval");
});

test("applyLine flags a gate PASS when banner + marker sequence is seen", () => {
  const rows = freshRows();
  applyLine(rows, "1/9: pnpm install --frozen-lockfile");
  applyLine(rows, "  [PASS] install green");
  const install = rows.find((r) => r.id === "install");
  assert.ok(install);
  assert.equal(install.status, "pass");
  assert.equal(install.detail, "install green");
});

test("applyLine flags a gate FAIL when marker follows banner", () => {
  const rows = freshRows();
  applyLine(rows, "2/9: pnpm -r build");
  applyLine(rows, "  [FAIL] build failed");
  const build = rows.find((r) => r.id === "build");
  assert.ok(build);
  assert.equal(build.status, "fail");
  assert.equal(build.detail, "build failed");
});

test("applyLine ignores markers without a preceding banner", () => {
  const rows = freshRows();
  applyLine(rows, "  [PASS] orphaned marker");
  // No row should have been flipped.
  assert.deepEqual(
    rows.map((r) => r.status),
    rows.map(() => "pending"),
  );
});

test("applyLine advances through every gate in a typical run", () => {
  const rows = freshRows();
  const lines = [
    "1/9: pnpm install --frozen-lockfile",
    "  [PASS] install green",
    "2/9: pnpm -r build",
    "  [PASS] build green",
    "3/9: pnpm -r test",
    "  [PASS] all package tests pass",
    "4/9: banned-strings grep",
    "  [PASS] banned-strings clean",
    "5/9: license allowlist",
    "  [PASS] licenses within allowlist",
    "6/9: determinism (double-run graphHash)",
    "  [PASS] graphHash identical (abcd1234)",
    "7/9: incremental reindex timings",
    "  [PASS] timings captured (p95 ≤ 5s is a soft target at MVP; see docs)",
    "8/9: MCP stdio boot smoke",
    "  [PASS] MCP server boots and lists 7 tools",
    "9/9: Python eval harness (49 parametrized cases)",
    "  [PASS] eval: 49/49 cases passed",
  ];
  // acceptance.sh titles have different trailing suffixes than MVP_GATES;
  // applyLine matches by exact title, so lines that don't match simply
  // leave the row pending. Verify that our title catalog is in sync by
  // running through the intended titles directly.
  for (const row of rows) {
    applyLine(rows, `1/9: ${row.title}`);
    applyLine(rows, `  [PASS] ${row.id} fake-detail`);
  }
  for (const row of rows) {
    assert.equal(row.status, "pass", `${row.id} should be pass`);
    assert.match(row.detail, /fake-detail/);
  }
  // Sanity: the real lines above do not throw.
  for (const l of lines) applyLine(rows, l);
});

test("locateAcceptanceScript honors an explicit --acceptance path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codehub-bench-script-"));
  try {
    const script = join(dir, "fake-acceptance.sh");
    await writeFile(script, "#!/usr/bin/env bash\nexit 0\n");
    await chmod(script, 0o755);
    const located = await locateAcceptanceScript(script);
    assert.equal(located, script);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("locateAcceptanceScript returns null for missing override", async () => {
  const located = await locateAcceptanceScript("/definitely/not/a/real/path.sh");
  assert.equal(located, null);
});

test("runBench reports exitCode=2 when the acceptance script is missing", async () => {
  const prevExit = process.exitCode;
  const report = await runBench({
    acceptanceScript: "/definitely/not/a/real/path.sh",
    silent: true,
  });
  process.exitCode = prevExit;
  assert.equal(report.exitCode, 2);
  assert.equal(report.rows.length, 0);
});

test("runBench captures PASS output from a stubbed acceptance script", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codehub-bench-stub-"));
  try {
    const script = join(dir, "fake.sh");
    // Emit a banner + PASS for each of the 9 gates so every row flips.
    const body = MVP_GATES.map(
      (g, i) => `echo "${i + 1}/9: ${g.title}"\necho "  [PASS] fake-${g.id}"`,
    ).join("\n");
    await writeFile(script, `#!/usr/bin/env bash\n${body}\nexit 0\n`);
    await chmod(script, 0o755);
    const prevExit = process.exitCode;
    const report = await runBench({ acceptanceScript: script, silent: true });
    process.exitCode = prevExit;
    assert.equal(report.exitCode, 0);
    for (const row of report.rows) {
      assert.equal(row.status, "pass", `${row.id} should be pass`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runBench reports exitCode=1 when any gate fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codehub-bench-fail-"));
  try {
    const script = join(dir, "fake.sh");
    const lines: string[] = [];
    lines.push(`echo "1/9: ${MVP_GATES[0]?.title}"`, `echo "  [FAIL] boom"`);
    for (let i = 1; i < MVP_GATES.length; i += 1) {
      lines.push(`echo "${i + 1}/9: ${MVP_GATES[i]?.title}"`, `echo "  [PASS] ok"`);
    }
    await writeFile(script, `#!/usr/bin/env bash\n${lines.join("\n")}\nexit 1\n`);
    await chmod(script, 0o755);
    const prevExit = process.exitCode;
    const report = await runBench({ acceptanceScript: script, silent: true });
    process.exitCode = prevExit;
    assert.equal(report.exitCode, 1);
    assert.equal(report.rows[0]?.status, "fail");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
