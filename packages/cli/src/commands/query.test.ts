/**
 * Tests for `codehub query` CLI command — the P1-5 parity surface.
 *
 * Coverage mirrors the MCP-side tests one-for-one so CLI and MCP stay at
 * parity: `--context` / `--goal` prefix the search text, `--content`
 * attaches the symbol body, absent flags leave the search text untouched.
 *
 * The suite intercepts `openStoreForCommand` via a module-level substitution
 * so we never need to spin up a real DuckDB handle — the search surface is
 * already covered by the storage package. What we validate here is the
 * CLI-layer plumbing:
 *   1. `--context` is prefixed with the em-dash separator.
 *   2. `--goal` is prefixed with the em-dash separator.
 *   3. Both together keep order `context — goal — text`.
 *   4. Neither flag leaves the text untouched.
 *   5. `--content` reads the file and attaches a capped body.
 *   6. `--content` silently omits the field when the file is missing.
 *   7. `--content` caps long files at 2000 chars with an ellipsis.
 *   8. `--max-symbols` is accepted through the type surface (no-op MVP).
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { DuckDbStore, SearchQuery, SearchResult } from "@opencodehub/storage";
import { runQuery } from "./query.js";

interface FakeStoreHandle {
  lastQuery: string | null;
  searchCalls: number;
  closed: boolean;
  readonly store: DuckDbStore;
}

function makeFakeStore(rows: readonly SearchResult[]): FakeStoreHandle {
  const handle: FakeStoreHandle = {
    lastQuery: null,
    searchCalls: 0,
    closed: false,
    store: {} as DuckDbStore,
  };
  // Minimal DuckDbStore surface: the CLI query path only calls `search` and
  // `close`, so we stub those and cast the rest. Keeps the fake narrow.
  const impl = {
    search: async (q: SearchQuery) => {
      handle.lastQuery = q.text;
      handle.searchCalls += 1;
      return rows;
    },
    close: async () => {
      handle.closed = true;
    },
  } as unknown as DuckDbStore;
  (handle as { store: DuckDbStore }).store = impl;
  return handle;
}

/** Capture console.log output during `fn`. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const orig = console.log;
  const chunks: string[] = [];
  console.log = (...args: unknown[]) => {
    chunks.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return chunks.join("\n");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** Build a `hooks` value that returns the fake store for any `runQuery` call. */
function hooksFor(handle: FakeStoreHandle, repoPath: string) {
  return {
    openStore: async () => ({ store: handle.store, repoPath }),
  };
}

test("cli query: --context is prefixed to the search text", async () => {
  const handle = makeFakeStore([
    { nodeId: "F:foo", score: 2, filePath: "src/foo.ts", name: "foo", kind: "Function" },
  ]);
  await captureStdout(async () => {
    await runQuery(
      "validate user",
      { context: "adding OAuth support" },
      hooksFor(handle, "/tmp/fake"),
    );
  });
  assert.equal(handle.lastQuery, "adding OAuth support — validate user");
});

test("cli query: --goal is prefixed to the search text", async () => {
  const handle = makeFakeStore([
    { nodeId: "F:foo", score: 2, filePath: "src/foo.ts", name: "foo", kind: "Function" },
  ]);
  await captureStdout(async () => {
    await runQuery(
      "validate user",
      { goal: "find the auth entry point" },
      hooksFor(handle, "/tmp/fake"),
    );
  });
  assert.equal(handle.lastQuery, "find the auth entry point — validate user");
});

test("cli query: --context + --goal are both prefixed in declared order", async () => {
  const handle = makeFakeStore([
    { nodeId: "F:foo", score: 2, filePath: "src/foo.ts", name: "foo", kind: "Function" },
  ]);
  await captureStdout(async () => {
    await runQuery(
      "validate user",
      {
        context: "adding OAuth support",
        goal: "existing auth validation logic",
      },
      hooksFor(handle, "/tmp/fake"),
    );
  });
  assert.equal(
    handle.lastQuery,
    "adding OAuth support — existing auth validation logic — validate user",
  );
});

