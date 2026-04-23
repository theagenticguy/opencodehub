/**
 * `codehub status` surfaces which groups the current repo belongs to.
 *
 * These tests capture the Stream J acceptance for the status surface:
 *   - When the repo is in 0 groups: prints "(none)".
 *   - When the repo is in 2 groups and one unrelated group exists: prints
 *     only the two matching names, alphabetically.
 * The rest of the status output (schemaVersion, counts, staleness) is
 * covered by the meta round-trip tests elsewhere; here we only pin the
 * group-membership line.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { writeStoreMeta } from "@opencodehub/storage";
import { writeGroup } from "../groups.js";
import { upsertRegistry } from "../registry.js";
import { runStatus } from "./status.js";

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "och-cli-status-"));
}

interface Capture {
  readonly lines: string[];
  restore(): void;
}

function captureStdout(): Capture {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  return {
    lines,
    restore: () => {
      console.log = orig;
    },
  };
}

async function seedRepo(home: string, name: string): Promise<string> {
  const repoPath = resolve(home, name);
  await mkdir(resolve(repoPath, ".codehub"), { recursive: true });
  // Minimal valid meta.json; runStatus only reads this, never the DB.
  await writeStoreMeta(repoPath, {
    schemaVersion: "1.0.0",
    indexedAt: "2026-04-18T00:00:00Z",
    nodeCount: 1,
    edgeCount: 0,
  });
  await upsertRegistry(
    {
      name,
      path: repoPath,
      indexedAt: "2026-04-18T00:00:00Z",
      nodeCount: 1,
      edgeCount: 0,
    },
    { home },
  );
  return repoPath;
}

async function seedGroup(home: string, group: string, repoNames: readonly string[]): Promise<void> {
  const groupsDir = resolve(home, ".codehub", "groups");
  await mkdir(groupsDir, { recursive: true });
  await writeGroup(
    {
      name: group,
      createdAt: "2026-04-18T00:00:00Z",
      repos: repoNames.map((n) => ({ name: n, path: resolve(home, n) })),
    },
    { home },
  );
  // writeGroup handles atomic writes + sorting.
  await writeFile(resolve(groupsDir, `${group}.touch`), ""); // touch for sanity
}

test("status prints groups=(none) when the repo is in zero groups", async () => {
  const home = await scratch();
  const repoPath = await seedRepo(home, "solo");
  const cap = captureStdout();
  try {
    await runStatus(repoPath, { home });
  } finally {
    cap.restore();
  }
  const groupsLine = cap.lines.find((l) => l.startsWith("groups:"));
  assert.ok(groupsLine, "status must emit a groups: line");
  assert.match(groupsLine, /\(none\)/);
});

test("status surfaces every group the repo belongs to, alphabetical", async () => {
  const home = await scratch();
  const repoPath = await seedRepo(home, "target");
  await seedRepo(home, "other");
  // target is in two groups, "other" in one unrelated group.
  await seedGroup(home, "zeta", ["target"]);
  await seedGroup(home, "alpha", ["target", "other"]);
  await seedGroup(home, "unrelated", ["other"]);

  const cap = captureStdout();
  try {
    await runStatus(repoPath, { home });
  } finally {
    cap.restore();
  }
  const groupsLine = cap.lines.find((l) => l.startsWith("groups:"));
  assert.ok(groupsLine);
  // Alphabetical + only the two groups that actually contain `target`.
  assert.match(groupsLine, /groups:\s+alpha, zeta$/);
  assert.doesNotMatch(groupsLine, /unrelated/);
});
