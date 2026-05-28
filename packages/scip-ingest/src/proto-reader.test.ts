import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ProtoReader, WireType } from "./proto-reader.js";

function encodeVarint(value: number): number[] {
  const out: number[] = [];
  let v = value;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v & 0x7f);
  return out;
}

function tag(fieldNumber: number, wireType: number): number[] {
  return encodeVarint((fieldNumber << 3) | wireType);
}

test("ProtoReader.readString: decodes a healthy length-delimited string", () => {
  const payload = new TextEncoder().encode("scip");
  const buf = new Uint8Array([...encodeVarint(payload.length), ...payload]);
  const reader = new ProtoReader(buf);
  assert.equal(reader.readString(), "scip");
  assert.equal(reader.finished, true);
});

test("ProtoReader.readString: throws when declared length runs past buffer end", () => {
  const buf = new Uint8Array([...encodeVarint(99), 0x61, 0x62, 0x63]);
  const reader = new ProtoReader(buf);
  assert.throws(() => reader.readString(), /unexpected end of buffer/);
});

test("ProtoReader.readSubMessage: returns the declared slice on a healthy buffer", () => {
  const payload = new Uint8Array([0x0a, 0x01, 0x78]);
  const buf = new Uint8Array([...encodeVarint(payload.length), ...payload]);
  const reader = new ProtoReader(buf);
  const sub = reader.readSubMessage();
  assert.equal(sub.byteLength, payload.length);
  assert.equal(reader.finished, true);
});

test("ProtoReader.readSubMessage: throws when declared length runs past buffer end", () => {
  const buf = new Uint8Array([...encodeVarint(50), 0x01, 0x02]);
  const reader = new ProtoReader(buf);
  assert.throws(() => reader.readSubMessage(), /unexpected end of buffer/);
});

test("ProtoReader.skip: throws on truncated length-delimited field", () => {
  const buf = new Uint8Array([...tag(1, WireType.LENGTH_DELIMITED), ...encodeVarint(20), 0x00]);
  const reader = new ProtoReader(buf);
  assert.throws(() => {
    reader.forEachField(() => false);
  }, /unexpected end of buffer/);
});

test("ProtoReader.readRepeatedInt32: throws when packed length runs past buffer end", () => {
  const buf = new Uint8Array([...encodeVarint(40), 0x01, 0x02, 0x03]);
  const reader = new ProtoReader(buf);
  const out: number[] = [];
  assert.throws(
    () => reader.readRepeatedInt32(WireType.LENGTH_DELIMITED, out),
    /unexpected end of buffer/,
  );
});

test("ProtoReader.readRepeatedInt32: decodes a healthy packed run", () => {
  const values = [1, 2, 3, 130];
  const encoded = values.flatMap((v) => encodeVarint(v));
  const buf = new Uint8Array([...encodeVarint(encoded.length), ...encoded]);
  const reader = new ProtoReader(buf);
  const out: number[] = [];
  reader.readRepeatedInt32(WireType.LENGTH_DELIMITED, out);
  assert.deepEqual(out, values);
});
