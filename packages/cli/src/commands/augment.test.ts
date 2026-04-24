/**
 * Tests for `codehub augment` — the PreToolUse hook callee.
 *
 * Coverage matches the P0-1 contract:
 *   - empty output when no repo is registered for the cwd
 *   - empty output for sub-threshold patterns (<3 chars)
 *   - surface callers + processes when a real DuckDB fixture has them
 *   - never throws, regardless of registry corruption or missing index
 *   - cold-start budget (<750ms) on a 10k-node fixture
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  type CodeRelation,
  type FunctionNode,
  type GraphNode,
  KnowledgeGraph,
  makeNodeId,
  type NodeId,
  type ProcessNode,
} from "@opencodehub/core-types";
import { DuckDbStore, resolveDbPath } from "@opencodehub/storage";
import { upsertRegistry } from "../registry.js";
import { augment, runAugment } from "./augment.js";

async function scratch(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `och-augment-${prefix}-`));
}

async function seedRepoWithStore(
  home: string,
  repoName: string,
  build: (g: KnowledgeGraph) => void,
): Promise<string> {
  const repoPath = resolve(home, repoName);
  await mkdir(join(repoPath, ".codehub"), { recursive: true });
  const g = new KnowledgeGraph();
  build(g);
  const dbPath = resolveDbPath(repoPath);
  const store = new DuckDbStore(dbPath);
  try {
    await store.open();
    await store.createSchema();
    await store.bulkLoad(g);
  } finally {
    await store.close();
  }
  await upsertRegistry(
    {
      name: repoName,
      path: repoPath,
      indexedAt: "2026-04-24T00:00:00Z",
      nodeCount: g.nodeCount(),
      edgeCount: g.edgeCount(),
    },
    { home },
  );
  return repoPath;
}

function funcNode(file: string, name: string): FunctionNode {
  const id = makeNodeId("Function", file, name);
  return {
    id,
    kind: "Function",
    name,
    filePath: file,
    startLine: 1,
    endLine: 2,
  };
}

function processNode(name: string, entryId: NodeId): ProcessNode {
  const id = makeNodeId("Process", "process", name);
  return {
    id,
    kind: "Process",
    name,
    filePath: "process",
    entryPointId: entryId,
  };
}

function edge(
  from: NodeId,
  to: NodeId,
  type: CodeRelation["type"],
  confidence = 1,
): Omit<CodeRelation, "id"> {
  return { from, to, type, confidence };
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

test("augment: sub-threshold patterns collapse to empty", async () => {
  assert.equal(await augment("", { cwd: "/" }), "");
  assert.equal(await augment("ab", { cwd: "/" }), "");
  // Only 2 chars even after counting the dash prefix — still below threshold.
  assert.equal(await augment("a-", { cwd: "/" }), "");
});

test("augment: returns empty when cwd maps to no registered repo", async () => {
  const home = await scratch("no-repo");
  // Fresh registry, no entries. cwd is just the home tmpdir.
  const out = await augment("somepattern", { cwd: home, home });
  assert.equal(out, "");
});

test("augment: returns empty when the registered repo has no DuckDB file", async () => {
  const home = await scratch("no-db");
  const repoPath = resolve(home, "ghost");
  await mkdir(join(repoPath, ".codehub"), { recursive: true });
  // Registry entry points at a repo whose graph.duckdb does not exist.
  await upsertRegistry(
    {
      name: "ghost",
      path: repoPath,
      indexedAt: "2026-04-24T00:00:00Z",
      nodeCount: 0,
      edgeCount: 0,
    },
    { home },
  );
  const out = await augment("somepattern", { cwd: repoPath, home });
  assert.equal(out, "");
});

test("augment: surfaces callers and processes for a known symbol", async () => {
  const home = await scratch("hit");
  const repoPath = await seedRepoWithStore(home, "demo", (g) => {
    const callerNode = funcNode("src/caller.ts", "doGreet");
    const targetNode = funcNode("src/target.ts", "greetUser");
    const calleeNode = funcNode("src/target.ts", "formatGreeting");
    const procNode = processNode("login-flow", targetNode.id);
    for (const n of [callerNode, targetNode, calleeNode, procNode] as GraphNode[]) {
      g.addNode(n);
    }
    g.addEdge(edge(callerNode.id, targetNode.id, "CALLS", 0.95));
    g.addEdge(edge(targetNode.id, calleeNode.id, "CALLS", 0.9));
    g.addEdge(edge(procNode.id, targetNode.id, "PROCESS_STEP", 1));
  });

  const out = await augment("greetUser", { cwd: repoPath, home, limit: 3 });
  assert.match(out, /\[codehub:demo\]/);
  assert.match(out, /greetUser/);
  assert.match(out, /called by: doGreet/);
  // Callees line should surface formatGreeting.
  assert.match(out, /calls: .*formatGreeting/);
  // Process participation is rendered on the flows line.
  assert.match(out, /flows: login-flow/);
});

test("augment: never throws on malformed registry", async () => {
  const home = await scratch("corrupt");
  await mkdir(join(home, ".codehub"), { recursive: true });
  await writeFile(join(home, ".codehub", "registry.json"), "{ not valid json");
  // augment() catches its own errors; runAugment() wraps them too. Neither
  // should propagate.
  const writes: string[] = [];
  await runAugment("something", { cwd: home, home, writer: (c) => writes.push(c) });
  assert.equal(writes.length, 0);
});

test("augment: writer only fires when there is content", async () => {
  const home = await scratch("no-hits");
  await seedRepoWithStore(home, "demo", (g) => {
    g.addNode(funcNode("src/unrelated.ts", "unrelatedOnly"));
  });
  const writes: string[] = [];
  await runAugment("zzzz-no-such-symbol", {
    cwd: resolve(home, "demo"),
    home,
    writer: (c) => writes.push(c),
  });
  assert.equal(writes.length, 0);
});

test("augment: cold-start under 750ms on a ~10k-node fixture", async () => {
  const home = await scratch("cold-start");
  const repoPath = await seedRepoWithStore(home, "big", (g) => {
    // 10_000 Function nodes plus a linear CALLS chain across the first 500.
    const ids: NodeId[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      const node = funcNode(`src/f${i % 200}.ts`, `fn_${i}`);
      g.addNode(node);
      ids.push(node.id);
    }
    for (let i = 1; i < 500; i += 1) {
      const from = ids[i - 1];
      const to = ids[i];
      if (from === undefined || to === undefined) continue;
      g.addEdge(edge(from, to, "CALLS", 0.9));
    }
  });

  const start = performance.now();
  const out = await augment("fn_42", { cwd: repoPath, home, limit: 5 });
  const elapsed = performance.now() - start;
  assert.ok(out.length > 0, "expected non-empty augment output for matching pattern");
  assert.ok(elapsed < 750, `augment cold-start budget exceeded: ${elapsed.toFixed(1)}ms > 750ms`);
});
