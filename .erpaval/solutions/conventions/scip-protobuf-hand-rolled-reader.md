---
title: Hand-roll a minimal protobuf reader for fixed schemas
tags: [protobuf, scip, typescript, dependency-minimization]
first_applied: 2026-04-26
repos: [open-code-hub]
---

## The pattern

When you only need to decode a small, fixed protobuf schema (say 5
messages and 10 fields), **a 130-LOC hand-rolled reader beats pulling
in `@bufbuild/protobuf` + codegen + runtime**.

We decoded SCIP's Index / Metadata / ToolInfo / Document / Occurrence /
SymbolInformation in `packages/scip-ingest/src/proto-reader.ts` (130
LOC) + `parse.ts` (255 LOC). Total: 385 LOC, zero runtime deps.

## What you need

- A `ProtoReader` that exposes `readVarint()`, `readString()`,
  `readSubMessage()`, `skip(wireType)`, and a `forEachField(visit)`
  iterator.
- Four wire types: varint (0), fixed64 (1), length-delimited (2),
  fixed32 (5). SCIP uses only varint + length-delimited + packed
  varints inside length-delimited.
- Per-message decode functions that switch on field number and
  consume-or-skip each one.

## Gotchas

- Varints are little-endian base-128. Use
  `result += (byte & 0x7f) * 2 ** shift` with `shift += 7`. Don't
  bitwise-OR into a JS `number` past 2^31.
- Length-delimited fields can contain packed repeated ints; dispatch
  on `wireType === LENGTH_DELIMITED` per-repeated-field to cover both
  `[tag, len, vals...]` and unpacked `[tag, val][tag, val]` forms.
- Unknown fields: call `skip(wireType)` and move on. Protobuf tolerates
  schema drift.

## When this pattern is wrong

- The schema has 100+ messages (e.g. Google Cloud APIs). Use buf + codegen.
- You need to encode, not just decode. Use buf runtime.
- The schema changes weekly. Let the codegen carry the maintenance.
