/**
 * Tests for `codehub eval-server` — the persistent HTTP daemon that
 * wraps the pure MCP tool handlers with text-formatted output plus
 * next-step hints.
 *
 * Coverage mirrors the P0-2 contract:
 *   - GET /health returns 200 with the registered repo list
 *   - POST /tool/:name with invalid JSON returns 400
 *   - POST /tool/query with a valid body returns text/plain plus a hint
 *   - Oversized body (> 1 MB) returns 413
 *   - Unknown tool returns 404
 *   - Idle timeout shuts the server down
 *   - /shutdown drains the pool gracefully
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
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
} from "@opencodehub/core-types";
import { DuckDbStore, resolveDbPath } from "@opencodehub/storage";
import { formatToolResult } from "../eval-server/formatters.js";
import { buildResponseBody, startEvalServer } from "../eval-server/http-server.js";
import { getNextStepHint } from "../eval-server/next-steps.js";
import { upsertRegistry } from "../registry.js";

async function scratch(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `och-eval-${prefix}-`));
}

function funcNode(file: string, name: string): FunctionNode {
  const id = makeNodeId("Function", file, name);
  return {
    id,
    kind: "Function",
    name,
    filePath: file,
    startLine: 1,
    endLine: 5,
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

async function seedRepo(
  home: string,
  name: string,
  build: (g: KnowledgeGraph) => void,
): Promise<string> {
  const repoPath = resolve(home, name);
  await mkdir(join(repoPath, ".codehub"), { recursive: true });
  const g = new KnowledgeGraph();
  build(g);
  const store = new DuckDbStore(resolveDbPath(repoPath));
  try {
    await store.open();
    await store.createSchema();
    await store.bulkLoad(g);
  } finally {
    await store.close();
  }
  await upsertRegistry(
    {
      name,
      path: repoPath,
      indexedAt: "2026-04-24T00:00:00Z",
      nodeCount: g.nodeCount(),
      edgeCount: g.edgeCount(),
    },
    { home },
  );
  return repoPath;
}

async function httpRequest(
  url: string,
  init: RequestInit & { body?: string } = {},
): Promise<{ status: number; contentType: string; body: string }> {
  const res = await fetch(url, init);
  const body = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  return { status: res.status, contentType, body };
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

test("eval-server: GET /health returns 200 with repo list", async () => {
  const home = await scratch("health");
  await seedRepo(home, "demo", (g) => {
    g.addNode(funcNode("src/a.ts", "hello") as GraphNode);
  });

  const handle = await startEvalServer({
    port: 0,
    home,
    silent: true,
    testMode: true,
    idleTimeoutMs: 0,
  });
  try {
    const res = await httpRequest(`http://127.0.0.1:${handle.port}/health`);
    assert.equal(res.status, 200);
    assert.match(res.contentType, /application\/json/);
    const payload = JSON.parse(res.body) as { status: string; repos: string[] };
    assert.equal(payload.status, "ok");
    assert.deepEqual(payload.repos, ["demo"]);
  } finally {
    await handle.shutdown();
  }
});

test("eval-server: POST /tool/query with invalid JSON returns 400", async () => {
  const home = await scratch("bad-json");
  await seedRepo(home, "demo", (g) => {
    g.addNode(funcNode("src/a.ts", "hello") as GraphNode);
  });

  const handle = await startEvalServer({
    port: 0,
    home,
    silent: true,
    testMode: true,
    idleTimeoutMs: 0,
  });
  try {
    const res = await httpRequest(`http://127.0.0.1:${handle.port}/tool/query`, {
      method: "POST",
      body: "{ not valid json",
    });
    assert.equal(res.status, 400);
    assert.match(res.contentType, /text\/plain/);
    assert.match(res.body, /invalid JSON/i);
  } finally {
    await handle.shutdown();
  }
});

test("eval-server: POST /tool/list_repos returns text and contains next-step hint", async () => {
  const home = await scratch("list-repos");
  await seedRepo(home, "demo", (g) => {
    g.addNode(funcNode("src/a.ts", "hello") as GraphNode);
  });

  const handle = await startEvalServer({
    port: 0,
    home,
    silent: true,
    testMode: true,
    idleTimeoutMs: 0,
  });
  try {
    const res = await httpRequest(`http://127.0.0.1:${handle.port}/tool/list_repos`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(res.status, 200);
    assert.match(res.contentType, /text\/plain/);
    assert.doesNotMatch(res.body, /^\s*\{/); // NOT raw JSON
    assert.match(res.body, /demo/);
    assert.match(res.body, /Next: /);
  } finally {
    await handle.shutdown();
  }
});

test("eval-server: POST /tool/query with valid body returns text", async () => {
  const home = await scratch("query");
  const repoPath = await seedRepo(home, "demo", (g) => {
    const caller = funcNode("src/caller.ts", "callSite");
    const target = funcNode("src/target.ts", "greetUser");
    g.addNode(caller as GraphNode);
    g.addNode(target as GraphNode);
    g.addEdge(edge(caller.id, target.id, "CALLS", 0.95));
  });
  assert.ok(repoPath.length > 0);

  const handle = await startEvalServer({
    port: 0,
    home,
    silent: true,
    testMode: true,
    idleTimeoutMs: 0,
  });
  try {
    const res = await httpRequest(`http://127.0.0.1:${handle.port}/tool/query`, {
      method: "POST",
      body: JSON.stringify({ query: "greetUser", repo: "demo" }),
    });
    assert.equal(res.status, 200);
    assert.match(res.contentType, /text\/plain/);
    assert.match(res.body, /greetUser/);
    assert.match(res.body, /Next:/);
  } finally {
    await handle.shutdown();
  }
});

test("eval-server: oversized body returns 413", async () => {
  const home = await scratch("413");
  await seedRepo(home, "demo", (g) => {
    g.addNode(funcNode("src/a.ts", "hello") as GraphNode);
  });

  const handle = await startEvalServer({
    port: 0,
    home,
    silent: true,
    testMode: true,
    idleTimeoutMs: 0,
  });
  try {
    // Build a ~1.5 MB body — comfortably above the 1 MB limit.
    const big = "x".repeat(1_500_000);
    const res = await httpRequest(`http://127.0.0.1:${handle.port}/tool/query`, {
      method: "POST",
      body: JSON.stringify({ query: big }),
    });
    assert.equal(res.status, 413);
    assert.match(res.body, /1 MB|too large/i);
  } finally {
    await handle.shutdown();
  }
});

test("eval-server: unknown tool returns 404", async () => {
  const home = await scratch("unknown");
  await seedRepo(home, "demo", (g) => {
    g.addNode(funcNode("src/a.ts", "hello") as GraphNode);
  });

  const handle = await startEvalServer({
    port: 0,
    home,
    silent: true,
    testMode: true,
    idleTimeoutMs: 0,
  });
  try {
    const res = await httpRequest(`http://127.0.0.1:${handle.port}/tool/does_not_exist`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(res.status, 404);
    assert.match(res.body, /Unknown tool/i);
  } finally {
    await handle.shutdown();
  }
});

test("eval-server: idle timeout drains and closes the server", async () => {
  const home = await scratch("idle");
  await seedRepo(home, "demo", (g) => {
    g.addNode(funcNode("src/a.ts", "hello") as GraphNode);
  });

  const handle = await startEvalServer({
    port: 0,
    home,
    silent: true,
    testMode: true,
    idleTimeoutMs: 50,
  });
  // No requests. Wait for the idle timer to fire and drain.
  await new Promise((r) => setTimeout(r, 200));
  await handle.shutdown();
  // Second health probe must fail: listener is closed.
  await assert.rejects(
    () => httpRequest(`http://127.0.0.1:${handle.port}/health`),
    /fetch failed|ECONNREFUSED/i,
  );
});

test("eval-server: POST /shutdown drains the pool", async () => {
  const home = await scratch("shutdown");
  await seedRepo(home, "demo", (g) => {
    g.addNode(funcNode("src/a.ts", "hello") as GraphNode);
  });

  const handle = await startEvalServer({
    port: 0,
    home,
    silent: true,
    testMode: true,
    idleTimeoutMs: 0,
  });

  // Exercise one tool call so the pool actually opens a store.
  await httpRequest(`http://127.0.0.1:${handle.port}/tool/list_repos`, {
    method: "POST",
    body: "{}",
  });

  const res = await httpRequest(`http://127.0.0.1:${handle.port}/shutdown`, {
    method: "POST",
  });
  assert.equal(res.status, 200);

  // Await the actual close — the handle's shutdown promise resolves when
  // the server finishes draining.
  await handle.shutdown();
  assert.equal(handle.pool.size(), 0);
});

test("buildResponseBody: passthrough + hint appendage for list_repos", () => {
  const body = buildResponseBody("list_repos", {
    structuredContent: {
      repos: [{ name: "demo", path: "/tmp/demo", indexedAt: "x", nodeCount: 1, edgeCount: 0 }],
      next_steps: [],
    },
    text: "",
  });
  assert.match(body, /demo/);
  assert.match(body, /Next:/);
});

test("buildResponseBody: empty formatter hint yields single-section output", () => {
  const body = buildResponseBody("rename", {
    structuredContent: {
      status: "applied",
      files_affected: 0,
      total_edits: 0,
      graph_edits: 0,
      text_edits: 0,
      changes: [],
    },
    text: "",
  });
  // rename emits no hint when status=applied AND no edits — only formatter text.
  assert.doesNotMatch(body, /\n\nNext:/);
});

test("buildResponseBody: unknown tool falls back to JSON.stringify", () => {
  const body = buildResponseBody("unregistered_tool", {
    structuredContent: { hello: "world" },
    text: "",
  });
  assert.match(body, /"hello": "world"/);
});

test("formatToolResult: query handles empty results", () => {
  const text = formatToolResult("query", {
    structuredContent: { results: [], processes: [], process_symbols: [], mode: "bm25" },
    text: "",
  });
  assert.match(text, /No matches/);
});

test("getNextStepHint: impact hint references top d=1 node", () => {
  const hint = getNextStepHint("impact", {
    structuredContent: {
      target: { id: "F:foo", name: "foo", kind: "Function", filePath: "src/foo.ts" },
      risk: "HIGH",
      byDepth: {
        "1": [{ name: "caller", kind: "Function", filePath: "src/caller.ts", confidence: 1 }],
      },
    },
    text: "",
  });
  assert.match(hint, /caller/);
});
