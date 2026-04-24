import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { GoplsClient } from "./gopls-client.js";

const thisFile = fileURLToPath(import.meta.url);
const thisDir = path.dirname(thisFile);
const mockServerPath = path.join(thisDir, "mock-gopls-server.js");

class TestableGoplsClient extends GoplsClient {
  public serverCommandForTest(): { cmd: string; args: readonly string[] } {
    return this.serverCommand();
  }
  public languageIdForTest(): string {
    return this.languageId();
  }
  public onBeforeStartForTest(): Promise<void> | void {
    return this.onBeforeStart();
  }
  public parseVersionForTest(stdout: string): string | null {
    const m = /v(\d+\.\d+\.\d+[^\s]*)/.exec(stdout);
    return m?.[1] ?? null;
  }
}

test("GoplsClient.serverCommand defaults to `gopls -mode=stdio`", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lsp-oracle-gopls-"));
  try {
    const client = new TestableGoplsClient({ workspaceRoot: tmp });
    const resolved = client.serverCommandForTest();
    assert.equal(resolved.cmd, "gopls");
    assert.deepEqual([...resolved.args], ["-mode=stdio"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("GoplsClient.serverCommand honors the serverCommand override", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lsp-oracle-gopls-"));
  try {
    const client = new TestableGoplsClient({
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

test("GoplsClient.languageId is always 'go'", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lsp-oracle-gopls-"));
  try {
    const client = new TestableGoplsClient({ workspaceRoot: tmp });
    assert.equal(client.languageIdForTest(), "go");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("GoplsClient.onBeforeStart throws a clear install hint when gopls is missing", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lsp-oracle-gopls-"));
  const originalPath = process.env["PATH"];
  try {
    // Point PATH at an empty tempdir so `which gopls` fails.
    process.env["PATH"] = tmp;
    const client = new TestableGoplsClient({ workspaceRoot: tmp });
    await assert.rejects(
      async () => {
        await client.onBeforeStartForTest();
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /gopls not on PATH/);
        assert.match(err.message, /go install golang\.org\/x\/tools\/gopls@latest/);
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

test("GoplsClient version regex parses `gopls version` stdout", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lsp-oracle-gopls-"));
  try {
    const client = new TestableGoplsClient({ workspaceRoot: tmp });
    assert.equal(
      client.parseVersionForTest("golang.org/x/tools/gopls v0.21.0\n    go1.22.1"),
      "0.21.0",
    );
    assert.equal(
      client.parseVersionForTest("golang.org/x/tools/gopls v0.22.1-pre.1\n    go1.23.0"),
      "0.22.1-pre.1",
    );
    assert.equal(client.parseVersionForTest("no version here"), null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("GoplsClient.start + stop round-trip against mock server", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lsp-oracle-gopls-"));
  try {
    const client = new GoplsClient({
      workspaceRoot: tmp,
      indexWaitMs: 200,
      requestTimeoutMs: 5_000,
      serverCommand: [process.execPath, mockServerPath],
    });
    await client.start();
    const status = client.getStatus();
    assert.equal(status.started, true);
    assert.equal(status.workspaceRoot, path.resolve(tmp));
    // goplsVersion stays null when a mock-server override is in use.
    assert.equal(status.goplsVersion, null);
    await client.stop();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("GoplsClient.queryReferences maps mock response to 1-indexed sites", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lsp-oracle-gopls-"));
  try {
    const goFile = path.join(tmp, "main.go");
    writeFileSync(
      goFile,
      [
        "package main",
        "",
        "func Greet(name string) string {",
        '    return "hello " + name',
        "}",
        "",
        "func main() {",
        '    _ = Greet("world")',
        "}",
        "",
      ].join("\n"),
    );
    const client = new GoplsClient({
      workspaceRoot: tmp,
      indexWaitMs: 200,
      requestTimeoutMs: 5_000,
      serverCommand: [process.execPath, mockServerPath],
    });
    await client.start();
    try {
      const refs = await client.queryReferences({
        filePath: "main.go",
        line: 3,
        character: 6,
      });
      assert.equal(refs.length, 1);
      const only = refs[0];
      assert.ok(only !== undefined);
      // Mock returns line 9 / char 1 (0-indexed) → 10 / 2 (1-indexed).
      assert.equal(only.line, 10);
      assert.equal(only.character, 2);
      assert.equal(only.file, "main.go");
    } finally {
      await client.stop();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("GoplsClient.queryImplementations maps mock response to 1-indexed sites", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lsp-oracle-gopls-"));
  try {
    const goFile = path.join(tmp, "iface.go");
    writeFileSync(
      goFile,
      [
        "package main",
        "",
        "type Greeter interface {",
        "    Greet(name string) string",
        "}",
        "",
      ].join("\n"),
    );
    const client = new GoplsClient({
      workspaceRoot: tmp,
      indexWaitMs: 200,
      requestTimeoutMs: 5_000,
      serverCommand: [process.execPath, mockServerPath],
    });
    await client.start();
    try {
      const impls = await client.queryImplementations({
        filePath: "iface.go",
        line: 3,
        character: 6,
      });
      assert.equal(impls.length, 1);
      const only = impls[0];
      assert.ok(only !== undefined);
      // Mock returns line 19 / char 1 (0-indexed) → 20 / 2 (1-indexed).
      assert.equal(only.line, 20);
      assert.equal(only.character, 2);
      assert.equal(only.file, "iface.go");
    } finally {
      await client.stop();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("GoplsClient.queryCallers returns callHierarchy-sourced sites from mock", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lsp-oracle-gopls-"));
  try {
    const goFile = path.join(tmp, "main.go");
    writeFileSync(
      goFile,
      [
        "package main",
        "",
        "func Greet(name string) string {",
        '    return "hello " + name',
        "}",
        "",
        "func main() {",
        '    _ = Greet("world")',
        "}",
        "",
      ].join("\n"),
    );
    const client = new GoplsClient({
      workspaceRoot: tmp,
      indexWaitMs: 200,
      requestTimeoutMs: 5_000,
      serverCommand: [process.execPath, mockServerPath],
    });
    await client.start();
    try {
      const callers = await client.queryCallers({
        filePath: "main.go",
        line: 3,
        character: 6,
        symbolKind: "function",
        symbolName: "Greet",
      });
      assert.equal(callers.length, 1);
      const only = callers[0];
      assert.ok(only !== undefined);
      assert.equal(only.source, "callHierarchy");
      assert.equal(only.enclosingSymbolName, "main");
      // Mock returns line 7 / char 1 (0-indexed) → 8 / 2 (1-indexed).
      assert.equal(only.line, 8);
      assert.equal(only.character, 2);
      assert.equal(only.file, "main.go");
    } finally {
      await client.stop();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
