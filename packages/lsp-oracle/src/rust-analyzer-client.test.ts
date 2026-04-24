import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  parseRustAnalyzerVersion,
  RustAnalyzerClient,
  type RustAnalyzerClientOptions,
} from "./rust-analyzer-client.js";

/**
 * Unit-level coverage for RustAnalyzerClient. The mock server handles
 * the LSP wire so none of these tests shell out to a real rust-analyzer.
 *
 * The mock responds to `MOCK_RA_*` env flags to control priming behavior
 * — see `mock-rust-analyzer-server.ts`.
 */

const thisFile = fileURLToPath(import.meta.url);
const thisDir = path.dirname(thisFile);
const mockServerPath = path.join(thisDir, "mock-rust-analyzer-server.js");

// Expose a few protected members for unit inspection without the tests
// leaking into production types.
class TestableRustAnalyzerClient extends RustAnalyzerClient {
  public serverCommandForTest(): { cmd: string; args: readonly string[] } {
    return this.serverCommand();
  }
  public languageIdForTest(): string {
    return this.languageId();
  }
  public initializationOptionsForTest(): Record<string, unknown> {
    return this.initializationOptions();
  }
  public onBeforeStartForTest(): void | Promise<void> {
    return this.onBeforeStart();
  }
}

function mkWorkspace(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

interface EnvPatch {
  restore(): void;
}

function patchEnv(env: Record<string, string>): EnvPatch {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  return {
    restore(): void {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }
    },
  };
}

function newMockClient(
  tmp: string,
  extra: Partial<RustAnalyzerClientOptions> = {},
): RustAnalyzerClient {
  return new RustAnalyzerClient({
    workspaceRoot: tmp,
    indexWaitMs: 200,
    requestTimeoutMs: 5_000,
    serverCommand: [process.execPath, mockServerPath],
    ...extra,
  });
}

