import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { FrameDecoder } from "./framing.js";
import { JsonRpcDispatcher } from "./jsonrpc.js";

/**
 * The dispatcher is the piece that has to route responses back to the
 * correct promise when multiple requests are in flight. These tests use a
 * PassThrough as the "stdin" write target and feed fake responses through
 * `handleMessage` to simulate the server reply path.
 */

test("JsonRpcDispatcher: two concurrent requests resolve independently", async () => {
  const stdin = new PassThrough();
  const sent: unknown[] = [];
  const decoder = new FrameDecoder();
  stdin.on("data", (chunk: Buffer) => {
    decoder.append(chunk);
    for (const msg of decoder.drain()) {
      sent.push(msg);
    }
  });

  const dispatcher = new JsonRpcDispatcher({ stdout: stdin });

  const a = dispatcher.request<number>("a", null);
  const b = dispatcher.request<number>("b", null);

  // Let the stream deliver both frames.
  await new Promise((r) => setImmediate(r));

  assert.equal(sent.length, 2);
  const first = sent[0] as { id: number; method: string };
  const second = sent[1] as { id: number; method: string };
  assert.equal(first.method, "a");
  assert.equal(second.method, "b");
  assert.notEqual(first.id, second.id);

  // Respond out of order: b first, then a.
  dispatcher.handleMessage({ jsonrpc: "2.0", id: second.id, result: 200 });
  dispatcher.handleMessage({ jsonrpc: "2.0", id: first.id, result: 100 });

  const [va, vb] = await Promise.all([a, b]);
  assert.equal(va, 100);
  assert.equal(vb, 200);
});

test("JsonRpcDispatcher: error responses reject with a message", async () => {
  const stdin = new PassThrough();
  const decoder = new FrameDecoder();
  let sentId = -1;
  stdin.on("data", (chunk: Buffer) => {
    decoder.append(chunk);
    for (const msg of decoder.drain()) {
      sentId = (msg as { id: number }).id;
    }
  });

  const dispatcher = new JsonRpcDispatcher({ stdout: stdin });
  const p = dispatcher.request("failing", null);
  await new Promise((r) => setImmediate(r));
  dispatcher.handleMessage({
    jsonrpc: "2.0",
    id: sentId,
    error: { code: -32000, message: "kaboom" },
  });

  await assert.rejects(p, /failing failed: kaboom/);
});

test("JsonRpcDispatcher: notifications from server dispatch to handler", () => {
  const stdin = new PassThrough();
  const calls: Array<{ method: string; params: unknown }> = [];
  const dispatcher = new JsonRpcDispatcher({
    stdout: stdin,
    onNotification: (method, params) => {
      calls.push({ method, params });
    },
  });
  dispatcher.handleMessage({
    jsonrpc: "2.0",
    method: "$/progress",
    params: { token: 1, value: { kind: "begin" } },
  });
  dispatcher.handleMessage({
    jsonrpc: "2.0",
    method: "$/progress",
    params: { token: 1, value: { kind: "end" } },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.method, "$/progress");
  const params0 = calls[0]?.params as { value: { kind: string } };
  assert.equal(params0.value.kind, "begin");
});

test("JsonRpcDispatcher: server requests get a response written back", async () => {
  const stdin = new PassThrough();
  const sent: unknown[] = [];
  const decoder = new FrameDecoder();
  stdin.on("data", (chunk: Buffer) => {
    decoder.append(chunk);
    for (const msg of decoder.drain()) {
      sent.push(msg);
    }
  });

  const dispatcher = new JsonRpcDispatcher({
    stdout: stdin,
    onServerRequest: (method) => {
      if (method === "workspace/configuration") return [{ ok: true }];
      return null;
    },
  });

  dispatcher.handleMessage({
    jsonrpc: "2.0",
    id: 123,
    method: "workspace/configuration",
    params: { items: [{ section: "python" }] },
  });

  await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    jsonrpc: "2.0",
    id: 123,
    result: [{ ok: true }],
  });
});

test("JsonRpcDispatcher: close() rejects all pending requests", async () => {
  const stdin = new PassThrough();
  const dispatcher = new JsonRpcDispatcher({ stdout: stdin });
  const p1 = dispatcher.request("a", null);
  const p2 = dispatcher.request("b", null);
  dispatcher.close("test shutdown");
  await assert.rejects(p1, /a aborted: test shutdown/);
  await assert.rejects(p2, /b aborted: test shutdown/);
});
