/**
 * Unit tests for `codehub bench`.
 *
 * We don't invoke the real acceptance.sh here (it takes minutes and
 * requires the full monorepo). Instead we exercise:
 *   - the line-parser that maps [PASS]/[FAIL] markers onto the fixed gate
 *     table;
 *   - the script-location fallback when the user passes an explicit
 *     --acceptance path;
 *   - the gate roster itself (17 gates, stable order).
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

test("MVP_GATES roster has 17 gates in stable order", () => {
  assert.equal(MVP_GATES.length, 17);
  assert.equal(MVP_GATES[0]?.id, "install");
  assert.equal(MVP_GATES[MVP_GATES.length - 1]?.id, "m7-parity-audit");
});

test("applyLine flags a gate PASS when banner + marker sequence is seen", () => {
  const rows = freshRows();
  applyLine(rows, "1/17: pnpm install --frozen-lockfile");
  applyLine(rows, "  [PASS] install green");
  const install = rows.find((r) => r.id === "install");
  assert.ok(install);
  assert.equal(install.status, "pass");
  assert.equal(install.detail, "install green");
});

test("applyLine flags a gate FAIL when marker follows banner", () => {
  const rows = freshRows();
  applyLine(rows, "2/17: pnpm -r build");
  applyLine(rows, "  [FAIL] build failed");
  const build = rows.find((r) => r.id === "build");
  assert.ok(build);
  assert.equal(build.status, "fail");
  assert.equal(build.detail, "build failed");
});

test("applyLine flags a gate SKIP when marker follows banner", () => {
  const rows = freshRows();
  applyLine(rows, "12/17: scanner smoke (semgrep)");
  applyLine(rows, "  [SKIP] semgrep not installed");
  const scanner = rows.find((r) => r.id === "scanner-smoke");
  assert.ok(scanner);
  assert.equal(scanner.status, "skipped");
  assert.equal(scanner.detail, "semgrep not installed");
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
  // Real banner+marker pairs straight from scripts/acceptance.sh. Titles
  // now match MVP_GATES verbatim, so every line should flip its row.
  const lines = [
    "1/17: pnpm install --frozen-lockfile",
    "  [PASS] install green",
    "2/17: pnpm -r build",
    "  [PASS] build green",
    "3/17: pnpm -r test",
    "  [PASS] all package tests pass",
    "4/17: banned-strings grep",
    "  [PASS] banned-strings clean",
    "5/17: license allowlist",
    "  [PASS] licenses within allowlist",
    "6/17: determinism (double-run graphHash)",
    "  [PASS] graphHash identical (abcd1234)",
    "7/17: incremental reindex timings",
    "  [PASS] timings captured",
    "8/17: MCP stdio boot smoke",
    "  [PASS] MCP server boots",
    "9/17: Python eval harness (moved to opencodehub-testbed)",
    "  [SKIP] harness lives in sibling repo",
    "10/17: embeddings determinism",
    "  [SKIP] no embedder weights",
    "11/17: incremental timing on 100-file fixture",
    "  [PASS] p95 within budget",
    "12/17: scanner smoke (semgrep)",
    "  [SKIP] semgrep not installed",
    "13/17: SARIF schema validation",
    "  [PASS] sarif schema valid",
    "14/17: license-audit smoke",
    "  [PASS] audit emitted",
    "15/17: verdict smoke (2-commit fixture)",
    "  [PASS] verdict tier=safe",
    "16/17: pack-determinism (code-pack ×2 → diff -r)",
    "  [PASS] pack identical",
    "17/17: m7-parity-audit (analyze ×2 backends → graphHash)",
    "  [PASS] graph parity holds",
  ];
  for (const l of lines) applyLine(rows, l);
  // Every row should be either pass or skipped — no row left pending.
  for (const row of rows) {
    assert.notEqual(row.status, "pending", `${row.id} should not be pending`);
    assert.notEqual(row.status, "fail", `${row.id} should not be fail`);
  }
  // At least one of each terminal status was exercised.
  assert.ok(rows.some((r) => r.status === "pass"));
  assert.ok(rows.some((r) => r.status === "skipped"));
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
    // Emit a banner + PASS for each of the 17 gates so every row flips.
    const body = MVP_GATES.map(
      (g, i) => `echo "${i + 1}/17: ${g.title}"\necho "  [PASS] fake-${g.id}"`,
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
    lines.push(`echo "1/17: ${MVP_GATES[0]?.title}"`, `echo "  [FAIL] boom"`);
    for (let i = 1; i < MVP_GATES.length; i += 1) {
      lines.push(`echo "${i + 1}/17: ${MVP_GATES[i]?.title}"`, `echo "  [PASS] ok"`);
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
