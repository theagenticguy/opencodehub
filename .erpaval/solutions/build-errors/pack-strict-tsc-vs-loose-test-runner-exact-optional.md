# `@opencodehub/pack` strict `tsc -b` fails on code the test runner accepts

**Category:** build-errors · **Track:** bug
**Discovered:** session-3b8ca0 (spec 009 — context-bom read-receipt)

## Symptom

`pnpm --filter @opencodehub/pack test` passes (110 green) while
`pnpm --filter @opencodehub/pack build` (`tsc -b`) fails with TS18048
(`'x' is possibly 'undefined'`), TS2375 / TS2322
(`exactOptionalPropertyTypes`), TS2532. The two toolchains disagree: the
test transform is looser than the package's `tsc` build, so green tests do
NOT imply a green build. **Always run `build` after editing pack `.ts`/test
files — the test run alone will mislead you.**

## The two strict flags that bite

1. **`noUncheckedIndexedAccess`** — `arr[i]` and `arr[0]` are typed
   `T | undefined`. In source, iterate with `for (const x of arr)` (narrows to
   `T`) and track an accumulator var instead of indexing back into the array
   (e.g. `mergeSpans` keeps a `let last: ByteSpan | undefined` rather than
   reading `merged[merged.length-1]`). In tests, add a tiny
   `assert.ok(x !== undefined)` narrowing helper (e.g. `firstComponent(r)`)
   before using `components[0]`.
2. **`exactOptionalPropertyTypes`** — `{ ...obj, field: v }` where `obj` has
   optional fields produces `field?: T` whose spread can widen to
   `T | undefined`, rejected against an exact-optional target. In test
   fixtures, write **explicit literal objects** with all fields set rather
   than spreading a `readonly` fixture and overriding one key, and define
   named consts (`FILE_A`/`FILE_B`) instead of indexing a `readonly` array.

## Fast loop

Build the package (not just test) after every pack edit:
`pnpm --filter @opencodehub/pack build 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep "error TS"`
(the log is ANSI-colored — strip codes or grep finds nothing).
