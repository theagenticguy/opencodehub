# Changelog

## [1.0.0](https://github.com/theagenticguy/opencodehub/compare/mcp-v0.1.0...mcp-v1.0.0) (2026-05-01)


### ⚠ BREAKING CHANGES

* replace LSP oracle with SCIP indexers (TS/Py/Go/Rust/Java) ([#32](https://github.com/theagenticguy/opencodehub/issues/32))

### Features

* **embedder:** replace Arctic Embed XS with gte-modernbert-base ([#31](https://github.com/theagenticguy/opencodehub/issues/31)) ([6b791c5](https://github.com/theagenticguy/opencodehub/commit/6b791c58ae30e464b21200f1917befd7c5a9477a))
* initial public release of opencodehub v0.1.1 ([7980892](https://github.com/theagenticguy/opencodehub/commit/7980892a37881ebd94004bdbca0db5f0eb818c8b))
* **mcp,cli:** join symbol summaries into query results (P04 surface) ([d45bf6e](https://github.com/theagenticguy/opencodehub/commit/d45bf6e3fc0ac6e8f4873acbf7fdbd8ba1589d71))
* **mcp:** short-circuit list_findings_delta via stored baselineState ([ba027c8](https://github.com/theagenticguy/opencodehub/commit/ba027c8825f3c0fa39430437f686a8ad3504bc6c))
* **mcp:** surface structured FrameworkDetection in project_profile tool ([281390c](https://github.com/theagenticguy/opencodehub/commit/281390c19a5224811aabd179341911f16b9f9ad9))
* replace LSP oracle with SCIP indexers (TS/Py/Go/Rust/Java) ([#32](https://github.com/theagenticguy/opencodehub/issues/32)) ([d757cd2](https://github.com/theagenticguy/opencodehub/commit/d757cd252dc8343d0074b1d5ddf5bc4293ccc146))
* **search:** add filter-aware zoom retrieval across hierarchical tiers ([3d5117a](https://github.com/theagenticguy/opencodehub/commit/3d5117abbc3cbf0a7bbc8b52808ea314337b6ce7))


### Refactoring

* **mcp:** consume shared tryOpenEmbedder + embeddingsPopulated from @opencodehub/search ([71f95cc](https://github.com/theagenticguy/opencodehub/commit/71f95cc0a90cd8ad111fa3a8128f9b55edbf8954))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/analysis bumped to 0.2.0
    * @opencodehub/core-types bumped to 1.0.0
    * @opencodehub/embedder bumped to 0.2.0
    * @opencodehub/sarif bumped to 0.2.0
    * @opencodehub/scanners bumped to 0.2.0
    * @opencodehub/search bumped to 0.2.0
    * @opencodehub/storage bumped to 0.2.0
