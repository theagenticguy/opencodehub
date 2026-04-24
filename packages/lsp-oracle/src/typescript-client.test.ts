import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { TypeScriptClient } from "./typescript-client.js";

/**
 * Unit tests for `TypeScriptClient`.
 *
 * These exercise two surfaces:
 *
 *   1. Pure-logic paths that require no subprocess:
 *        - per-extension `languageIdFor`
 *        - version probe reading `typescript-language-server/package.json`
 *          and `typescript/package.json`
 *
 *   2. Lifecycle + query dispatch against a scripted mock LSP server
 *      (see `mock-typescript-server.ts`). The mock answers a fixed set of
 *      requests so we can assert that `queryReferences`,
 *      `queryImplementations`, `queryCallers`, and `warmup` drive the
 *      wire as expected without needing a real tsserver.
 */

const thisFile = fileURLToPath(import.meta.url);
const thisDir = path.dirname(thisFile);
const mockServerPath = path.join(thisDir, "mock-typescript-server.js");

interface MockCallLogger {
  readonly calls: Array<{ method: string; params: unknown }>;
  attach(proc: ChildProcess): void;
}

function createMockCallLogger(): MockCallLogger {
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    calls,
    attach(proc: ChildProcess) {
      const stderr = proc.stderr;
      if (stderr === null) return;
      stderr.setEncoding("utf-8");
      let buffer = "";
      stderr.on("data", (chunk: string) => {
        buffer += chunk;
        let idx = buffer.indexOf("\n");
        while (idx !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          idx = buffer.indexOf("\n");
          const marker = "__MOCK_CALL__ ";
          if (line.startsWith(marker)) {
            try {
              const parsed = JSON.parse(line.slice(marker.length)) as {
                method: string;
                params: unknown;
              };
              calls.push(parsed);
            } catch {
              // ignore malformed lines
            }
          }
        }
      });
    },
  };
}

/**
 * Spawn a `TypeScriptClient` against the mock server and wire the call
 * logger. Returns the client plus the logger so tests can assert against
 * both. The client's `start()` is called and its process's stderr is
 * hooked before start so we don't lose early calls.
 *
 * Implementation note: `BaseLspClient` spawns its own subprocess inside
 * `start()`, so we can't attach the logger to stderr before spawn. We
 * rely on Node's I/O buffering — the mock logs synchronously right after
 * the first message is parsed, which is well after we attach below.
 */
