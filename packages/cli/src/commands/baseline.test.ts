/**
 * Tests for `codehub baseline freeze` and `codehub baseline diff`.
 *
 * These tests write SARIF files on disk under a scratch tmp dir, run the
 * command handlers directly (no commander round-trip), and assert on the
 * returned summary + on-disk artifact. No registry or DuckDB is touched.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { SarifLog } from "@opencodehub/sarif";
import { runBaselineDiff, runBaselineFreeze } from "./baseline.js";

async function scratch(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function baseLog(): SarifLog {
  return {
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "semgrep", version: "1.0.0" } },
        results: [
          {
            ruleId: "r.xss",
            message: { text: "XSS risk" },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: "web/a.ts" },
                  region: { startLine: 10 },
                },
              },
            ],
            partialFingerprints: { "opencodehub/v1": "a".repeat(32) },
          },
        ],
      },
    ],
  };
}

function withExtraFinding(log: SarifLog): SarifLog {
  const clone = structuredClone(log) as SarifLog;
  const run = clone.runs[0];
  if (run === undefined) throw new Error("fixture: missing run");
  const results = run.results ?? [];
  run.results = [
    ...results,
    {
      ruleId: "r.sqli",
      message: { text: "SQLi" },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: "api/b.ts" },
            region: { startLine: 20 },
          },
        },
      ],
      partialFingerprints: { "opencodehub/v1": "b".repeat(32) },
    },
  ];
  return clone;
}

async function writeSarif(path: string, log: SarifLog): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(log, null, 2)}\n`, "utf8");
}

interface Capture {
  readonly lines: string[];
  restore(): void;
}

function captureStdout(): Capture {
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    for (const line of text.split("\n")) {
      if (line.length > 0) lines.push(line);
    }
    return true;
  }) as typeof process.stdout.write;
  return {
    lines,
    restore: () => {
      process.stdout.write = orig;
    },
  };
}

test("baseline freeze writes scan.sarif to baseline.sarif", async () => {
  const repoPath = await scratch("och-cli-baseline-freeze-");
  await writeSarif(resolve(repoPath, ".codehub", "scan.sarif"), baseLog());

  const summary = await runBaselineFreeze(repoPath);
  assert.equal(summary.to, resolve(repoPath, ".codehub", "baseline.sarif"));
  assert.equal(summary.runCount, 1);
  assert.equal(summary.resultCount, 1);

  const written = JSON.parse(await readFile(summary.to, "utf8")) as SarifLog;
  assert.equal(written.version, "2.1.0");
  assert.equal(written.runs.length, 1);
  assert.equal(written.runs[0]?.results?.[0]?.ruleId, "r.xss");
});

test("baseline diff on identical inputs reports 0 new / 0 fixed", async () => {
  const repoPath = await scratch("och-cli-baseline-same-");
  const log = baseLog();
  await writeSarif(resolve(repoPath, ".codehub", "baseline.sarif"), log);
  await writeSarif(resolve(repoPath, ".codehub", "scan.sarif"), log);

  const cap = captureStdout();
  let summary: Awaited<ReturnType<typeof runBaselineDiff>>;
  try {
    summary = await runBaselineDiff(repoPath);
  } finally {
    cap.restore();
  }
  assert.equal(summary.counts.new, 0);
  assert.equal(summary.counts.fixed, 0);
  assert.equal(summary.counts.unchanged, 1);
  assert.equal(summary.counts.updated, 0);
  assert.equal(summary.exitCode, 0);

  const line = cap.lines.find((l) => l.includes("new"));
  assert.ok(line, "expected a summary line mentioning 'new'");
  assert.match(line, /0 new, 0 fixed, 1 unchanged, 0 updated/);
});

test("baseline diff with a new finding reports 1 new and sets exit 1 with --exit-code", async () => {
  const repoPath = await scratch("och-cli-baseline-new-");
  await writeSarif(resolve(repoPath, ".codehub", "baseline.sarif"), baseLog());
  await writeSarif(resolve(repoPath, ".codehub", "scan.sarif"), withExtraFinding(baseLog()));

  const originalExitCode = process.exitCode;
  process.exitCode = 0;
  const cap = captureStdout();
  let summary: Awaited<ReturnType<typeof runBaselineDiff>>;
  try {
    summary = await runBaselineDiff(repoPath, { exitCode: true });
  } finally {
    cap.restore();
    const observed = process.exitCode;
    process.exitCode = originalExitCode;
    assert.equal(observed, 1);
  }
  assert.equal(summary.counts.new, 1);
  assert.equal(summary.counts.unchanged, 1);
  assert.equal(summary.exitCode, 1);

  const line = cap.lines.find((l) => l.includes("new"));
  assert.ok(line);
  assert.match(line, /1 new, 0 fixed, 1 unchanged, 0 updated/);
});
