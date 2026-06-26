# Changelog

## [0.4.0](https://github.com/theagenticguy/opencodehub/compare/storage-v0.3.0...storage-v0.4.0) (2026-06-26)


### ⚠ BREAKING CHANGES

* **embedder:** embedding dimension changed to 320 (`codefuse-ai/F2LLM-v2-80M`, was gte-modernbert-base 768-dim). The `embeddingDim` store option defaults to 320; existing stores must be rebuilt with `codehub analyze --embeddings`.

## [0.3.0](https://github.com/theagenticguy/opencodehub/compare/storage-v0.2.3...storage-v0.3.0) (2026-06-01)


### ⚠ BREAKING CHANGES

* **sweep:** the `rename` and `remove_dead_code` MCP tools are removed. OpenCodeHub plans and verifies refactors via read-only analysis (impact/context/detect_changes); it does not apply source edits.

### Features

* **sweep:** remediate 44 findings, rip stack-graphs + source-mutating MCP tools ([#175](https://github.com/theagenticguy/opencodehub/issues/175)) ([dbb574a](https://github.com/theagenticguy/opencodehub/commit/dbb574a11ae2d457f8f26ed69278e157189d8dad))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/core-types bumped to 0.4.0

## [0.2.3](https://github.com/theagenticguy/opencodehub/compare/storage-v0.2.2...storage-v0.2.3) (2026-05-29)


### Features

* **cli:** status surfaces retrieval mode (summaries / vectors / embedder) ([#172](https://github.com/theagenticguy/opencodehub/issues/172)) ([611e818](https://github.com/theagenticguy/opencodehub/commit/611e818cc76c890c4f7c4eaf8c8065d1fb5a3a1a))

## [0.2.2](https://github.com/theagenticguy/opencodehub/compare/storage-v0.2.1...storage-v0.2.2) (2026-05-29)


### Bug Fixes

* **storage:** retry transient lbug WAL→checkpoint race in bulkLoad ([#161](https://github.com/theagenticguy/opencodehub/issues/161)) ([450714c](https://github.com/theagenticguy/opencodehub/commit/450714c07132e4d0c3d1579897812c2c2dc935d6))

## [0.2.1](https://github.com/theagenticguy/opencodehub/compare/storage-v0.2.0...storage-v0.2.1) (2026-05-28)


### Documentation

* sweep stale ADR-0015/0016 prose; unify CI test install path ([#146](https://github.com/theagenticguy/opencodehub/issues/146)) ([3b2e05e](https://github.com/theagenticguy/opencodehub/commit/3b2e05ee19b9d42351bf99659cd4bc26dd0f98bd))


### Refactoring

* drop dead materialize() + cross-backend parity script (−425 LOC) ([#141](https://github.com/theagenticguy/opencodehub/issues/141)) ([216121a](https://github.com/theagenticguy/opencodehub/commit/216121ac454f0d884bad3553db306de3e38e8d9f))

## [0.2.0](https://github.com/theagenticguy/opencodehub/compare/storage-v0.1.2...storage-v0.2.0) (2026-05-16)


### ⚠ BREAKING CHANGES

* lbug-only graph backend; rip DuckDB graph adapter ([#117](https://github.com/theagenticguy/opencodehub/issues/117))

### Features

* lbug-only graph backend; rip DuckDB graph adapter ([#117](https://github.com/theagenticguy/opencodehub/issues/117)) ([49e14fd](https://github.com/theagenticguy/opencodehub/commit/49e14fdd3901e57dec3c86dd8645b5940d5d7c0a))

## [0.1.2](https://github.com/theagenticguy/opencodehub/compare/storage-v0.1.1...storage-v0.1.2) (2026-05-12)


### Features

* **embedder:** replace Arctic Embed XS with gte-modernbert-base ([#31](https://github.com/theagenticguy/opencodehub/issues/31)) ([1214071](https://github.com/theagenticguy/opencodehub/commit/12140717414c6efbd0e1ebb3f3810ce612f2de50))
* **ingestion:** emit file-level and community-level embeddings ([09a117f](https://github.com/theagenticguy/opencodehub/commit/09a117f6266772c197fe6385888f71fe9c767f51))
* initial public release of opencodehub v0.1.1 ([3f23006](https://github.com/theagenticguy/opencodehub/commit/3f230065fe17c7c0b4c5d7568063b786fb72c81f))
* M7 LadybugDB default + IGraphStore abstraction hardening (Track A) ([#71](https://github.com/theagenticguy/opencodehub/issues/71)) ([0175113](https://github.com/theagenticguy/opencodehub/commit/017511304fe050e69f92e3c3eb0bdad92235c9e0))
* **mcp:** short-circuit list_findings_delta via stored baselineState ([4d9c187](https://github.com/theagenticguy/opencodehub/commit/4d9c187ebc790af7acb1165bdb5a80910b002ab7))
* **search:** add filter-aware zoom retrieval across hierarchical tiers ([5ab80c4](https://github.com/theagenticguy/opencodehub/commit/5ab80c4760b34babef067b8ea4129294bb54c405))
* **storage:** add granularity column to embeddings for hierarchical retrieval ([b5bd5f8](https://github.com/theagenticguy/opencodehub/commit/b5bd5f8d093850d75ed99d01106f2c2484e3b067))
* **storage:** add summary fields to SearchResult and batch lookup helper ([4944a56](https://github.com/theagenticguy/opencodehub/commit/4944a56f73fc05492926ce4c1023742367d9bca4))
* **storage:** persist structured FrameworkDetection in frameworks_json ([75423fe](https://github.com/theagenticguy/opencodehub/commit/75423febad556f2357c8d2c20c333425035aa2bf))
* **storage:** populate reserved complexity, coverage, deadness columns ([c81e4c3](https://github.com/theagenticguy/opencodehub/commit/c81e4c385961e9326569066f8f9d596bc6b1779a))
* v1 finalize Track C — debt sweep (7 ACs) ([#73](https://github.com/theagenticguy/opencodehub/issues/73)) ([06d2bb1](https://github.com/theagenticguy/opencodehub/commit/06d2bb17ffae9d74783bd917f417841bd14c7561))


### Bug Fixes

* **storage:** wire @ladybugdb/core binding, fix lbug open() guards, upgrade pnpm v10→v11 ([#93](https://github.com/theagenticguy/opencodehub/issues/93)) ([78d6a85](https://github.com/theagenticguy/opencodehub/commit/78d6a8549ef450888e231427dbc1df673d19a9b6))


### Documentation

* **repo:** pre-publish npm readiness — READMEs, GOVERNANCE, CODEOWNERS, package metadata ([dd10f72](https://github.com/theagenticguy/opencodehub/commit/dd10f72aa490136076bf0632cccd2965c6b17e23))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/core-types bumped to 0.3.0

## [0.1.1](https://github.com/theagenticguy/opencodehub/compare/storage-v0.1.0...storage-v0.1.1) (2026-05-12)


### Features

* **embedder:** replace Arctic Embed XS with gte-modernbert-base ([#31](https://github.com/theagenticguy/opencodehub/issues/31)) ([1214071](https://github.com/theagenticguy/opencodehub/commit/12140717414c6efbd0e1ebb3f3810ce612f2de50))
* **ingestion:** emit file-level and community-level embeddings ([09a117f](https://github.com/theagenticguy/opencodehub/commit/09a117f6266772c197fe6385888f71fe9c767f51))
* initial public release of opencodehub v0.1.1 ([3f23006](https://github.com/theagenticguy/opencodehub/commit/3f230065fe17c7c0b4c5d7568063b786fb72c81f))
* M7 LadybugDB default + IGraphStore abstraction hardening (Track A) ([#71](https://github.com/theagenticguy/opencodehub/issues/71)) ([0175113](https://github.com/theagenticguy/opencodehub/commit/017511304fe050e69f92e3c3eb0bdad92235c9e0))
* **mcp:** short-circuit list_findings_delta via stored baselineState ([4d9c187](https://github.com/theagenticguy/opencodehub/commit/4d9c187ebc790af7acb1165bdb5a80910b002ab7))
* **search:** add filter-aware zoom retrieval across hierarchical tiers ([5ab80c4](https://github.com/theagenticguy/opencodehub/commit/5ab80c4760b34babef067b8ea4129294bb54c405))
* **storage:** add granularity column to embeddings for hierarchical retrieval ([b5bd5f8](https://github.com/theagenticguy/opencodehub/commit/b5bd5f8d093850d75ed99d01106f2c2484e3b067))
* **storage:** add summary fields to SearchResult and batch lookup helper ([4944a56](https://github.com/theagenticguy/opencodehub/commit/4944a56f73fc05492926ce4c1023742367d9bca4))
* **storage:** persist structured FrameworkDetection in frameworks_json ([75423fe](https://github.com/theagenticguy/opencodehub/commit/75423febad556f2357c8d2c20c333425035aa2bf))
* **storage:** populate reserved complexity, coverage, deadness columns ([c81e4c3](https://github.com/theagenticguy/opencodehub/commit/c81e4c385961e9326569066f8f9d596bc6b1779a))
* v1 finalize Track C — debt sweep (7 ACs) ([#73](https://github.com/theagenticguy/opencodehub/issues/73)) ([06d2bb1](https://github.com/theagenticguy/opencodehub/commit/06d2bb17ffae9d74783bd917f417841bd14c7561))


### Bug Fixes

* **storage:** wire @ladybugdb/core binding, fix lbug open() guards, upgrade pnpm v10→v11 ([#93](https://github.com/theagenticguy/opencodehub/issues/93)) ([78d6a85](https://github.com/theagenticguy/opencodehub/commit/78d6a8549ef450888e231427dbc1df673d19a9b6))


### Documentation

* **repo:** pre-publish npm readiness — READMEs, GOVERNANCE, CODEOWNERS, package metadata ([dd10f72](https://github.com/theagenticguy/opencodehub/commit/dd10f72aa490136076bf0632cccd2965c6b17e23))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/core-types bumped to 0.2.0
