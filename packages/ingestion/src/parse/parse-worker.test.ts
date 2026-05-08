/**
 * parse-worker dispatch tests.
 *
 * Exercises the runtime-selection logic in parse-worker.ts:
 *   (a) OCH_NATIVE_PARSER unset                       → WASM path, WASM warning
 *   (b) OCH_NATIVE_PARSER=1 AND native available      → native path, native warning
 *   (c) OCH_NATIVE_PARSER=1 AND native unavailable    → WASM fallback, mismatch warning
 *   (d) OCH_NATIVE_PARSER explicitly =0               → WASM path (regression: must not count "0" as truthy)
 *
 * Observability strategy: the startup warning emitted on the FIRST
 * `parseBatch` call in each fresh worker is the only externally visible
 * signal that names the runtime. We capture the line written to
 * `process.stderr` during a single `parseBatch([])` invocation and assert
 * on it — this proves both the dispatch direction AND the EARS
 * requirement that a startup warning fires for BOTH runtimes.
 *
 * The `warnedRuntime` module-global means each test case must load the
 * module fresh; we do that with `import(`${modulePath}?v=…`)` query
 * cache-busting so node-test resolves a new module instance per test.
 */

import { strict as assert } from "node:assert";
import { Buffer } from "node:buffer";
import { Module } from "node:module";
import { describe, it } from "node:test";
import type { ParseBatch, ParseResult } from "./types.js";

type ParseBatchFn = (batch: ParseBatch) => Promise<ParseResult[]>;

interface ParseWorkerModule {
  default: ParseBatchFn;
}

interface WasmFallbackModule {
  isNativeAvailable(): boolean;
  resetNativeAvailabilityCache(): void;
  openWasmParser: typeof import("./wasm-fallback.js")["openWasmParser"];
  _resetWasmCacheForTests(): void;
}

const parseWorkerUrl = new URL("./parse-worker.js", import.meta.url).href;
const wasmFallbackUrl = new URL("./wasm-fallback.js", import.meta.url).href;

/**
 * Dynamically import a fresh `parse-worker.js` module instance so its
 * module-globals (`warnedRuntime`) reset between tests. The query-string
 * `?v=…` tag forces node's ESM loader to create a new module record.
 */
async function loadParseWorker(tag: string): Promise<ParseBatchFn> {
  const mod = (await import(`${parseWorkerUrl}?v=${tag}`)) as ParseWorkerModule;
  return mod.default;
}

async function loadWasmFallback(tag: string): Promise<WasmFallbackModule> {
  return (await import(`${wasmFallbackUrl}?v=${tag}`)) as WasmFallbackModule;
}

