#!/usr/bin/env node
/**
 * Mock pyright-langserver for the constructor-redirect unit test.
 *
 * Implements just enough of the LSP JSON-RPC wire to exercise the
 * `PyrightClient` constructor-redirect path:
 *
 *   - `initialize` / `initialized` / `shutdown` / `exit`
 *   - emits a single `$/progress kind: "end"` after initialized so the
 *     client can declare cold-start complete
 *   - accepts `textDocument/didOpen` silently
 *   - `textDocument/prepareCallHierarchy`:
 *       * returns an empty array if `position.line === 1` (the `__init__`
 *         line, 0-indexed — this is the case we want to SIMULATE MISSING)
 *       * returns one `CallHierarchyItem` otherwise (simulating the
 *         class-header position)
 *   - `callHierarchy/incomingCalls`:
 *       * returns one call site at line 5 (0-indexed), enclosed in
 *         `make_widget`, when called against the class item
 *   - `textDocument/references` / `textDocument/implementation` return `[]`
 *
 * This is not a general-purpose pyright replacement — it exists only to
 * validate the redirect logic without pulling pyright into unit tests.
 */

import { encodeFrame, FrameDecoder } from "./framing.js";

interface LspMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

function send(msg: unknown): void {
  process.stdout.write(encodeFrame(msg));
}

const decoder = new FrameDecoder();

process.stdin.on("data", (chunk: Buffer) => {
  decoder.append(chunk);
  try {
    for (const raw of decoder.drain()) {
      handle(raw as LspMessage);
    }
  } catch (err) {
    process.stderr.write(`mock-pyright: decode error: ${(err as Error).message}\n`);
  }
});

function handle(msg: LspMessage): void {
  const { method } = msg;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        capabilities: {
          referencesProvider: true,
          callHierarchyProvider: true,
          implementationProvider: true,
          textDocumentSync: 1,
        },
      },
    });
    return;
  }

  if (method === "initialized") {
    // Simulate workspace indexing, then end.
    setTimeout(() => {
      send({
        jsonrpc: "2.0",
        method: "$/progress",
        params: { token: 1, value: { kind: "begin", title: "Indexing" } },
      });
      send({
        jsonrpc: "2.0",
        method: "$/progress",
        params: { token: 1, value: { kind: "end" } },
      });
    }, 10);
    return;
  }

  if (method === "shutdown") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
    return;
  }

  if (method === "exit") {
    process.exit(0);
  }

  if (method === "textDocument/didOpen") {
    return;
  }

  if (method === "workspace/didChangeConfiguration") {
    return;
  }

  if (method === "textDocument/prepareCallHierarchy") {
    const p = (msg.params ?? {}) as {
      position?: { line?: number; character?: number };
      textDocument?: { uri?: string };
    };
    const line = p.position?.line ?? -1;
    const uri = p.textDocument?.uri ?? "";
    // The `__init__` line is line index 1 in the test fixture (0-indexed).
    // Return empty for that, a hierarchy item for everything else.
    if (line === 1) {
      send({ jsonrpc: "2.0", id: msg.id, result: [] });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: [
        {
          name: "Widget",
          kind: 5,
          uri,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 2, character: 0 },
          },
          selectionRange: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 12 },
          },
        },
      ],
    });
    return;
  }

  if (method === "callHierarchy/incomingCalls") {
    const p = (msg.params ?? {}) as { item?: { uri?: string } };
    const uri = p.item?.uri ?? "";
    // One caller: make_widget at line 5 (0-indexed).
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: [
        {
          from: {
            name: "make_widget",
            kind: 12,
            uri,
            range: {
              start: { line: 4, character: 0 },
              end: { line: 5, character: 29 },
            },
            selectionRange: {
              start: { line: 5, character: 11 },
              end: { line: 5, character: 17 },
            },
          },
          fromRanges: [
            {
              start: { line: 5, character: 11 },
              end: { line: 5, character: 17 },
            },
          ],
        },
      ],
    });
    return;
  }

  if (method === "textDocument/references" || method === "textDocument/implementation") {
    send({ jsonrpc: "2.0", id: msg.id, result: [] });
    return;
  }

  // Unknown method: respond with null so the client doesn't hang.
  if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
  }
}

process.stdin.on("end", () => {
  process.exit(0);
});
