#!/usr/bin/env node
/**
 * Mock gopls server for GoplsClient unit tests.
 *
 * Implements the minimum LSP wire surface to round-trip `start()` /
 * `stop()` and answer the three supported queries:
 *
 *   - `initialize` / `initialized` / `shutdown` / `exit`
 *   - emits one `$/progress kind: "end"` after `initialized`
 *   - `textDocument/didOpen` is accepted silently
 *   - `textDocument/references`       returns one site
 *   - `textDocument/implementation`   returns one site
 *   - `textDocument/prepareCallHierarchy` returns one item
 *   - `callHierarchy/incomingCalls`   returns one caller
 *
 * Not a drop-in gopls replacement — exists only so GoplsClient unit tests
 * can exercise the real stdio/JSON-RPC pipeline without a Go toolchain.
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
    process.stderr.write(`mock-gopls: decode error: ${(err as Error).message}\n`);
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

  if (method === "textDocument/references") {
    const p = (msg.params ?? {}) as { textDocument?: { uri?: string } };
    const uri = p.textDocument?.uri ?? "";
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: [
        {
          uri,
          range: {
            start: { line: 9, character: 1 },
            end: { line: 9, character: 7 },
          },
        },
      ],
    });
    return;
  }

  if (method === "textDocument/implementation") {
    const p = (msg.params ?? {}) as { textDocument?: { uri?: string } };
    const uri = p.textDocument?.uri ?? "";
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: [
        {
          uri,
          range: {
            start: { line: 19, character: 1 },
            end: { line: 19, character: 7 },
          },
        },
      ],
    });
    return;
  }

  if (method === "textDocument/prepareCallHierarchy") {
    const p = (msg.params ?? {}) as { textDocument?: { uri?: string } };
    const uri = p.textDocument?.uri ?? "";
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: [
        {
          name: "Greet",
          kind: 12,
          uri,
          range: {
            start: { line: 2, character: 0 },
            end: { line: 4, character: 1 },
          },
          selectionRange: {
            start: { line: 2, character: 5 },
            end: { line: 2, character: 10 },
          },
        },
      ],
    });
    return;
  }

  if (method === "callHierarchy/incomingCalls") {
    const p = (msg.params ?? {}) as { item?: { uri?: string } };
    const uri = p.item?.uri ?? "";
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: [
        {
          from: {
            name: "main",
            kind: 12,
            uri,
            range: {
              start: { line: 6, character: 0 },
              end: { line: 8, character: 1 },
            },
            selectionRange: {
              start: { line: 7, character: 1 },
              end: { line: 7, character: 6 },
            },
          },
          fromRanges: [
            {
              start: { line: 7, character: 1 },
              end: { line: 7, character: 6 },
            },
          ],
        },
      ],
    });
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