test("cli query: without --context/--goal the search text is untouched", async () => {
  const handle = makeFakeStore([
    { nodeId: "F:foo", score: 2, filePath: "src/foo.ts", name: "foo", kind: "Function" },
  ]);
  await captureStdout(async () => {
    await runQuery("validate user", {}, hooksFor(handle, "/tmp/fake"));
  });
  assert.equal(handle.lastQuery, "validate user");
});

test("cli query: --content attaches the file body to each JSON result", async () => {
  const home = await mkdtemp(join(tmpdir(), "och-cli-query-"));
  try {
    const repoPath = resolve(home, "repo");
    const fileRel = "src/foo.ts";
    const fileAbs = resolve(repoPath, fileRel);
    await mkdir(resolve(repoPath, "src"), { recursive: true });
    await writeFile(fileAbs, "export function foo() { return 42; }\n", "utf8");
    const handle = makeFakeStore([
      { nodeId: "F:foo", score: 2, filePath: fileRel, name: "foo", kind: "Function" },
    ]);
    const stdout = await captureStdout(async () => {
      await runQuery("foo", { content: true, json: true }, hooksFor(handle, repoPath));
    });
    const parsed = JSON.parse(stdout) as {
      results: Array<{ content?: string; name: string }>;
    };
    assert.equal(parsed.results[0]?.name, "foo");
    assert.ok(
      parsed.results[0]?.content?.includes("export function foo"),
      "content must include the file source",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("cli query: --content silently omits the field when the file is missing", async () => {
  const home = await mkdtemp(join(tmpdir(), "och-cli-query-"));
  try {
    const repoPath = resolve(home, "repo");
    await mkdir(repoPath, { recursive: true });
    const handle = makeFakeStore([
      {
        nodeId: "F:gone",
        score: 2,
        filePath: "src/deleted.ts",
        name: "gone",
        kind: "Function",
      },
    ]);
    const stdout = await captureStdout(async () => {
      await runQuery("gone", { content: true, json: true }, hooksFor(handle, repoPath));
    });
    const parsed = JSON.parse(stdout) as {
      results: Array<{ content?: string }>;
    };
    assert.equal(
      parsed.results[0]?.content,
      undefined,
      "content must be omitted when the source file is unreadable",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("cli query: --content caps long files at 2000 chars with an ellipsis", async () => {
  const home = await mkdtemp(join(tmpdir(), "och-cli-query-"));
  try {
    const repoPath = resolve(home, "repo");
    const fileRel = "src/big.ts";
    const fileAbs = resolve(repoPath, fileRel);
    await mkdir(resolve(repoPath, "src"), { recursive: true });
    // 3000-char file — safely past the 2000 cap.
    await writeFile(fileAbs, "x".repeat(3000), "utf8");
    const handle = makeFakeStore([
      { nodeId: "F:big", score: 2, filePath: fileRel, name: "big", kind: "Function" },
    ]);
    const stdout = await captureStdout(async () => {
      await runQuery("big", { content: true, json: true }, hooksFor(handle, repoPath));
    });
    const parsed = JSON.parse(stdout) as {
      results: Array<{ content?: string }>;
    };
    const body = parsed.results[0]?.content ?? "";
    assert.ok(body.length <= 2000, `content must be ≤2000 chars; got ${body.length}`);
    assert.ok(body.endsWith("…"), "truncation ellipsis expected when the cap hits");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("cli query: --max-symbols is accepted without error (MVP no-op)", async () => {
  // The CLI surface forwards --max-symbols for MCP parity; the store's
  // `search()` is not process-aware today, so the flag is a no-op. The
  // invariant tested here is that the surface compiles and runs green when
  // the option is supplied.
  const handle = makeFakeStore([
    { nodeId: "F:foo", score: 2, filePath: "src/foo.ts", name: "foo", kind: "Function" },
  ]);
  await captureStdout(async () => {
    await runQuery("foo", { maxSymbols: 3 }, hooksFor(handle, "/tmp/fake"));
  });
  assert.equal(handle.searchCalls, 1);
  assert.equal(handle.closed, true, "store.close() must run even on no-op flags");
});
