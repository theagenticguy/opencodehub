# Changelog

## [1.0.0](https://github.com/theagenticguy/opencodehub/compare/cli-v0.1.0...cli-v1.0.0) (2026-05-04)


### ⚠ BREAKING CHANGES

* replace LSP oracle with SCIP indexers (TS/Py/Go/Rust/Java) ([#32](https://github.com/theagenticguy/opencodehub/issues/32))

### Features

* artifact factory + codehub init + CI UX fixes ([#38](https://github.com/theagenticguy/opencodehub/issues/38)) ([d6ffafa](https://github.com/theagenticguy/opencodehub/commit/d6ffafac74f04212458f4eafaba22146505f7490))
* **cli:** add --granularity flag to analyze for hierarchical embeddings ([defa9b6](https://github.com/theagenticguy/opencodehub/commit/defa9b6dd9d686daaaf51f561c81c2bb02dbed87))
* **cli:** add --strict-detectors flag + ts-morph optional dep ([329f5c3](https://github.com/theagenticguy/opencodehub/commit/329f5c3e5c3429c5f160d7ce283c0115ea0b8934))
* **cli:** add exact-name resolver and disambiguation flags to context ([7f279a9](https://github.com/theagenticguy/opencodehub/commit/7f279a9a63b36be969198f2b39d26ed86ceb814b))
* **cli:** flip query hybrid-by-default with --bm25-only + --rerank-top-k ([3e924b5](https://github.com/theagenticguy/opencodehub/commit/3e924b5dcf35cb3953bf069cfbbabfd8ae643cf6))
* **embedder:** replace Arctic Embed XS with gte-modernbert-base ([#31](https://github.com/theagenticguy/opencodehub/issues/31)) ([1214071](https://github.com/theagenticguy/opencodehub/commit/12140717414c6efbd0e1ebb3f3810ce612f2de50))
* **ingestion:** WASM fallback via web-tree-sitter + --wasm-only flag ([cecb401](https://github.com/theagenticguy/opencodehub/commit/cecb4011fad9aebb25c7169c41ce28f366f57d64))
* initial public release of opencodehub v0.1.1 ([3f23006](https://github.com/theagenticguy/opencodehub/commit/3f230065fe17c7c0b4c5d7568063b786fb72c81f))
* **mcp,cli:** join symbol summaries into query results (P04 surface) ([3d73b65](https://github.com/theagenticguy/opencodehub/commit/3d73b65aac852d23871c70468b9521103123d5e8))
* replace LSP oracle with SCIP indexers (TS/Py/Go/Rust/Java) ([#32](https://github.com/theagenticguy/opencodehub/issues/32)) ([1cceb24](https://github.com/theagenticguy/opencodehub/commit/1cceb24e876fafed06e2742952242efe06a21870))
* **scanners:** persist partialFingerprint, baselineState, suppressedJson ([fb4585d](https://github.com/theagenticguy/opencodehub/commit/fb4585d5f37afd9921917d46f25017adc6fd02ed))
* **search:** add filter-aware zoom retrieval across hierarchical tiers ([5ab80c4](https://github.com/theagenticguy/opencodehub/commit/5ab80c4760b34babef067b8ea4129294bb54c405))


### Bug Fixes

* **cli:** accurate doctor native-binding + int8 weights checks ([fb569f9](https://github.com/theagenticguy/opencodehub/commit/fb569f9e4ca21be1046206a315fdb9638b28f70a))


### Performance

* **embeddings:** cross-node batching + worker pool ([#33](https://github.com/theagenticguy/opencodehub/issues/33)) ([acb59d0](https://github.com/theagenticguy/opencodehub/commit/acb59d0dede2e7936ce7af0b7c43fb9ed1a100e6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/analysis bumped to 0.2.0
    * @opencodehub/core-types bumped to 1.0.0
    * @opencodehub/embedder bumped to 0.2.0
    * @opencodehub/ingestion bumped to 1.0.0
    * @opencodehub/mcp bumped to 1.0.0
    * @opencodehub/sarif bumped to 0.2.0
    * @opencodehub/scanners bumped to 0.2.0
    * @opencodehub/search bumped to 0.2.0
    * @opencodehub/storage bumped to 0.2.0
