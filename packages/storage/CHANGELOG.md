# Changelog

## [0.2.0](https://github.com/theagenticguy/opencodehub/compare/storage-v0.1.0...storage-v0.2.0) (2026-05-04)


### Features

* **embedder:** replace Arctic Embed XS with gte-modernbert-base ([#31](https://github.com/theagenticguy/opencodehub/issues/31)) ([1214071](https://github.com/theagenticguy/opencodehub/commit/12140717414c6efbd0e1ebb3f3810ce612f2de50))
* **ingestion:** emit file-level and community-level embeddings ([09a117f](https://github.com/theagenticguy/opencodehub/commit/09a117f6266772c197fe6385888f71fe9c767f51))
* initial public release of opencodehub v0.1.1 ([3f23006](https://github.com/theagenticguy/opencodehub/commit/3f230065fe17c7c0b4c5d7568063b786fb72c81f))
* **mcp:** short-circuit list_findings_delta via stored baselineState ([4d9c187](https://github.com/theagenticguy/opencodehub/commit/4d9c187ebc790af7acb1165bdb5a80910b002ab7))
* **search:** add filter-aware zoom retrieval across hierarchical tiers ([5ab80c4](https://github.com/theagenticguy/opencodehub/commit/5ab80c4760b34babef067b8ea4129294bb54c405))
* **storage:** add granularity column to embeddings for hierarchical retrieval ([b5bd5f8](https://github.com/theagenticguy/opencodehub/commit/b5bd5f8d093850d75ed99d01106f2c2484e3b067))
* **storage:** add summary fields to SearchResult and batch lookup helper ([4944a56](https://github.com/theagenticguy/opencodehub/commit/4944a56f73fc05492926ce4c1023742367d9bca4))
* **storage:** persist structured FrameworkDetection in frameworks_json ([75423fe](https://github.com/theagenticguy/opencodehub/commit/75423febad556f2357c8d2c20c333425035aa2bf))
* **storage:** populate reserved complexity, coverage, deadness columns ([c81e4c3](https://github.com/theagenticguy/opencodehub/commit/c81e4c385961e9326569066f8f9d596bc6b1779a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/core-types bumped to 1.0.0
