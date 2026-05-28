---
name: binary-reader-bounds-check-pos-plus-len
description: Hand-rolled binary readers (protobuf, MessagePack, CBOR, custom wire formats) must throw, not clamp, when a length-prefixed read would overrun the buffer. `Uint8Array.subarray` clamps silently and turns truncated input into valid-but-empty output.
metadata:
  type: convention
  category: conventions
tags: [binary-format, parser, protobuf, scip, defensive-programming]
discovered: 2026-05-28
session: session-88b46e
related:
  - scip-protobuf-hand-rolled-reader
---

# Hand-rolled binary readers must bounds-check `pos += len`

When a hand-rolled reader for a length-prefixed wire format (protobuf, MessagePack, CBOR, custom packed records) does:

```ts
readString(): string {
  const len = this.readVarint();
  const start = this.pos;
  this.pos += len;
  return new TextDecoder().decode(this.buf.subarray(start, start + len));
}
```

…and the buffer is truncated mid-message, `subarray` **silently clamps** to `byteLength`. `pos` overshoots `end`. The next `readVarint` either:
- throws "unexpected end of buffer in varint" (if a parent caller tries to read another field), or
- silently exits because `while (this.pos < this.end)` is already false at a message boundary.

The second case is the dangerous one: a **truncated input decodes as a valid-but-empty container** and every downstream consumer treats "no records" as "nothing to do" and proceeds without error.

## The rule

Every site that advances `this.pos += len` for a variable-length read MUST bounds-check. In the SCIP proto-reader this was four sites:

```ts
// readString, readSubMessage, skip(WIRE_LENGTH_DELIMITED), readRepeatedInt32 packed branch
if (start + len > this.end) {
  throw new Error("scip-ingest: unexpected end of buffer in <op>");
}
this.pos += len;
```

Don't try to "recover" from truncation by clamping or returning empty — the caller has no signal that the stream was incomplete. Throw, and let the caller decide whether the input is salvageable.

## Why

`Uint8Array.subarray(start, end)` follows the spec's "ToInteger" then "min(byteLength, end)" semantics. There is no way to opt out of the clamp short of explicit pre-checks. `Buffer.subarray` is the same. `DataView.getX` throws on overrun, but the typed-array views don't.

Detection from outside is hard: round-trip tests use clean fixtures, structural tests check decoded shapes, but neither produces a deliberately truncated buffer. The bug class only surfaces when a real user gets a partial download / interrupted write / corrupt cache.

## How to apply

1. When writing a new hand-rolled binary reader: every length-delimited read site needs an explicit `if (pos + len > end) throw` before the advance. Don't trust the underlying `subarray` to surface the error.
2. When reviewing one: search for `pos += len`, `pos += <varint>`, `pos += <length>` patterns. Each site needs a bounds check on the same line.
3. When testing one: add at least one positive control (healthy decode succeeds) AND one truncation case per reader method (declared length runs past buffer end → throws). The healthy-path test alone passes even with the bug present.
4. When generalizing: this applies to MessagePack `readBin`/`readStr`, CBOR major-type-2/3 readers, custom wire formats — any decoder that copies "count next N bytes" into an output without first checking `available >= N`.

## SCIP-specific occurrences

The pattern fired four times in `packages/scip-ingest/src/proto-reader.ts`:
- `readString` — most common; every symbol name, every doc string.
- `readSubMessage` — the entry point for nested protobuf messages; affects every `Document`, `Occurrence`, `SymbolInformation`.
- `skip(WIRE_LENGTH_DELIMITED)` — every unknown field forwarded by `forEachField`.
- `readRepeatedInt32` packed branch — line/character offset arrays.

The dual-track lesson `scip-protobuf-hand-rolled-reader.md` captured the *why* of the hand-rolled reader. This one captures the *how* of writing it correctly.

## Linked

- [[scip-protobuf-hand-rolled-reader]] — the original "why hand-roll" decision.
- PR #138 — the four-site fix.