test("RustAnalyzerClient.serverCommand defaults to `rust-analyzer`", () => {
  const tmp = mkWorkspace("lsp-oracle-ra-");
  try {
    const client = new TestableRustAnalyzerClient({ workspaceRoot: tmp });
    const resolved = client.serverCommandForTest();
    assert.equal(resolved.cmd, "rust-analyzer");
    assert.deepEqual([...resolved.args], []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("RustAnalyzerClient.serverCommand honors the serverCommand override", () => {
  const tmp = mkWorkspace("lsp-oracle-ra-");
  try {
    const client = new TestableRustAnalyzerClient({
      workspaceRoot: tmp,
      serverCommand: [process.execPath, mockServerPath],
    });
    const resolved = client.serverCommandForTest();
    assert.equal(resolved.cmd, process.execPath);
    assert.deepEqual([...resolved.args], [mockServerPath]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("RustAnalyzerClient.languageId is always 'rust'", () => {
  const tmp = mkWorkspace("lsp-oracle-ra-");
  try {
    const client = new TestableRustAnalyzerClient({ workspaceRoot: tmp });
    assert.equal(client.languageIdForTest(), "rust");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("RustAnalyzerClient.initializationOptions disables procMacro by default", () => {
  const tmp = mkWorkspace("lsp-oracle-ra-");
  try {
    const client = new TestableRustAnalyzerClient({ workspaceRoot: tmp });
    const opts = client.initializationOptionsForTest();
    const procMacro = opts["procMacro"] as {
      enable?: boolean;
      attributes?: { enable?: boolean };
    };
    assert.equal(procMacro.enable, false);
    assert.equal(procMacro.attributes?.enable, false);
    const cargo = opts["cargo"] as {
      buildScripts?: { enable?: boolean };
      noDeps?: boolean;
    };
    assert.equal(cargo.buildScripts?.enable, false);
    assert.equal(cargo.noDeps, true);
    assert.equal(opts["checkOnSave"], false);
    const diagnostics = opts["diagnostics"] as { enable?: boolean };
    assert.equal(diagnostics.enable, false);
    const cachePriming = opts["cachePriming"] as { enable?: boolean };
    assert.equal(cachePriming.enable, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("RustAnalyzerClient.initializationOptions flips procMacro when enableProcMacro=true", () => {
  const tmp = mkWorkspace("lsp-oracle-ra-");
  try {
    const client = new TestableRustAnalyzerClient({
      workspaceRoot: tmp,
      enableProcMacro: true,
    });
    const opts = client.initializationOptionsForTest();
    const procMacro = opts["procMacro"] as {
      enable?: boolean;
      attributes?: { enable?: boolean };
    };
    assert.equal(procMacro.enable, true);
    assert.equal(procMacro.attributes?.enable, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("RustAnalyzerClient.onBeforeStart throws a clear install hint when rust-analyzer is missing", async () => {
  const tmp = mkWorkspace("lsp-oracle-ra-");
  const originalPath = process.env["PATH"];
  try {
    process.env["PATH"] = tmp;
    const client = new TestableRustAnalyzerClient({ workspaceRoot: tmp });
    await assert.rejects(
      async () => {
        await client.onBeforeStartForTest();
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /rust-analyzer not on PATH/);
        assert.match(err.message, /rustup component add rust-analyzer/);
        return true;
      },
    );
  } finally {
    if (originalPath !== undefined) {
      process.env["PATH"] = originalPath;
    } else {
      process.env["PATH"] = undefined;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("RustAnalyzerClient.start + stop round-trip against mock server", async () => {
  const tmp = mkWorkspace("lsp-oracle-ra-");
  try {
    const client = newMockClient(tmp);
    await client.start();
    const status = client.getStatus();
    assert.equal(status.started, true);
    assert.equal(status.workspaceRoot, path.resolve(tmp));
    // rustAnalyzerVersion stays null when a mock-server override is active.
    assert.equal(status.rustAnalyzerVersion, null);
    assert.equal(status.procMacroEnabled, false);
    await client.stop();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("RustAnalyzerClient.queryReferences maps mock response to 1-indexed sites", async () => {
  const tmp = mkWorkspace("lsp-oracle-ra-");
  try {
    const rsFile = path.join(tmp, "lib.rs");
    writeFileSync(
      rsFile,
      [
        "pub fn target_fn(x: i32) -> i32 {",
        "    x + 1",
        "}",
        "",
        "pub fn caller() {",
        "    let _ = target_fn(1);",
        "}",
        "",
      ].join("\n"),
    );
    const client = newMockClient(tmp);
    await client.start();
    try {
      const refs = await client.queryReferences({
        filePath: "lib.rs",
        line: 1,
        character: 8,
      });
      assert.equal(refs.length, 1);
      const only = refs[0];
      assert.ok(only !== undefined);
      // Mock returns line 7 / char 4 (0-indexed) → 8 / 5 (1-indexed).
      assert.equal(only.line, 8);
      assert.equal(only.character, 5);
      assert.equal(only.file, "lib.rs");
    } finally {
      await client.stop();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("RustAnalyzerClient.queryImplementations maps mock response to 1-indexed sites", async () => {
  const tmp = mkWorkspace("lsp-oracle-ra-");
  try {
    const rsFile = path.join(tmp, "trait.rs");
    writeFileSync(
      rsFile,
      ["pub trait Greeter {", "    fn greet(&self) -> String;", "}", ""].join("\n"),
    );
    const client = newMockClient(tmp);
    await client.start();
    try {
      const impls = await client.queryImplementations({
        filePath: "trait.rs",
        line: 1,
        character: 11,
      });
      assert.equal(impls.length, 1);
      const only = impls[0];
      assert.ok(only !== undefined);
      // Mock returns line 10 / char 4 (0-indexed) → 11 / 5 (1-indexed).
      assert.equal(only.line, 11);
      assert.equal(only.character, 5);
      assert.equal(only.file, "trait.rs");
    } finally {
      await client.stop();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("RustAnalyzerClient.queryCallers returns callHierarchy-sourced sites from mock", async () => {
  const tmp = mkWorkspace("lsp-oracle-ra-");
  try {
    const rsFile = path.join(tmp, "lib.rs");
    writeFileSync(
      rsFile,
      [
        "pub fn target_fn(x: i32) -> i32 {",
        "    x + 1",
        "}",
        "",
        "pub fn caller() {",
        "    let _ = target_fn(1);",
        "}",
        "",
      ].join("\n"),
    );
    const client = newMockClient(tmp);
    await client.start();
    try {
      const callers = await client.queryCallers({
        filePath: "lib.rs",
        line: 1,
        character: 8,
        symbolKind: "function",
        symbolName: "target_fn",
      });
      assert.equal(callers.length, 1);
      const only = callers[0];
      assert.ok(only !== undefined);
      assert.equal(only.source, "callHierarchy");
      assert.equal(only.enclosingSymbolName, "caller_fn");
      // Mock returns line 15 / char 4 (0-indexed) → 16 / 5 (1-indexed).
      assert.equal(only.line, 16);
      assert.equal(only.character, 5);
      assert.equal(only.file, "lib.rs");
    } finally {
      await client.stop();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("RustAnalyzerClient.warmup resolves once the mock emits cachePriming END", async () => {
  const tmp = mkWorkspace("lsp-oracle-ra-");
  try {
    const client = newMockClient(tmp);
    await client.start();
    try {
      await client.warmup(2_000);
      // If start()'s own waitForIndexingEnd already elapsed, warmup()
      // must also be resolved.
      const status = client.getStatus();
      assert.equal(status.indexingComplete, true);
    } finally {
      await client.stop();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("RustAnalyzerClient.warmup rejects after timeoutMs when priming never completes", async () => {
  const tmp = mkWorkspace("lsp-oracle-ra-");
  // Mock is instructed to suppress the priming progress emission. The
  // base class's indexWaitMs ceiling still lets `start()` return (with
  // a stderr warning), but cachePriming-end is never seen, so
  // `warmup()` must hit its timeout path. The env must be set BEFORE
  // we spawn the mock — the child inherits process.env at spawn time.
  const envPatch = patchEnv({ MOCK_RA_SUPPRESS_PRIMING: "1" });
  try {
    const client = newMockClient(tmp);
    await client.start();
    try {
      await assert.rejects(
        async () => {
          await client.warmup(150);
        },
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /cache priming did not complete within 150ms/);
          return true;
        },
      );
    } finally {
      await client.stop();
    }
  } finally {
    envPatch.restore();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("parseRustAnalyzerVersion extracts the semver-ish tail from `rust-analyzer --version`", () => {
  assert.equal(
    parseRustAnalyzerVersion("rust-analyzer 0.4.2514-standalone\n"),
    "0.4.2514-standalone",
  );
  assert.equal(parseRustAnalyzerVersion("rust-analyzer 1.0.0"), "1.0.0");
  assert.equal(parseRustAnalyzerVersion("not the right line\n"), null);
  assert.equal(parseRustAnalyzerVersion(""), null);
});
