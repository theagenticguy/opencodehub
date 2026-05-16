---
name: lbug-copy-from-subquery-bulk-load
description: lbug v0.16.1 COPY FROM (subquery) pattern for type-safe bulk node+edge inserts — avoids INT64/DOUBLE confusion, sentinel pattern, and from/to keyword collision
metadata:
  type: project
---

## Pattern: `COPY <Table> FROM (UNWIND $rows AS r ... RETURN ...)`

lbug v0.16.1's `UNWIND` + `CREATE/MERGE` path infers struct-field types per-row
from JS values (`Number.isInteger(v) → INT64`, else `DOUBLE`). Any confidence=1.0
edge lands as INT64 bit-pattern in a DOUBLE column and round-trips as garbage.

**Fix**: `COPY <Table> FROM (UNWIND $rows AS r WITH r WHERE r.id <> '<SENTINEL>' RETURN ...)`.
COPY reads column types from the DDL; CAST in the RETURN clause converts string-encoded
numerics to the correct type; per-row inference never runs.

### Node inserts

```cypher
COPY CodeNode FROM (UNWIND $rows AS r
  WITH r WHERE r.id <> '__SENTINEL__'
  RETURN r.id, r.kind, ..., CAST(r.start_line AS INT32), ..., CAST(r.cohesion AS DOUBLE), ...)
```

Row encoding rules:
- INT32 columns: pass value as `String(Math.trunc(v))` or `null`
- DOUBLE columns: pass value as `String(v)` or `null`  
- BOOL columns: pass `true`/`false`/`null`
- STRING[] columns: **never pass `null`** — pass `[]` for absent arrays, or lbug infers
  LIST(ANY) and throws "Trying to create a vector with ANY type"
- STRING columns: pass string value or `null`

Sentinel row requirement: prepend a row with `id = SENTINEL_ID` and concrete typed values
for every column (strings for numerics, `false` for bools, `[]` for string arrays, `""` for
strings). The `WITH r WHERE r.id <> SENTINEL_ID` filters it before any storage write.
Purpose: seeds struct-field type inference for lbug's binder so all-null batches don't fail.

### Edge inserts

```cypher
COPY DEFINES(id, confidence, reason, step) FROM (UNWIND $rows AS r
  WITH r WHERE r.eid <> '__EDGE_SENTINEL__'
  RETURN r.src, r.dst, r.eid, CAST(r.confidence AS DOUBLE), r.reason, CAST(r.step AS INT32))
```

Critical rules:
- Use `src`/`dst` (not `from`/`to`) as struct field names — `from` and `to` are Cypher
  reserved keywords; lbug silently misinterprets `r.from`/`r.to` in a RETURN clause
- Use `eid` (not `id`) for the edge id field in the row struct — lbug matches column name
  `id` against the CodeNode primary key and tries to do a node lookup instead of treating
  it as a rel property. Alias `r.eid` maps to the `id` rel property via positional column list
- The `COPY E(id, confidence, reason, step)` column list is required to bind positional
  RETURN columns to rel properties correctly
- Sentinel's `src`/`dst` can be empty strings `""` — filtered by `WHERE r.eid <> SENTINEL`

### Compatibility notes

- `COPY FROM (subquery)` requires the subquery to have a RETURN clause
- `WITH r WHERE` inside UNWIND is valid Cypher inside a COPY subquery
- `IGNORE_ERRORS=true` silently drops rows where FROM/TO node lookup fails — avoid using
  it as a crutch; fix the sentinel instead so the sentinel itself is filtered before lookup
- The mmap "Buffer manager exception: Mmap for size 8796093022208 failed" is virtual
  address-space exhaustion. lbug's default `maxDBSize` is `1 << 43` = 8 TiB per
  `Database`; on 64-bit Linux the user has ~128 TiB of VA, so ~16 concurrent DBs
  exhaust the address space (kernel `MAP_FAILED`). Fix: pass an explicit
  `maxDBSize` (5th `Database` ctor arg, MUST be a power of 2) — 16 GiB is plenty
  for OCH-scale graphs and drops virtual reserve 512×. Also pass `bufferManagerSize`
  (2nd arg) — native default is `min(systemMem, maxDBSize) * 0.8`, often >50 GiB;
  cap at 2 GiB for headroom across concurrent test pools without surfacing the
  sibling error "Buffer manager exception: Unable to allocate memory! The buffer
  pool is full and no memory could be freed!" Cite: kuzudb/kuzu#1826.
- `Database.close()` is what triggers `~VMRegion` → `munmap()`; relying on JS GC
  alone leaks the mapping between tests. Always `await db.close()` before opening
  the next instance pointing at a different path.

### "Trying to create a vector with ANY type" — sentinel STRING[] must be non-empty

The lesson above says STRING[] columns must never be `null` and should be `[]` for
absent arrays. That handles per-row binding, but the **sentinel row's** STRING[]
fields must additionally be **non-empty** (e.g. `["__sentinel__"]`) — lbug's
struct-field type inference looks at the FIRST row's array contents to fix the
LIST element type. An empty-array sentinel (`[]`) yields `LIST(ANY)`, and any
later data row with a string then throws "Trying to create a vector with ANY type".
The seed value never reaches storage because `WITH r WHERE r.id <> SENTINEL`
filters the row before COPY. Reproduces with a 3-column table and 3 rows:
sentinel `kw=[]`, n1 `kw=[]`, n2 `kw=["a","b"]` → fails. Switching the
sentinel to `kw=["__seed__"]` fixes it.

### Read-only opens cannot run `CALL CREATE_FTS_INDEX` / `CALL CREATE_VECTOR_INDEX`

lbug rejects writes against a Database opened with `readOnly=true`, including the
`CALL CREATE_FTS_INDEX(...)` and `CALL CREATE_VECTOR_INDEX(...)` admin procedures
that adapters use to ensure search-side indexes exist. Surfaces as "Cannot
execute write operations in a read-only database!" the moment a reader calls
`search()` or `vectorSearch()`. Fix: build both indexes at the end of `bulkLoad`
(when the connection is read-write) and have the lazy-ensure helpers no-op in
readOnly mode. Readers query the existing index; the index already exists
because every write path runs through bulkLoad.

**Why:** [[scip-replaces-lsp]] — same pattern of lbug's binding layer having non-obvious
per-row type inference that requires careful workarounds.
