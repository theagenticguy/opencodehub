# Changelog

## [1.0.0](https://github.com/theagenticguy/opencodehub/compare/cli-v0.1.0...cli-v1.0.0) (2026-04-27)


### ⚠ BREAKING CHANGES

* replace LSP oracle with SCIP indexers (TS/Py/Go/Rust/Java) ([#32](https://github.com/theagenticguy/opencodehub/issues/32))

### Features

* **cli:** add --granularity flag to analyze for hierarchical embeddings ([d8ab649](https://github.com/theagenticguy/opencodehub/commit/d8ab6496c67b95b7d5e6fbb48cd0f818704b3547))
* **cli:** add --strict-detectors flag + ts-morph optional dep ([446f491](https://github.com/theagenticguy/opencodehub/commit/446f4911391a3bd91edf081d6d608b1ee5ec6638))
* **cli:** flip query hybrid-by-default with --bm25-only + --rerank-top-k ([b51ae13](https://github.com/theagenticguy/opencodehub/commit/b51ae135665a2d5d1741e75046eea6db4560f3b1))
* **embedder:** replace Arctic Embed XS with gte-modernbert-base ([#31](https://github.com/theagenticguy/opencodehub/issues/31)) ([6b791c5](https://github.com/theagenticguy/opencodehub/commit/6b791c58ae30e464b21200f1917befd7c5a9477a))
* **ingestion:** WASM fallback via web-tree-sitter + --wasm-only flag ([856e054](https://github.com/theagenticguy/opencodehub/commit/856e054a255b10b540cf14ae8d6960aeded3dd48))
* initial public release of opencodehub v0.1.1 ([7980892](https://github.com/theagenticguy/opencodehub/commit/7980892a37881ebd94004bdbca0db5f0eb818c8b))
* **mcp,cli:** join symbol summaries into query results (P04 surface) ([d45bf6e](https://github.com/theagenticguy/opencodehub/commit/d45bf6e3fc0ac6e8f4873acbf7fdbd8ba1589d71))
* replace LSP oracle with SCIP indexers (TS/Py/Go/Rust/Java) ([#32](https://github.com/theagenticguy/opencodehub/issues/32)) ([d757cd2](https://github.com/theagenticguy/opencodehub/commit/d757cd252dc8343d0074b1d5ddf5bc4293ccc146))
* **scanners:** persist partialFingerprint, baselineState, suppressedJson ([05cabfb](https://github.com/theagenticguy/opencodehub/commit/05cabfbfcb8fc74ee5a9824f6407b2e9045fa11c))
* **search:** add filter-aware zoom retrieval across hierarchical tiers ([3d5117a](https://github.com/theagenticguy/opencodehub/commit/3d5117abbc3cbf0a7bbc8b52808ea314337b6ce7))


### Bug Fixes

* **cli:** accurate doctor native-binding + int8 weights checks ([116dafe](https://github.com/theagenticguy/opencodehub/commit/116dafebd12c00deb7ac1e20b2907cefc476f9f0))


### Performance

* **embeddings:** cross-node batching + worker pool ([#33](https://github.com/theagenticguy/opencodehub/issues/33)) ([f8454b5](https://github.com/theagenticguy/opencodehub/commit/f8454b50467ba8ecfded6ee599bda962bddfa203))


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
