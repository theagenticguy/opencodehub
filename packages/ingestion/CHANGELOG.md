# Changelog

## [1.0.0](https://github.com/theagenticguy/opencodehub/compare/ingestion-v0.1.0...ingestion-v1.0.0) (2026-05-01)


### ⚠ BREAKING CHANGES

* replace LSP oracle with SCIP indexers (TS/Py/Go/Rust/Java) ([#32](https://github.com/theagenticguy/opencodehub/issues/32))

### Features

* **cli:** add --strict-detectors flag + ts-morph optional dep ([329f5c3](https://github.com/theagenticguy/opencodehub/commit/329f5c3e5c3429c5f160d7ce283c0115ea0b8934))
* **embedder:** add SageMaker backend for remote embeddings ([9b5c53d](https://github.com/theagenticguy/opencodehub/commit/9b5c53d7f2cc7241a4794e6e095da0279887c28f))
* **embedder:** replace Arctic Embed XS with gte-modernbert-base ([#31](https://github.com/theagenticguy/opencodehub/issues/31)) ([1214071](https://github.com/theagenticguy/opencodehub/commit/12140717414c6efbd0e1ebb3f3810ce612f2de50))
* **ingestion:** [@doc](https://github.com/doc) captures + description field populated ([d63dfa6](https://github.com/theagenticguy/opencodehub/commit/d63dfa6fc7fbcf56853f12d15c9524bef467e22f))
* **ingestion:** add receiver resolver + detector precision (P06) ([431f428](https://github.com/theagenticguy/opencodehub/commit/431f4285f39fba38b822936bdd73f24e72bf1ec4))
* **ingestion:** add top-20 framework detection catalog and dispatcher ([02f4864](https://github.com/theagenticguy/opencodehub/commit/02f48640f499551a596ef677b353d0c6103370d2))
* **ingestion:** capture MCP tool inputSchema as canonical JSON ([9872710](https://github.com/theagenticguy/opencodehub/commit/9872710674648f21c82227294dc88fdeb63b4ab0))
* **ingestion:** emit CodeElement stubs for external imports ([49eefe7](https://github.com/theagenticguy/opencodehub/commit/49eefe7f1e46fdf43cec8ef2cfb121619e91c094))
* **ingestion:** emit file-level and community-level embeddings ([09a117f](https://github.com/theagenticguy/opencodehub/commit/09a117f6266772c197fe6385888f71fe9c767f51))
* **ingestion:** FastAPI, Spring, NestJS, Rails route detectors ([62bebfb](https://github.com/theagenticguy/opencodehub/commit/62bebfbb6ccf4883482cc73d2f879d1e604a4eeb))
* **ingestion:** Go IMPLEMENTS method-set resolver + C++20 import ([85c60f9](https://github.com/theagenticguy/opencodehub/commit/85c60f99712d5ff30a54c7bb7a5d8c83f1acbcd5))
* **ingestion:** nested .gitignore with layered negation ([40b5286](https://github.com/theagenticguy/opencodehub/commit/40b52863e83aad27fc4aff691909d31b7f46efca))
* **ingestion:** populate DependencyNode license from manifest ([f947194](https://github.com/theagenticguy/opencodehub/commit/f947194014c18f839b407e1ce388390aa47c23a6))
* **ingestion:** provider-driven complexity + Halstead volume ([5e1379a](https://github.com/theagenticguy/opencodehub/commit/5e1379a3597ecb3d290fde87fbbbdfd0f573eba1))
* **ingestion:** soft-fail summarize on credential errors, thread summaryModel ([d90eb38](https://github.com/theagenticguy/opencodehub/commit/d90eb387ea378a2e6e90ba6bda0ab8afcfdfdf87))
* **ingestion:** WASM fallback via web-tree-sitter + --wasm-only flag ([cecb401](https://github.com/theagenticguy/opencodehub/commit/cecb4011fad9aebb25c7169c41ce28f366f57d64))
* **ingestion:** wire framework catalog into profile phase ([d491401](https://github.com/theagenticguy/opencodehub/commit/d4914011721e60cb51e7ea1124a9602df39a36ab))
* initial public release of opencodehub v0.1.1 ([3f23006](https://github.com/theagenticguy/opencodehub/commit/3f230065fe17c7c0b4c5d7568063b786fb72c81f))
* replace LSP oracle with SCIP indexers (TS/Py/Go/Rust/Java) ([#32](https://github.com/theagenticguy/opencodehub/issues/32)) ([1cceb24](https://github.com/theagenticguy/opencodehub/commit/1cceb24e876fafed06e2742952242efe06a21870))


### Bug Fixes

* **ingestion:** enumerate git submodule paths in the scan phase ([d290d04](https://github.com/theagenticguy/opencodehub/commit/d290d048252e3035dae8078197133d222db3edf3))
* **ingestion:** skip submodule paths in the ownership blame pass ([e28f3e6](https://github.com/theagenticguy/opencodehub/commit/e28f3e64ecc30656e65625b5ca57658aaa3620a0))
* **scip-ingest:** resolve caller/callee correctly for SCIP edges ([c15f928](https://github.com/theagenticguy/opencodehub/commit/c15f9286550646f254b0d37e7e3d82aa080d96d6))


### Performance

* **embeddings:** cross-node batching + worker pool ([#33](https://github.com/theagenticguy/opencodehub/issues/33)) ([acb59d0](https://github.com/theagenticguy/opencodehub/commit/acb59d0dede2e7936ce7af0b7c43fb9ed1a100e6))


### Refactoring

* consolidate repo-local dir references on META_DIR_NAME ([ce4b63d](https://github.com/theagenticguy/opencodehub/commit/ce4b63d298172dff3a26b1f5d4bf129c5cad7435))
* **core-types:** centralize LanguageId in core-types ([4c33fc7](https://github.com/theagenticguy/opencodehub/commit/4c33fc7b67afac65f9648c92fafe9532d42f2c60))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/analysis bumped to 0.2.0
    * @opencodehub/core-types bumped to 1.0.0
    * @opencodehub/embedder bumped to 0.2.0
    * @opencodehub/storage bumped to 0.2.0
