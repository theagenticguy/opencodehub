# Changelog

## [0.3.0](https://github.com/theagenticguy/opencodehub/compare/search-v0.2.3...search-v0.3.0) (2026-06-01)


### ⚠ BREAKING CHANGES

* **sweep:** the `rename` and `remove_dead_code` MCP tools are removed. OpenCodeHub plans and verifies refactors via read-only analysis (impact/context/detect_changes); it does not apply source edits.

### Features

* **sweep:** remediate 44 findings, rip stack-graphs + source-mutating MCP tools ([#175](https://github.com/theagenticguy/opencodehub/issues/175)) ([dbb574a](https://github.com/theagenticguy/opencodehub/commit/dbb574a11ae2d457f8f26ed69278e157189d8dad))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/core-types bumped to 0.4.0
    * @opencodehub/storage bumped to 0.3.0

## [0.2.3](https://github.com/theagenticguy/opencodehub/compare/search-v0.2.2...search-v0.2.3) (2026-05-29)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/storage bumped to 0.2.3

## [0.2.2](https://github.com/theagenticguy/opencodehub/compare/search-v0.2.1...search-v0.2.2) (2026-05-29)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/storage bumped to 0.2.2

## [0.2.1](https://github.com/theagenticguy/opencodehub/compare/search-v0.2.0...search-v0.2.1) (2026-05-28)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/storage bumped to 0.2.1

## [0.2.0](https://github.com/theagenticguy/opencodehub/compare/search-v0.1.2...search-v0.2.0) (2026-05-16)


### ⚠ BREAKING CHANGES

* lbug-only graph backend; rip DuckDB graph adapter ([#117](https://github.com/theagenticguy/opencodehub/issues/117))

### Features

* lbug-only graph backend; rip DuckDB graph adapter ([#117](https://github.com/theagenticguy/opencodehub/issues/117)) ([49e14fd](https://github.com/theagenticguy/opencodehub/commit/49e14fdd3901e57dec3c86dd8645b5940d5d7c0a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/storage bumped to 0.2.0

## [0.1.2](https://github.com/theagenticguy/opencodehub/compare/search-v0.1.1...search-v0.1.2) (2026-05-12)


### Features

* detect-secrets as 20th scanner (Track B) ([#72](https://github.com/theagenticguy/opencodehub/issues/72)) ([8fbdd61](https://github.com/theagenticguy/opencodehub/commit/8fbdd61715ae61386a7a3b49ac2b036b1f6d31dd))
* **embedder:** replace Arctic Embed XS with gte-modernbert-base ([#31](https://github.com/theagenticguy/opencodehub/issues/31)) ([1214071](https://github.com/theagenticguy/opencodehub/commit/12140717414c6efbd0e1ebb3f3810ce612f2de50))
* initial public release of opencodehub v0.1.1 ([3f23006](https://github.com/theagenticguy/opencodehub/commit/3f230065fe17c7c0b4c5d7568063b786fb72c81f))
* M7 LadybugDB default + IGraphStore abstraction hardening (Track A) ([#71](https://github.com/theagenticguy/opencodehub/issues/71)) ([0175113](https://github.com/theagenticguy/opencodehub/commit/017511304fe050e69f92e3c3eb0bdad92235c9e0))
* **search:** add filter-aware zoom retrieval across hierarchical tiers ([5ab80c4](https://github.com/theagenticguy/opencodehub/commit/5ab80c4760b34babef067b8ea4129294bb54c405))
* **search:** extract tryOpenEmbedder + embeddingsPopulated, demote NullEmbedder throw ([c4cc680](https://github.com/theagenticguy/opencodehub/commit/c4cc68083f69fa6dc31562867f431875ee9b3da9))


### Documentation

* **repo:** pre-publish npm readiness — READMEs, GOVERNANCE, CODEOWNERS, package metadata ([dd10f72](https://github.com/theagenticguy/opencodehub/commit/dd10f72aa490136076bf0632cccd2965c6b17e23))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/core-types bumped to 0.3.0
    * @opencodehub/storage bumped to 0.1.2

## [0.1.1](https://github.com/theagenticguy/opencodehub/compare/search-v0.1.0...search-v0.1.1) (2026-05-12)


### Features

* detect-secrets as 20th scanner (Track B) ([#72](https://github.com/theagenticguy/opencodehub/issues/72)) ([8fbdd61](https://github.com/theagenticguy/opencodehub/commit/8fbdd61715ae61386a7a3b49ac2b036b1f6d31dd))
* **embedder:** replace Arctic Embed XS with gte-modernbert-base ([#31](https://github.com/theagenticguy/opencodehub/issues/31)) ([1214071](https://github.com/theagenticguy/opencodehub/commit/12140717414c6efbd0e1ebb3f3810ce612f2de50))
* initial public release of opencodehub v0.1.1 ([3f23006](https://github.com/theagenticguy/opencodehub/commit/3f230065fe17c7c0b4c5d7568063b786fb72c81f))
* M7 LadybugDB default + IGraphStore abstraction hardening (Track A) ([#71](https://github.com/theagenticguy/opencodehub/issues/71)) ([0175113](https://github.com/theagenticguy/opencodehub/commit/017511304fe050e69f92e3c3eb0bdad92235c9e0))
* **search:** add filter-aware zoom retrieval across hierarchical tiers ([5ab80c4](https://github.com/theagenticguy/opencodehub/commit/5ab80c4760b34babef067b8ea4129294bb54c405))
* **search:** extract tryOpenEmbedder + embeddingsPopulated, demote NullEmbedder throw ([c4cc680](https://github.com/theagenticguy/opencodehub/commit/c4cc68083f69fa6dc31562867f431875ee9b3da9))


### Documentation

* **repo:** pre-publish npm readiness — READMEs, GOVERNANCE, CODEOWNERS, package metadata ([dd10f72](https://github.com/theagenticguy/opencodehub/commit/dd10f72aa490136076bf0632cccd2965c6b17e23))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/core-types bumped to 0.2.0
    * @opencodehub/storage bumped to 0.1.1
