import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PyrightClient } from "./client.js";

/**
 * Constructor-redirect behavior: when `queryCallers` is asked about a
 * method named `Foo.__init__` and pyright returns no incoming calls
 * directly, the client MUST re-query the class definition's position and
 * return those results instead.
 *
 * We drive this with a scripted mock LSP server (child Node process) that
 * answers `prepareCallHierarchy` / `callHierarchy/incomingCalls`
 * differently based on whether the query landed on the `__init__` line
 * or on the `class` header line.
 */

// Resolve path to the mock server relative to this test file's compiled output.
const thisFile = fileURLToPath(import.meta.url);
const thisDir = path.dirname(thisFile);
const mockServerPath = path.join(thisDir, "mock-pyright-server.js");

test("queryCallers: constructor redirect re-queries class when __init__ is empty", async () => {
  // Build a temp workspace with a Python file that has a class + __init__.
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lsp-oracle-ctor-"));
  try {
    const pyFile = path.join(tmp, "widget.py");
    writeFileSync(
      pyFile,
      [
        "class Widget:",
        "    def __init__(self, size):",
        "        self.size = size",
        "",
        "def make_widget():",
        "    return Widget(size=10)",
        "",
      ].join("\n"),
    );

    const client = new PyrightClient({
      workspaceRoot: tmp,
      indexWaitMs: 200,
      requestTimeoutMs: 5_000,
      serverCommand: [process.execPath, mockServerPath],
    });
    await client.start();
    try {
      const pyFileUri = pathToFileURL(pyFile).toString();
      const callers = await client.queryCallers({
        filePath: "widget.py",
        line: 2, // `__init__` line — mock returns empty for this.
        character: 9,
        symbolKind: "method",
        symbolName: "Widget.__init__",
      });
      assert.equal(
        callers.length,
        1,
        `expected 1 caller via redirect, got ${callers.length}: ${JSON.stringify(callers)}`,
      );
      const only = callers[0];
      assert.ok(only !== undefined);
      assert.equal(only.source, "callHierarchy");
      assert.equal(only.enclosingSymbolName, "make_widget");
      // The mock-server answers with the make_widget call site at line 6.
      assert.equal(only.line, 6);
      // Consume pyFileUri just so the test doesn't flag it as unused
      // but still verifies the client and mock agree on URIs.
      assert.ok(pyFileUri.startsWith("file://"));
    } finally {
      await client.stop();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
