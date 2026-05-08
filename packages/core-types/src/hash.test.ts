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

// ---------------------------------------------------------------------------
// RFC 8785 (JSON Canonicalization Scheme) compliance.
//
// RFC 8785 §3.2.2.3 number format == ECMA-262 §7.1.12.1 ToString(Number).
// RFC 8785 §3.2.3 key sort == UTF-16 code-unit ascending.
// RFC 8785 §3.2.2.2 strings == JSON.stringify minimum-escape output.
//
// Node's `JSON.stringify` already implements both ToString(Number) and the
// minimum-escape string form, and JS default string sort is UTF-16 code-unit
// ordering. These tests lock the observed output so any future refactor of
// `writeCanonicalJson` that breaks RFC 8785 compliance fails CI.
// ---------------------------------------------------------------------------

test("RFC 8785 §3.2.2.3: fractional numbers have no trailing zeros", () => {
  assert.equal(canonicalJson({ n: 1.5 }), '{"n":1.5}');
  // 1.50 and 1.500 are the same Number — confirms JS normalizes the trailing zeros.
  assert.equal(canonicalJson({ n: 1.5 }), canonicalJson({ n: 1.5 }));
});

test("RFC 8785 §3.2.2.3: integer-valued numbers drop the decimal point", () => {
  // 1.0 and 1 are indistinguishable at the Number type — both serialize as `1`.
  assert.equal(canonicalJson({ n: 1.0 }), '{"n":1}');
  assert.equal(canonicalJson({ n: 1 }), '{"n":1}');
  assert.equal(canonicalJson({ n: 100 }), '{"n":100}');
});

test("RFC 8785 §3.2.2.3: large exponents use ES6 ToString form ('1e+21' with '+')", () => {
  // ES6 7.1.12.1 ToString uses 'e' (lowercase) and keeps the '+' on positive
  // exponents when the value is >=1e21. RFC 8785 defers to ES6 here.
  assert.equal(canonicalJson({ n: 1e21 }), '{"n":1e+21}');
  assert.equal(canonicalJson({ n: 9.99e96 }), '{"n":9.99e+96}');
});

test("RFC 8785 §3.2.2.3: small values use negative exponent ('1e-7')", () => {
  assert.equal(canonicalJson({ n: 1e-7 }), '{"n":1e-7}');
  assert.equal(canonicalJson({ n: 1e-6 }), '{"n":0.000001}');
});

test("RFC 8785 §3.2.2.3: negative zero normalizes to '0'", () => {
  assert.equal(canonicalJson({ n: -0 }), '{"n":0}');
});

test("RFC 8785 §3.2.3: object keys sort in UTF-16 code-unit ascending order", () => {
  // ASCII only: 'A' (0x41) < 'Z' (0x5A) < '_' (0x5F) < 'a' (0x61) < 'z' (0x7A)
  const s = canonicalJson({ z: 1, a: 2, Z: 3, A: 4, _: 5 });
  assert.equal(s, '{"A":4,"Z":3,"_":5,"a":2,"z":1}');
});

test("RFC 8785 §3.2.3: key sort puts shorter prefixes before extensions", () => {
  // UTF-16 code-unit sort: "ab" < "abc" because "ab" is a prefix of "abc".
  const s = canonicalJson({ abc: 1, ab: 2, a: 3 });
  assert.equal(s, '{"a":3,"ab":2,"abc":1}');
});

test("RFC 8785 §3.2.2.2: strings use JSON.stringify minimum escapes", () => {
  // Control chars must be \uXXXX-escaped (shortest form).
  assert.equal(canonicalJson({ s: "ab" }), '{"s":"a\\u0001b"}');
  // Quote and backslash get the short \" and \\ escapes, not \uXXXX.
  assert.equal(canonicalJson({ s: 'a"b\\c' }), '{"s":"a\\"b\\\\c"}');
  // Plain ASCII and BMP text pass through unescaped.
  assert.equal(canonicalJson({ s: "héllo" }), '{"s":"héllo"}');
});
