#!/usr/bin/env node
/**
 * Mock rust-analyzer for RustAnalyzerClient unit tests.
 *
 * Implements just enough of the LSP JSON-RPC wire to exercise the
 * client's start/stop lifecycle, the three public query shapes, and the
 * `warmup()` cachePriming-progress contract:
 *
 *   - `initialize` / `initialized` / `shutdown` / `exit`
 *   - accepts `textDocument/didOpen` silently
 *   - `textDocument/references` returns one fixed reference site
 *   - `textDocument/implementation` returns one fixed implementation site
 *   - `textDocument/prepareCallHierarchy` + `callHierarchy/incomingCalls`
 *     return one caller at a scripted position so `queryCallers` can be
 *     validated without invoking the constructor-redirect branch
 *   - After initialized, waits for env-gated instructions before emitting
 *     the `$/progress` sequence for cache priming. The client's
 *     `warmup()` contract is keyed on the END notification for the
 *     priming token, so the mock lets the test control whether an END
 *     is ever sent (for timeout-path coverage).
 *
 * Env flags:
 *   MOCK_RA_SUPPRESS_PRIMING=1   — never emit the priming progress
 *                                  sequence. Lets `warmup()` hit its
 *                                  timeout path deterministically.
 *   MOCK_RA_PRIMING_DELAY_MS=N   — delay (ms) between `initialized` and
 *                                  the priming begin→end emission.
 *                                  Defaults to 10ms.
 *
 * This is not a general-purpose rust-analyzer replacement. It exists
 * only to validate RustAnalyzerClient wire behavior without shelling
 * out to a real rust-analyzer binary.
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
    process.stderr.write(`mock-rust-analyzer: decode error: ${(err as Error).message}\n`);
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
        serverInfo: { name: "mock-rust-analyzer", version: "0.4.2514-standalone" },
      },
    });
    return;
  }

  if (method === "initialized") {
    const suppress = process.env["MOCK_RA_SUPPRESS_PRIMING"] === "1";
    if (suppress) {
      return;
    }
    const delayRaw = process.env["MOCK_RA_PRIMING_DELAY_MS"];
    const delayMs = delayRaw !== undefined && delayRaw !== "" ? Number(delayRaw) : 10;
    setTimeout(
      () => {
        // Emit begin then end for a cache-priming-like token.
        send({
          jsonrpc: "2.0",
          method: "$/progress",
          params: {
            token: "rustAnalyzer/cachePriming",
            value: { kind: "begin", title: "Indexing" },
          },
        });
        send({
          jsonrpc: "2.0",
          method: "$/progress",
          params: {
            token: "rustAnalyzer/cachePriming",
            value: { kind: "end" },
          },
        });
      },
      Number.isFinite(delayMs) ? delayMs : 10,
    );
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
            start: { line: 7, character: 4 },
            end: { line: 7, character: 10 },
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
            start: { line: 10, character: 4 },
            end: { line: 10, character: 12 },
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
          name: "target_fn",
          kind: 12,
          uri,
          range: {
            start: { line: 2, character: 0 },
            end: { line: 4, character: 1 },
          },
          selectionRange: {
            start: { line: 2, character: 3 },
            end: { line: 2, character: 12 },
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
            name: "caller_fn",
            kind: 12,
            uri,
            range: {
              start: { line: 14, character: 0 },
              end: { line: 16, character: 1 },
            },
            selectionRange: {
              start: { line: 15, character: 4 },
              end: { line: 15, character: 13 },
            },
          },
          fromRanges: [
            {
              start: { line: 15, character: 4 },
              end: { line: 15, character: 13 },
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
