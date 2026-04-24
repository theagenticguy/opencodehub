#!/usr/bin/env node
/**
 * Mock typescript-language-server for TypeScriptClient unit tests.
 *
 * Implements just enough of the LSP JSON-RPC wire for the client's public
 * surface to exercise:
 *
 *   - `initialize` / `initialized` / `shutdown` / `exit`
 *   - emits a `$/progress kind: "end"` after initialized so cold-start
 *     completes
 *   - logs every incoming method+params to stderr as a JSON line prefixed
 *     `__MOCK_CALL__ ` so tests can reconstruct the server-side call log
 *   - `textDocument/didOpen` accepted silently
 *   - `textDocument/references` returns a single location in the same file
 *     at 1-indexed line 10, column 5 (0-indexed: 9, 4). If the request
 *     position is `{line:0, character:0}` (the warmup dummy query) it
 *     returns `null` to exercise the swallow-error path.
 *   - `textDocument/implementation` returns a single location at 1-indexed
 *     line 20, column 3
 *   - `textDocument/prepareCallHierarchy` returns one hierarchy item
 *   - `callHierarchy/incomingCalls` returns one caller at line 30, col 7
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

function logCall(method: string, params: unknown): void {
  process.stderr.write(`__MOCK_CALL__ ${JSON.stringify({ method, params })}\n`);
}

const decoder = new FrameDecoder();

process.stdin.on("data", (chunk: Buffer) => {
  decoder.append(chunk);
  try {
    for (const raw of decoder.drain()) {
      handle(raw as LspMessage);
    }
  } catch (err) {
    process.stderr.write(`mock-typescript: decode error: ${(err as Error).message}\n`);
  }
});

function handle(msg: LspMessage): void {
  const { method } = msg;
  if (method === undefined) {
    return;
  }
  logCall(method, msg.params);

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        capabilities: {
          referencesProvider: true,
          implementationProvider: true,
          callHierarchyProvider: true,
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

  if (method === "textDocument/didOpen" || method === "workspace/didChangeConfiguration") {
    return;
  }

  if (method === "textDocument/references") {
    const p = (msg.params ?? {}) as {
      position?: { line?: number; character?: number };
      textDocument?: { uri?: string };
    };
    const uri = p.textDocument?.uri ?? "";
    const line = p.position?.line ?? -1;
    const character = p.position?.character ?? -1;
    // Warmup dummy query uses (0, 0) — return null so client's swallow path runs.
    if (line === 0 && character === 0) {
      send({ jsonrpc: "2.0", id: msg.id, result: null });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: [
        {
          uri,
          range: {
            start: { line: 9, character: 4 },
            end: { line: 9, character: 10 },
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
            start: { line: 19, character: 2 },
            end: { line: 19, character: 12 },
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
          name: "target",
          kind: 12,
          uri,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 2, character: 0 },
          },
          selectionRange: {
            start: { line: 0, character: 9 },
            end: { line: 0, character: 15 },
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
            name: "caller",
            kind: 12,
            uri,
            range: {
              start: { line: 28, character: 0 },
              end: { line: 30, character: 0 },
            },
            selectionRange: {
              start: { line: 29, character: 6 },
              end: { line: 29, character: 12 },
            },
          },
          fromRanges: [
            {
              start: { line: 29, character: 6 },
              end: { line: 29, character: 12 },
            },
          ],
        },
      ],
    });
    return;
  }

  if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
  }
}

process.stdin.on("end", () => {
  process.exit(0);
});
