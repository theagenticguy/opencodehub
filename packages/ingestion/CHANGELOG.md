# Changelog

## [1.0.0](https://github.com/theagenticguy/opencodehub/compare/ingestion-v0.1.0...ingestion-v1.0.0) (2026-05-01)


### ⚠ BREAKING CHANGES

* replace LSP oracle with SCIP indexers (TS/Py/Go/Rust/Java) ([#32](https://github.com/theagenticguy/opencodehub/issues/32))

### Features

* **cli:** add --strict-detectors flag + ts-morph optional dep ([446f491](https://github.com/theagenticguy/opencodehub/commit/446f4911391a3bd91edf081d6d608b1ee5ec6638))
* **embedder:** add SageMaker backend for remote embeddings ([16939f7](https://github.com/theagenticguy/opencodehub/commit/16939f720eb176659930464dab9a37a579684f72))
* **embedder:** replace Arctic Embed XS with gte-modernbert-base ([#31](https://github.com/theagenticguy/opencodehub/issues/31)) ([6b791c5](https://github.com/theagenticguy/opencodehub/commit/6b791c58ae30e464b21200f1917befd7c5a9477a))
* **ingestion:** [@doc](https://github.com/doc) captures + description field populated ([b6f2a66](https://github.com/theagenticguy/opencodehub/commit/b6f2a66261e75dfff6b7b1514d7aa6d11e7e9b14))
* **ingestion:** add receiver resolver + detector precision (P06) ([d2bea02](https://github.com/theagenticguy/opencodehub/commit/d2bea02ec42487f072218b2b23108c4813ff232c))
* **ingestion:** add top-20 framework detection catalog and dispatcher ([a946864](https://github.com/theagenticguy/opencodehub/commit/a946864f7ba54721d214ae0c74e6412def66efa7))
* **ingestion:** capture MCP tool inputSchema as canonical JSON ([ec3063a](https://github.com/theagenticguy/opencodehub/commit/ec3063ae86f6b375c75ea7a71e0f19a791866987))
* **ingestion:** emit CodeElement stubs for external imports ([752023d](https://github.com/theagenticguy/opencodehub/commit/752023d9d1f9da8c46bbd3057c3c5a8f5e52424a))
* **ingestion:** emit file-level and community-level embeddings ([2b7ae6d](https://github.com/theagenticguy/opencodehub/commit/2b7ae6dc121f6ed3428f19c80e93fb4a42303939))
* **ingestion:** FastAPI, Spring, NestJS, Rails route detectors ([d6ca585](https://github.com/theagenticguy/opencodehub/commit/d6ca5855046ff11096c078f17396ed185b78840b))
* **ingestion:** Go IMPLEMENTS method-set resolver + C++20 import ([844b29d](https://github.com/theagenticguy/opencodehub/commit/844b29db99b1222b42b16ef69be880d8f7b481a1))
* **ingestion:** nested .gitignore with layered negation ([7ec7379](https://github.com/theagenticguy/opencodehub/commit/7ec7379e61fb87f1bc5e6d24e29b72cbe122531e))
* **ingestion:** populate DependencyNode license from manifest ([878dbec](https://github.com/theagenticguy/opencodehub/commit/878dbec604ba745c82148edc6c86378db7da40b0))
* **ingestion:** provider-driven complexity + Halstead volume ([f107b64](https://github.com/theagenticguy/opencodehub/commit/f107b64f85b38ad921cd608e7f5514d0d1f5ce9e))
* **ingestion:** soft-fail summarize on credential errors, thread summaryModel ([6b941d8](https://github.com/theagenticguy/opencodehub/commit/6b941d8aae2561c5b8a86b7ca2f0ae645af343eb))
* **ingestion:** WASM fallback via web-tree-sitter + --wasm-only flag ([856e054](https://github.com/theagenticguy/opencodehub/commit/856e054a255b10b540cf14ae8d6960aeded3dd48))
* **ingestion:** wire framework catalog into profile phase ([46b6a81](https://github.com/theagenticguy/opencodehub/commit/46b6a8167867308b93fdfa57ec5ea72e53f02da1))
* initial public release of opencodehub v0.1.1 ([7980892](https://github.com/theagenticguy/opencodehub/commit/7980892a37881ebd94004bdbca0db5f0eb818c8b))
* replace LSP oracle with SCIP indexers (TS/Py/Go/Rust/Java) ([#32](https://github.com/theagenticguy/opencodehub/issues/32)) ([d757cd2](https://github.com/theagenticguy/opencodehub/commit/d757cd252dc8343d0074b1d5ddf5bc4293ccc146))


### Bug Fixes

* **ingestion:** enumerate git submodule paths in the scan phase ([929830b](https://github.com/theagenticguy/opencodehub/commit/929830bff9f8f232644053e478256186dfd575af))
* **ingestion:** skip submodule paths in the ownership blame pass ([736d157](https://github.com/theagenticguy/opencodehub/commit/736d157eff51eebbe0e4bf98e370a4f419fd3bee))
* **scip-ingest:** resolve caller/callee correctly for SCIP edges ([77f670e](https://github.com/theagenticguy/opencodehub/commit/77f670e187ddfc2c4cc9f604006d111ef60c7b63))


### Performance

* **embeddings:** cross-node batching + worker pool ([#33](https://github.com/theagenticguy/opencodehub/issues/33)) ([f8454b5](https://github.com/theagenticguy/opencodehub/commit/f8454b50467ba8ecfded6ee599bda962bddfa203))


### Refactoring

* consolidate repo-local dir references on META_DIR_NAME ([a77bb23](https://github.com/theagenticguy/opencodehub/commit/a77bb2397d92072f57256a900e6125be351eb720))
* **core-types:** centralize LanguageId in core-types ([b9caf99](https://github.com/theagenticguy/opencodehub/commit/b9caf99516e9f3317eacc0cae6e08dedce4a9448))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/analysis bumped to 0.2.0
    * @opencodehub/core-types bumped to 1.0.0
    * @opencodehub/embedder bumped to 0.2.0
    * @opencodehub/storage bumped to 0.2.0
