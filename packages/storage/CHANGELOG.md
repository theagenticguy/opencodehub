# Changelog

## [0.2.0](https://github.com/theagenticguy/opencodehub/compare/storage-v0.1.0...storage-v0.2.0) (2026-05-01)


### Features

* **embedder:** replace Arctic Embed XS with gte-modernbert-base ([#31](https://github.com/theagenticguy/opencodehub/issues/31)) ([6b791c5](https://github.com/theagenticguy/opencodehub/commit/6b791c58ae30e464b21200f1917befd7c5a9477a))
* **ingestion:** emit file-level and community-level embeddings ([2b7ae6d](https://github.com/theagenticguy/opencodehub/commit/2b7ae6dc121f6ed3428f19c80e93fb4a42303939))
* initial public release of opencodehub v0.1.1 ([7980892](https://github.com/theagenticguy/opencodehub/commit/7980892a37881ebd94004bdbca0db5f0eb818c8b))
* **mcp:** short-circuit list_findings_delta via stored baselineState ([ba027c8](https://github.com/theagenticguy/opencodehub/commit/ba027c8825f3c0fa39430437f686a8ad3504bc6c))
* **search:** add filter-aware zoom retrieval across hierarchical tiers ([3d5117a](https://github.com/theagenticguy/opencodehub/commit/3d5117abbc3cbf0a7bbc8b52808ea314337b6ce7))
* **storage:** add granularity column to embeddings for hierarchical retrieval ([4b939a1](https://github.com/theagenticguy/opencodehub/commit/4b939a13ae853ca0930da58ea60ce0c25675f36b))
* **storage:** add summary fields to SearchResult and batch lookup helper ([2acde54](https://github.com/theagenticguy/opencodehub/commit/2acde5486255b6b7bcc4e4cae75f3bf76857cfc3))
* **storage:** persist structured FrameworkDetection in frameworks_json ([8c16e4a](https://github.com/theagenticguy/opencodehub/commit/8c16e4a9a520f540cc454300052b8387161f09ba))
* **storage:** populate reserved complexity, coverage, deadness columns ([81172ee](https://github.com/theagenticguy/opencodehub/commit/81172ee28d84670320703eb3520940d6476604e1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/core-types bumped to 1.0.0