/**
 * Run `fn` with stderr captured into a string. Restores `process.stderr.write`
 * on both success and failure. We install the shim synchronously but await
 * `fn` under it so any async writes during the awaited work are captured.
 */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  // Override with a function that records then no-ops. `parseBatch` only
  // ever writes complete strings to stderr, so we don't bother routing
  // the arguments through to the original stream — this keeps test
  // output clean on the `node --test` console.
  process.stderr.write = ((chunk: string | Uint8Array) => {
    const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    chunks.push(s);
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join("");
}

/**
 * Save + clear + restore the `OCH_NATIVE_PARSER` env var. We cannot just
 * delete it because tests run in parallel in node:test when `--test` is
 * passed with multiple workers; we take the pragmatic approach of
 * serializing these tests (describe with single it blocks) and restoring
 * on finally.
 */
function setEnv(value: string | undefined): string | undefined {
  const prior = process.env["OCH_NATIVE_PARSER"];
  if (value === undefined) {
    delete process.env["OCH_NATIVE_PARSER"];
  } else {
    process.env["OCH_NATIVE_PARSER"] = value;
  }
  return prior;
}

function restoreEnv(prior: string | undefined): void {
  if (prior === undefined) {
    delete process.env["OCH_NATIVE_PARSER"];
  } else {
    process.env["OCH_NATIVE_PARSER"] = prior;
  }
}

describe("parse-worker runtime dispatch", () => {
  it("(a) env unset → WASM path; startup warning names WASM", async () => {
    const priorEnv = setEnv(undefined);
    try {
      const parseBatch = await loadParseWorker("case-a");
      const stderr = await captureStderr(async () => {
        // Empty batch exercises the startup-warning path without needing
        // a real grammar load.
        await parseBatch({ tasks: [] });
      });
      assert.match(
        stderr,
        /using web-tree-sitter \(WASM\) runtime/,
        `expected WASM startup warning; got: ${JSON.stringify(stderr)}`,
      );
      assert.doesNotMatch(
        stderr,
        /native \(N-API\) runtime/,
        `native runtime should NOT be named when env is unset`,
      );
    } finally {
      restoreEnv(priorEnv);
    }
  });

  it("(b) env=1 + native available → native path; startup warning names native", async (t) => {
    // Probe native availability via a fresh wasm-fallback module — if the
    // host can't load `tree-sitter`, we can't meaningfully test the
    // native branch. Skip in that case rather than marking the suite
    // failed (parity test uses the same convention).
    const probe = await loadWasmFallback("case-b-probe");
    if (!probe.isNativeAvailable()) {
      t.skip("native tree-sitter binding not loadable on this host");
      return;
    }

    const priorEnv = setEnv("1");
    try {
      const parseBatch = await loadParseWorker("case-b");
      const stderr = await captureStderr(async () => {
        await parseBatch({ tasks: [] });
      });
      assert.match(
        stderr,
        /using tree-sitter native \(N-API\) runtime/,
        `expected native startup warning; got: ${JSON.stringify(stderr)}`,
      );
      assert.doesNotMatch(
        stderr,
        /using web-tree-sitter \(WASM\) runtime/,
        `WASM runtime should NOT be named when native is picked`,
      );
    } finally {
      restoreEnv(priorEnv);
    }
  });

  it("(c) env=1 + native unavailable → WASM fallback + mismatch warning", async () => {
    // Simulate "native unavailable" by poisoning CommonJS
    // `Module._resolveFilename` so any `require('tree-sitter')` (used
    // inside `isNativeAvailable()`) throws. We also purge any cached
    // copy of tree-sitter from `require.cache` — node short-circuits
    // `_resolveFilename` when the module is already cached by its
    // resolved absolute path, so a prior test that loaded it would
    // otherwise defeat our patch.
    //
    // We wrap the whole flow in try/finally to guarantee the patches
    // are reverted even on assertion failure — a stuck patch would
    // break every subsequent test that imports tree-sitter.
    // `Module._resolveFilename` is a documented-internal CommonJS hook —
    // it has no type in @types/node, so we widen to a loose shape.
    const ModuleCjs = Module as unknown as {
      _resolveFilename: (request: string, parent: unknown, ...rest: unknown[]) => string;
      _cache?: Record<string, unknown>;
    };
    const originalResolveFilename = ModuleCjs._resolveFilename;

    // Purge every tree-sitter-* entry from require.cache so the next
    // require() call goes back through _resolveFilename.
    const savedCacheEntries: Array<[string, unknown]> = [];
    if (ModuleCjs._cache !== undefined) {
      for (const key of Object.keys(ModuleCjs._cache)) {
        if (key.includes("tree-sitter")) {
          savedCacheEntries.push([key, ModuleCjs._cache[key]]);
          delete ModuleCjs._cache[key];
        }
      }
    }

    ModuleCjs._resolveFilename = function patched(
      this: unknown,
      request: string,
      parent: unknown,
      ...rest: unknown[]
    ): string {
      if (request === "tree-sitter") {
        throw new Error("Cannot find module 'tree-sitter' (simulated by parse-worker.test.ts)");
      }
      return originalResolveFilename.call(this, request, parent, ...rest);
    } as typeof ModuleCjs._resolveFilename;

    const priorEnv = setEnv("1");
    try {
      // Reset isNativeAvailable's cache on EVERY wasm-fallback module
      // instance the parse-worker could import. Each `?v=…` tagged load
      // above created a fresh module with its own `cached` state; we
      // need to hit the exact one parse-worker imports (the untagged
      // URL). We also reset every tagged one we previously loaded so
      // they can't leak a `true` back in when loaded again below.
      const untagged = (await import(wasmFallbackUrl)) as WasmFallbackModule;
      untagged.resetNativeAvailabilityCache();

      const parseBatch = await loadParseWorker("case-c-worker");
      const stderr = await captureStderr(async () => {
        await parseBatch({ tasks: [] });
      });
      assert.match(
        stderr,
        /OCH_NATIVE_PARSER=1 set but native tree-sitter unavailable; falling back to web-tree-sitter \(WASM\) runtime/,
        `expected fallback warning; got: ${JSON.stringify(stderr)}`,
      );
      assert.doesNotMatch(
        stderr,
        /using tree-sitter native \(N-API\) runtime/,
        `native runtime must NOT be claimed when the addon is unavailable`,
      );
    } finally {
      ModuleCjs._resolveFilename = originalResolveFilename;
      // Restore the previously-cached tree-sitter entries so downstream
      // tests don't pay the full addon re-load cost.
      if (ModuleCjs._cache !== undefined) {
        for (const [key, value] of savedCacheEntries) {
          ModuleCjs._cache[key] = value;
        }
      }
      restoreEnv(priorEnv);
      // Reset detection cache so subsequent tests re-probe under the
      // real (unpatched) resolver.
      const untaggedRestore = (await import(wasmFallbackUrl)) as WasmFallbackModule;
      untaggedRestore.resetNativeAvailabilityCache();
    }
  });

  it("(d) env=0 → WASM path (regression: '0' must not be treated as truthy)", async () => {
    const priorEnv = setEnv("0");
    try {
      const parseBatch = await loadParseWorker("case-d");
      const stderr = await captureStderr(async () => {
        await parseBatch({ tasks: [] });
      });
      assert.match(
        stderr,
        /using web-tree-sitter \(WASM\) runtime/,
        `OCH_NATIVE_PARSER=0 should behave as unset; got: ${JSON.stringify(stderr)}`,
      );
      assert.doesNotMatch(stderr, /native \(N-API\) runtime/, `"0" is not a truthy opt-in value`);
    } finally {
      restoreEnv(priorEnv);
    }
  });

  it("startup warning fires exactly once per worker module instance", async () => {
    const priorEnv = setEnv(undefined);
    try {
      const parseBatch = await loadParseWorker("case-oneshot");
      // First call emits the warning.
      const first = await captureStderr(async () => {
        await parseBatch({ tasks: [] });
      });
      // Second call on the same module instance must NOT re-emit.
      const second = await captureStderr(async () => {
        await parseBatch({ tasks: [] });
      });
      assert.match(first, /using web-tree-sitter \(WASM\) runtime/);
      assert.equal(second, "", `second invocation must be silent; got: ${JSON.stringify(second)}`);
    } finally {
      restoreEnv(priorEnv);
    }
  });
});
