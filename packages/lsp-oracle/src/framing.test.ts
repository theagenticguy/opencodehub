import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFrame, FrameDecoder } from "./framing.js";

test("encodeFrame: writes Content-Length header + JSON body", () => {
  const frame = encodeFrame({ jsonrpc: "2.0", id: 1, method: "ping" });
  const text = frame.toString("utf-8");
  assert.match(text, /^Content-Length: \d+\r\n\r\n/);
  const [header, body] = text.split("\r\n\r\n");
  assert.ok(header !== undefined && body !== undefined);
  const declared = Number.parseInt(header.split(":")[1]?.trim() ?? "0", 10);
  assert.equal(Buffer.byteLength(body, "utf-8"), declared);
  assert.deepEqual(JSON.parse(body), { jsonrpc: "2.0", id: 1, method: "ping" });
});

test("encodeFrame: handles UTF-8 multi-byte body length correctly", () => {
  // "λ" is 2 bytes in UTF-8; Content-Length must match bytes, not chars.
  const frame = encodeFrame({ text: "λx.x" });
  const [header, body] = frame.toString("utf-8").split("\r\n\r\n");
  assert.ok(header !== undefined && body !== undefined);
  const declared = Number.parseInt(header.split(":")[1]?.trim() ?? "0", 10);
  assert.equal(declared, Buffer.byteLength(body, "utf-8"));
});

test("FrameDecoder: round-trip encode/decode preserves the message", () => {
  const original = { jsonrpc: "2.0", id: 42, method: "textDocument/references" };
  const frame = encodeFrame(original);
  const decoder = new FrameDecoder();
  decoder.append(frame);
  const out = decoder.drain();
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], original);
  assert.equal(decoder.bufferedBytes, 0);
});

test("FrameDecoder: decodes two back-to-back frames in one chunk", () => {
  const a = encodeFrame({ id: 1 });
  const b = encodeFrame({ id: 2 });
  const decoder = new FrameDecoder();
  decoder.append(Buffer.concat([a, b]));
  const out = decoder.drain();
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { id: 1 });
  assert.deepEqual(out[1], { id: 2 });
});

test("FrameDecoder: tolerates partial reads mid-header and mid-body", () => {
  const frame = encodeFrame({ id: 7, method: "x" });
  const decoder = new FrameDecoder();
  // Split into 4 arbitrary pieces.
  const splits = [
    frame.subarray(0, 3),
    frame.subarray(3, 9),
    frame.subarray(9, 20),
    frame.subarray(20),
  ];
  for (const [i, piece] of splits.entries()) {
    decoder.append(piece);
    const messages = decoder.drain();
    if (i < splits.length - 1) {
      assert.equal(messages.length, 0, `expected no frame yet at piece ${i}`);
    } else {
      assert.equal(messages.length, 1);
      assert.deepEqual(messages[0], { id: 7, method: "x" });
    }
  }
});

test("FrameDecoder: leaves trailing partial frame in buffer for next drain", () => {
  const a = encodeFrame({ id: 1 });
  const b = encodeFrame({ id: 2 });
  const decoder = new FrameDecoder();
  // Send a + first 5 bytes of b.
  decoder.append(Buffer.concat([a, b.subarray(0, 5)]));
  let out = decoder.drain();
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { id: 1 });
  assert.ok(decoder.bufferedBytes > 0);
  // Deliver the rest.
  decoder.append(b.subarray(5));
  out = decoder.drain();
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { id: 2 });
  assert.equal(decoder.bufferedBytes, 0);
});

test("FrameDecoder: throws on malformed header (no Content-Length)", () => {
  const decoder = new FrameDecoder();
  decoder.append(Buffer.from("X-Not-Content-Length: 1\r\n\r\nA"));
  assert.throws(() => decoder.drain(), /missing Content-Length/);
});

test("FrameDecoder: throws on invalid JSON body", () => {
  const decoder = new FrameDecoder();
  const body = Buffer.from("{not json");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
  decoder.append(Buffer.concat([header, body]));
  assert.throws(() => decoder.drain(), /invalid JSON/);
});
