import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson, hash6, sha256Hex } from "./hash.js";

test("sha256Hex: known vector for empty string", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("sha256Hex: known vector for 'abc'", () => {
  assert.equal(
    sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("sha256Hex: accepts Uint8Array", () => {
  const buf = new Uint8Array([0x61, 0x62, 0x63]);
  assert.equal(sha256Hex(buf), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("hash6: returns first 6 hex chars of sha256", () => {
  assert.equal(hash6("abc"), "ba7816");
  assert.equal(hash6("abc"), hash6("abc"));
  assert.match(hash6("arbitrary"), /^[0-9a-f]{6}$/);
});

test("canonicalJson: sorts object keys regardless of insertion order", () => {
  const a = canonicalJson({ b: 1, a: 2, c: 3 });
  const b = canonicalJson({ c: 3, a: 2, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":2,"b":1,"c":3}');
});

test("canonicalJson: preserves array order", () => {
  assert.equal(canonicalJson([3, 1, 2]), "[3,1,2]");
});

test("canonicalJson: omits undefined fields, keeps null", () => {
  const s = canonicalJson({ a: 1, b: undefined, c: null });
  assert.equal(s, '{"a":1,"c":null}');
});

test("canonicalJson: nested objects also sort", () => {
  const s = canonicalJson({ outer: { z: 1, a: 2 }, alpha: [{ b: 1, a: 2 }] });
  assert.equal(s, '{"alpha":[{"a":2,"b":1}],"outer":{"a":2,"z":1}}');
});

test("canonicalJson: primitives pass through", () => {
  assert.equal(canonicalJson("x"), '"x"');
  assert.equal(canonicalJson(42), "42");
  assert.equal(canonicalJson(true), "true");
  assert.equal(canonicalJson(false), "false");
  assert.equal(canonicalJson(null), "null");
});

test("canonicalJson: non-finite numbers render as null", () => {
  assert.equal(canonicalJson(Number.NaN), "null");
  assert.equal(canonicalJson(Number.POSITIVE_INFINITY), "null");
});