async function withClient<T>(
  extraOpts: {
    indexWaitMs?: number;
    requestTimeoutMs?: number;
    setupFixture?: (workspaceRoot: string) => void;
  } = {},
  body: (client: TypeScriptClient, logger: MockCallLogger, tmp: string) => Promise<T>,
): Promise<T> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lsp-oracle-ts-"));
  try {
    if (extraOpts.setupFixture !== undefined) {
      extraOpts.setupFixture(tmp);
    } else {
      const tsFile = path.join(tmp, "sample.ts");
      writeFileSync(
        tsFile,
        [
          "export function target(): number {",
          "  return 42;",
          "}",
          "",
          "export function caller(): number {",
          "  return target();",
          "}",
          "",
        ].join("\n"),
      );
    }

    const logger = createMockCallLogger();
    const client = new TypeScriptClient({
      workspaceRoot: tmp,
      indexWaitMs: extraOpts.indexWaitMs ?? 200,
      requestTimeoutMs: extraOpts.requestTimeoutMs ?? 5_000,
      serverCommand: [process.execPath, mockServerPath],
    });

    // Patch the spawn path: attach logger to the subprocess after start
    // by monkey-hooking the child process via a proxy. The cleanest way
    // is to let `start()` spawn, then reach into the protected `proc`
    // field via `Object.hasOwn`. We use a typed cast for that.
    await client.start();
    const anyClient = client as unknown as { proc: ChildProcess | null };
    if (anyClient.proc !== null) {
      logger.attach(anyClient.proc);
    }
    try {
      return await body(client, logger, tmp);
    } finally {
      await client.stop();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test("TypeScriptClient: start and stop round-trip cleanly against mock", async () => {
  await withClient({}, async (client) => {
    const status = client.getStatus();
    assert.equal(status.started, true);
    assert.ok(status.coldStartMs !== null && status.coldStartMs >= 0);
  });
});

test("TypeScriptClient: languageIdFor maps each supported extension", () => {
  const client = new TypeScriptClient({
    workspaceRoot: os.tmpdir(),
    serverCommand: [process.execPath, mockServerPath],
  });
  assert.equal(client.languageIdFor("foo.ts"), "typescript");
  assert.equal(client.languageIdFor("FOO.TS"), "typescript");
  assert.equal(client.languageIdFor("foo.tsx"), "typescriptreact");
  assert.equal(client.languageIdFor("foo.d.ts"), "typescript");
  assert.equal(client.languageIdFor("foo.mts"), "typescript");
  assert.equal(client.languageIdFor("foo.cts"), "typescript");
  assert.equal(client.languageIdFor("foo.js"), "javascript");
  assert.equal(client.languageIdFor("foo.jsx"), "javascriptreact");
  assert.equal(client.languageIdFor("foo.mjs"), "javascript");
  assert.equal(client.languageIdFor("foo.cjs"), "javascript");
});

test("TypeScriptClient: queryReferences returns a mocked site", async () => {
  await withClient({}, async (client) => {
    const refs = await client.queryReferences({
      filePath: "sample.ts",
      line: 5,
      character: 10,
    });
    assert.equal(refs.length, 1);
    const only = refs[0];
    assert.ok(only !== undefined);
    assert.equal(only.file, "sample.ts");
    assert.equal(only.line, 10);
    assert.equal(only.character, 5);
  });
});

test("TypeScriptClient: queryImplementations returns a mocked site", async () => {
  await withClient({}, async (client) => {
    const impls = await client.queryImplementations({
      filePath: "sample.ts",
      line: 5,
      character: 10,
    });
    assert.equal(impls.length, 1);
    const only = impls[0];
    assert.ok(only !== undefined);
    assert.equal(only.file, "sample.ts");
    assert.equal(only.line, 20);
    assert.equal(only.character, 3);
  });
});

test("TypeScriptClient: queryCallers returns a mocked callHierarchy site", async () => {
  await withClient({}, async (client) => {
    const callers = await client.queryCallers({
      filePath: "sample.ts",
      line: 1,
      character: 17,
      symbolKind: "function",
      symbolName: "target",
    });
    assert.equal(callers.length, 1);
    const only = callers[0];
    assert.ok(only !== undefined);
    assert.equal(only.source, "callHierarchy");
    assert.equal(only.enclosingSymbolName, "caller");
    assert.equal(only.line, 30);
    assert.equal(only.character, 7);
  });
});

test("TypeScriptClient: warmup sends didOpen per file plus a dummy references query", async () => {
  await withClient({}, async (client, logger) => {
    await client.warmup(["sample.ts"]);

    const didOpens = logger.calls.filter((c) => c.method === "textDocument/didOpen");
    assert.ok(
      didOpens.length >= 1,
      `expected at least one didOpen; got ${JSON.stringify(logger.calls.map((c) => c.method))}`,
    );

    const references = logger.calls.filter((c) => c.method === "textDocument/references");
    assert.ok(references.length >= 1, "expected at least one dummy references query");
    const firstRef = references[0];
    assert.ok(firstRef !== undefined);
    const params = firstRef.params as { position?: { line?: number; character?: number } };
    assert.equal(params.position?.line, 0);
    assert.equal(params.position?.character, 0);
  });
});

test("TypeScriptClient: getStatus exposes tsserver and typescript versions", async () => {
  await withClient({}, async (client) => {
    const status = client.getStatus();
    assert.equal(status.tsserverVersion, "5.1.3");
    assert.match(status.typescriptVersion, /^\d+\.\d+\.\d+/);
  });
});

/**
 * Helper: carve out of the raw mock-call log the ordered list of
 * didOpen URIs and the interleaved references queries so tests can
 * verify batch boundaries. `textDocument/didOpen` is a notification and
 * `textDocument/references` is a request — both are logged by the mock
 * in order of arrival, which is also the wire order because `warmup`
 * awaits each send.
 */
function extractWarmupSequence(
  logger: MockCallLogger,
): Array<{ kind: "open" | "ref"; uri: string }> {
  const seq: Array<{ kind: "open" | "ref"; uri: string }> = [];
  for (const call of logger.calls) {
    if (call.method === "textDocument/didOpen") {
      const p = call.params as { textDocument?: { uri?: string } };
      const uri = p.textDocument?.uri ?? "";
      seq.push({ kind: "open", uri });
    } else if (call.method === "textDocument/references") {
      const p = call.params as { textDocument?: { uri?: string } };
      const uri = p.textDocument?.uri ?? "";
      seq.push({ kind: "ref", uri });
    }
  }
  return seq;
}

test("TypeScriptClient: warmup with files under a single tsconfig emits one batched group", async () => {
  await withClient(
    {
      setupFixture: (tmp) => {
        writeFileSync(path.join(tmp, "tsconfig.json"), "{}");
        writeFileSync(path.join(tmp, "a.ts"), "export const a = 1;\n");
        writeFileSync(path.join(tmp, "b.ts"), "export const b = 2;\n");
        writeFileSync(path.join(tmp, "c.ts"), "export const c = 3;\n");
      },
    },
    async (client, logger) => {
      await client.warmup(["a.ts", "b.ts", "c.ts"]);
      const seq = extractWarmupSequence(logger);
      const opens = seq.filter((s) => s.kind === "open");
      const refs = seq.filter((s) => s.kind === "ref");
      assert.equal(opens.length, 3, "expected 3 didOpens");
      assert.equal(refs.length, 1, "expected exactly one drain-reference (single group)");
      // All three opens should precede the single references query.
      let lastOpenIdx = -1;
      for (let i = seq.length - 1; i >= 0; i--) {
        if (seq[i]?.kind === "open") {
          lastOpenIdx = i;
          break;
        }
      }
      const firstRefIdx = seq.findIndex((s) => s.kind === "ref");
      assert.ok(
        lastOpenIdx < firstRefIdx,
        "drain-reference must come after all opens in a single-group warmup",
      );
    },
  );
});

test("TypeScriptClient: warmup with files split across two tsconfigs emits two separated batches", async () => {
  await withClient(
    {
      setupFixture: (tmp) => {
        // main/ has tsconfig.json, renderer/ has its own tsconfig.json
        const mainDir = path.join(tmp, "main");
        const rendererDir = path.join(tmp, "renderer");
        mkdtempSyncOrDir(mainDir);
        mkdtempSyncOrDir(rendererDir);
        writeFileSync(path.join(mainDir, "tsconfig.json"), "{}");
        writeFileSync(path.join(rendererDir, "tsconfig.json"), "{}");
        writeFileSync(path.join(mainDir, "m1.ts"), "export const m1 = 1;\n");
        writeFileSync(path.join(mainDir, "m2.ts"), "export const m2 = 2;\n");
        writeFileSync(path.join(rendererDir, "r1.ts"), "export const r1 = 1;\n");
        writeFileSync(path.join(rendererDir, "r2.ts"), "export const r2 = 2;\n");
      },
    },
    async (client, logger) => {
      await client.warmup(["main/m1.ts", "main/m2.ts", "renderer/r1.ts", "renderer/r2.ts"]);
      const seq = extractWarmupSequence(logger);
      const opens = seq.filter((s) => s.kind === "open");
      const refs = seq.filter((s) => s.kind === "ref");
      assert.equal(opens.length, 4, "expected 4 didOpens across two groups");
      assert.equal(refs.length, 2, "expected one drain-reference per tsconfig group");

      // Assert the wire order: all opens of one group land before the
      // first references query; then all opens of the other group land
      // before the second references query.
      const firstRefIdx = seq.findIndex((s) => s.kind === "ref");
      const secondRefIdx = seq.findIndex((s, i) => s.kind === "ref" && i > firstRefIdx);
      assert.ok(firstRefIdx > 0 && secondRefIdx > firstRefIdx);
      const firstBatchOpens = seq.slice(0, firstRefIdx).filter((s) => s.kind === "open");
      const secondBatchOpens = seq
        .slice(firstRefIdx + 1, secondRefIdx)
        .filter((s) => s.kind === "open");
      assert.equal(firstBatchOpens.length, 2, "first batch should hold 2 files");
      assert.equal(secondBatchOpens.length, 2, "second batch should hold 2 files");

      // Both batches should be URI-homogeneous (all /main/ or all /renderer/).
      const firstDir = uriDir(firstBatchOpens[0]?.uri ?? "");
      const secondDir = uriDir(secondBatchOpens[0]?.uri ?? "");
      assert.notEqual(firstDir, secondDir, "the two batches must not share a tsconfig dir");
      for (const open of firstBatchOpens) {
        assert.equal(uriDir(open.uri), firstDir, "first batch mixed groups");
      }
      for (const open of secondBatchOpens) {
        assert.equal(uriDir(open.uri), secondDir, "second batch mixed groups");
      }
    },
  );
});

test("TypeScriptClient: warmup honors tsconfig references field — referenced project opened first", async () => {
  await withClient(
    {
      setupFixture: (tmp) => {
        const sharedDir = path.join(tmp, "shared");
        const appDir = path.join(tmp, "app");
        mkdtempSyncOrDir(sharedDir);
        mkdtempSyncOrDir(appDir);
        writeFileSync(path.join(sharedDir, "tsconfig.json"), "{}");
        writeFileSync(
          path.join(appDir, "tsconfig.json"),
          JSON.stringify({ references: [{ path: "../shared" }] }),
        );
        writeFileSync(path.join(sharedDir, "s.ts"), "export const s = 1;\n");
        writeFileSync(path.join(appDir, "a.ts"), "export const a = 1;\n");
      },
    },
    async (client, logger) => {
      // Intentionally pass the referrer's file first to prove that
      // dependency order — not input order — wins.
      await client.warmup(["app/a.ts", "shared/s.ts"]);
      const seq = extractWarmupSequence(logger);
      const opens = seq.filter((s) => s.kind === "open");
      assert.equal(opens.length, 2);
      // `shared/s.ts` must appear before `app/a.ts` in the wire order.
      const sIdx = opens.findIndex((o) => o.uri.endsWith("/shared/s.ts"));
      const aIdx = opens.findIndex((o) => o.uri.endsWith("/app/a.ts"));
      assert.ok(sIdx !== -1 && aIdx !== -1, "both files must have been opened");
      assert.ok(sIdx < aIdx, "shared must be warmed before the project that references it");
    },
  );
});

test("TypeScriptClient: warmup with a reference cycle terminates without duplicate opens", async () => {
  await withClient(
    {
      setupFixture: (tmp) => {
        const aDir = path.join(tmp, "a");
        const bDir = path.join(tmp, "b");
        mkdtempSyncOrDir(aDir);
        mkdtempSyncOrDir(bDir);
        writeFileSync(
          path.join(aDir, "tsconfig.json"),
          JSON.stringify({ references: [{ path: "../b" }] }),
        );
        writeFileSync(
          path.join(bDir, "tsconfig.json"),
          JSON.stringify({ references: [{ path: "../a" }] }),
        );
        writeFileSync(path.join(aDir, "af.ts"), "export const af = 1;\n");
        writeFileSync(path.join(bDir, "bf.ts"), "export const bf = 1;\n");
      },
    },
    async (client, logger) => {
      await client.warmup(["a/af.ts", "b/bf.ts"]);
      const seq = extractWarmupSequence(logger);
      const openUris = seq.filter((s) => s.kind === "open").map((s) => s.uri);
      const unique = new Set(openUris);
      assert.equal(openUris.length, 2, "expected exactly 2 opens — no duplicates from cycle");
      assert.equal(unique.size, 2, "every open URI should be unique across the cycle");
    },
  );
});

test("TypeScriptClient: warmup handles files lacking any tsconfig as an inferred-project bucket last", async () => {
  await withClient(
    {
      setupFixture: (tmp) => {
        const appDir = path.join(tmp, "app");
        mkdtempSyncOrDir(appDir);
        writeFileSync(path.join(appDir, "tsconfig.json"), "{}");
        writeFileSync(path.join(appDir, "a.ts"), "export const a = 1;\n");
        // Orphan file — lives at the workspace root with NO tsconfig
        // between it and /. On Darwin /var/folders/.../T/lsp-oracle-ts-*
        // has no ancestor tsconfig so this genuinely hits the inferred
        // branch.
        writeFileSync(path.join(tmp, "orphan.ts"), "export const orphan = 1;\n");
      },
    },
    async (client, logger) => {
      await client.warmup(["orphan.ts", "app/a.ts"]);
      const seq = extractWarmupSequence(logger);
      const opens = seq.filter((s) => s.kind === "open");
      const refs = seq.filter((s) => s.kind === "ref");
      assert.equal(opens.length, 2);
      assert.equal(refs.length, 2, "one drain per bucket (tsconfig + inferred)");

      // Inferred bucket must be opened AFTER all tsconfig-bound buckets
      // are drained: orphan.ts must appear after the first references.
      const orphanIdx = seq.findIndex((s) => s.kind === "open" && s.uri.endsWith("/orphan.ts"));
      const firstRefIdx = seq.findIndex((s) => s.kind === "ref");
      assert.ok(
        orphanIdx > firstRefIdx,
        "orphan.ts (inferred-project bucket) must be opened after the tsconfig-bucket drain",
      );
    },
  );
});

test("TypeScriptClient: warmup with a malformed tsconfig continues without throwing", async () => {
  await withClient(
    {
      setupFixture: (tmp) => {
        const appDir = path.join(tmp, "app");
        const libDir = path.join(tmp, "lib");
        mkdtempSyncOrDir(appDir);
        mkdtempSyncOrDir(libDir);
        // appDir has a tsconfig pointing at ../lib with a malformed body
        // (unterminated string) — parse should fail, references reduce to
        // empty, and the warmup should proceed with that bucket anyway.
        writeFileSync(path.join(appDir, "tsconfig.json"), '{ "references": [{ "path": "../lib" } ');
        writeFileSync(path.join(libDir, "tsconfig.json"), "{}");
        writeFileSync(path.join(appDir, "a.ts"), "export const a = 1;\n");
        writeFileSync(path.join(libDir, "l.ts"), "export const l = 1;\n");
      },
    },
    async (client, logger) => {
      await client.warmup(["app/a.ts", "lib/l.ts"]);
      const seq = extractWarmupSequence(logger);
      const opens = seq.filter((s) => s.kind === "open");
      assert.equal(
        opens.length,
        2,
        "both files must still be opened after malformed-tsconfig warn",
      );
    },
  );
});

/**
 * `fs.mkdirSync` with `recursive: true` is the directory mirror of the
 * existing `mkdtempSync` helper — we only need it to create the nested
 * fixture dirs. Named to stay consistent with the file's existing
 * `mkdtempSync` import convention.
 */
function mkdtempSyncOrDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function uriDir(uri: string): string {
  try {
    return path.dirname(new URL(uri).pathname);
  } catch {
    return "";
  }
}
