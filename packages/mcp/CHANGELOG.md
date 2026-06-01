# Changelog

## [0.5.0](https://github.com/theagenticguy/opencodehub/compare/mcp-v0.4.5...mcp-v0.5.0) (2026-06-01)


### ⚠ BREAKING CHANGES

* **sweep:** the `rename` and `remove_dead_code` MCP tools are removed. OpenCodeHub plans and verifies refactors via read-only analysis (impact/context/detect_changes); it does not apply source edits.

### Features

* **sweep:** remediate 44 findings, rip stack-graphs + source-mutating MCP tools ([#175](https://github.com/theagenticguy/opencodehub/issues/175)) ([dbb574a](https://github.com/theagenticguy/opencodehub/commit/dbb574a11ae2d457f8f26ed69278e157189d8dad))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/analysis bumped to 0.4.0
    * @opencodehub/core-types bumped to 0.4.0
    * @opencodehub/embedder bumped to 0.1.3
    * @opencodehub/pack bumped to 0.3.0
    * @opencodehub/sarif bumped to 0.2.0
    * @opencodehub/scanners bumped to 0.2.4
    * @opencodehub/search bumped to 0.3.0
    * @opencodehub/storage bumped to 0.3.0

## [0.4.5](https://github.com/theagenticguy/opencodehub/compare/mcp-v0.4.4...mcp-v0.4.5) (2026-05-29)


### Features

* **cli:** expose 9 read-only graph tools as CLI subcommands ([#174](https://github.com/theagenticguy/opencodehub/issues/174)) ([be15666](https://github.com/theagenticguy/opencodehub/commit/be156663e486eaee185c800089afaa589dd8a2af))


### Documentation

* **repo:** clarify `sql` targets the temporal store, not the node/edge graph ([#173](https://github.com/theagenticguy/opencodehub/issues/173)) ([814774a](https://github.com/theagenticguy/opencodehub/commit/814774a013331f5a090fb349bab10665f0ebe2ca))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/analysis bumped to 0.3.3
    * @opencodehub/pack bumped to 0.2.4
    * @opencodehub/scanners bumped to 0.2.3
    * @opencodehub/search bumped to 0.2.3
    * @opencodehub/storage bumped to 0.2.3

## [0.4.4](https://github.com/theagenticguy/opencodehub/compare/mcp-v0.4.3...mcp-v0.4.4) (2026-05-29)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/scanners bumped to 0.2.2

## [0.4.3](https://github.com/theagenticguy/opencodehub/compare/mcp-v0.4.2...mcp-v0.4.3) (2026-05-29)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/analysis bumped to 0.3.2
    * @opencodehub/pack bumped to 0.2.3
    * @opencodehub/scanners bumped to 0.2.1
    * @opencodehub/search bumped to 0.2.2
    * @opencodehub/storage bumped to 0.2.2

## [0.4.2](https://github.com/theagenticguy/opencodehub/compare/mcp-v0.4.1...mcp-v0.4.2) (2026-05-28)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/pack bumped to 0.2.2

## [0.4.1](https://github.com/theagenticguy/opencodehub/compare/mcp-v0.4.0...mcp-v0.4.1) (2026-05-28)


### Performance

* **ingestion:** O(N) complexity lookup; fix sql hint; reuse openStoreForCommand ([#142](https://github.com/theagenticguy/opencodehub/issues/142)) ([976b877](https://github.com/theagenticguy/opencodehub/commit/976b8773dbb96dcc3de6b0c64840e2a63dc5b7d7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/analysis bumped to 0.3.1
    * @opencodehub/pack bumped to 0.2.1
    * @opencodehub/search bumped to 0.2.1
    * @opencodehub/storage bumped to 0.2.1

## [0.4.0](https://github.com/theagenticguy/opencodehub/compare/mcp-v0.3.2...mcp-v0.4.0) (2026-05-16)


### ⚠ BREAKING CHANGES

* lbug-only graph backend; rip DuckDB graph adapter ([#117](https://github.com/theagenticguy/opencodehub/issues/117))

### Features

* lbug-only graph backend; rip DuckDB graph adapter ([#117](https://github.com/theagenticguy/opencodehub/issues/117)) ([49e14fd](https://github.com/theagenticguy/opencodehub/commit/49e14fdd3901e57dec3c86dd8645b5940d5d7c0a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/analysis bumped to 0.3.0
    * @opencodehub/pack bumped to 0.2.0
    * @opencodehub/scanners bumped to 0.2.0
    * @opencodehub/search bumped to 0.2.0
    * @opencodehub/storage bumped to 0.2.0

## [0.3.2](https://github.com/theagenticguy/opencodehub/compare/mcp-v0.3.1...mcp-v0.3.2) (2026-05-15)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/analysis bumped to 0.2.0
    * @opencodehub/pack bumped to 0.1.4

## [0.3.1](https://github.com/theagenticguy/opencodehub/compare/mcp-v0.3.0...mcp-v0.3.1) (2026-05-12)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/pack bumped to 0.1.3

## [0.3.0](https://github.com/theagenticguy/opencodehub/compare/mcp-v0.2.0...mcp-v0.3.0) (2026-05-12)


### ⚠ BREAKING CHANGES

* replace LSP oracle with SCIP indexers (TS/Py/Go/Rust/Java) ([#32](https://github.com/theagenticguy/opencodehub/issues/32))

### Features

* **embedder:** replace Arctic Embed XS with gte-modernbert-base ([#31](https://github.com/theagenticguy/opencodehub/issues/31)) ([1214071](https://github.com/theagenticguy/opencodehub/commit/12140717414c6efbd0e1ebb3f3810ce612f2de50))
* initial public release of opencodehub v0.1.1 ([3f23006](https://github.com/theagenticguy/opencodehub/commit/3f230065fe17c7c0b4c5d7568063b786fb72c81f))
* M7 LadybugDB default + IGraphStore abstraction hardening (Track A) ([#71](https://github.com/theagenticguy/opencodehub/issues/71)) ([0175113](https://github.com/theagenticguy/opencodehub/commit/017511304fe050e69f92e3c3eb0bdad92235c9e0))
* **mcp,cli:** join symbol summaries into query results (P04 surface) ([3d73b65](https://github.com/theagenticguy/opencodehub/commit/3d73b65aac852d23871c70468b9521103123d5e8))
* **mcp:** short-circuit list_findings_delta via stored baselineState ([4d9c187](https://github.com/theagenticguy/opencodehub/commit/4d9c187ebc790af7acb1165bdb5a80910b002ab7))
* **mcp:** surface structured FrameworkDetection in project_profile tool ([15fb309](https://github.com/theagenticguy/opencodehub/commit/15fb3093b0723d65065229092ef2c4e08a12bcc7))
* replace LSP oracle with SCIP indexers (TS/Py/Go/Rust/Java) ([#32](https://github.com/theagenticguy/opencodehub/issues/32)) ([1cceb24](https://github.com/theagenticguy/opencodehub/commit/1cceb24e876fafed06e2742952242efe06a21870))
* **search:** add filter-aware zoom retrieval across hierarchical tiers ([5ab80c4](https://github.com/theagenticguy/opencodehub/commit/5ab80c4760b34babef067b8ea4129294bb54c405))
* v1 finalize Track C — debt sweep (7 ACs) ([#73](https://github.com/theagenticguy/opencodehub/issues/73)) ([06d2bb1](https://github.com/theagenticguy/opencodehub/commit/06d2bb17ffae9d74783bd917f417841bd14c7561))


### Documentation

* **repo:** pre-publish npm readiness — READMEs, GOVERNANCE, CODEOWNERS, package metadata ([dd10f72](https://github.com/theagenticguy/opencodehub/commit/dd10f72aa490136076bf0632cccd2965c6b17e23))


### Refactoring

* **mcp:** consume shared tryOpenEmbedder + embeddingsPopulated from @opencodehub/search ([54f00de](https://github.com/theagenticguy/opencodehub/commit/54f00de8ed30326616e8ce6ca17367f606dc10da))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/analysis bumped to 0.1.2
    * @opencodehub/core-types bumped to 0.3.0
    * @opencodehub/embedder bumped to 0.1.2
    * @opencodehub/pack bumped to 0.1.2
    * @opencodehub/sarif bumped to 0.1.2
    * @opencodehub/scanners bumped to 0.1.2
    * @opencodehub/search bumped to 0.1.2
    * @opencodehub/storage bumped to 0.1.2

## [0.2.0](https://github.com/theagenticguy/opencodehub/compare/mcp-v0.1.0...mcp-v0.2.0) (2026-05-12)


### ⚠ BREAKING CHANGES

* replace LSP oracle with SCIP indexers (TS/Py/Go/Rust/Java) ([#32](https://github.com/theagenticguy/opencodehub/issues/32))

### Features

* **embedder:** replace Arctic Embed XS with gte-modernbert-base ([#31](https://github.com/theagenticguy/opencodehub/issues/31)) ([1214071](https://github.com/theagenticguy/opencodehub/commit/12140717414c6efbd0e1ebb3f3810ce612f2de50))
* initial public release of opencodehub v0.1.1 ([3f23006](https://github.com/theagenticguy/opencodehub/commit/3f230065fe17c7c0b4c5d7568063b786fb72c81f))
* M7 LadybugDB default + IGraphStore abstraction hardening (Track A) ([#71](https://github.com/theagenticguy/opencodehub/issues/71)) ([0175113](https://github.com/theagenticguy/opencodehub/commit/017511304fe050e69f92e3c3eb0bdad92235c9e0))
* **mcp,cli:** join symbol summaries into query results (P04 surface) ([3d73b65](https://github.com/theagenticguy/opencodehub/commit/3d73b65aac852d23871c70468b9521103123d5e8))
* **mcp:** short-circuit list_findings_delta via stored baselineState ([4d9c187](https://github.com/theagenticguy/opencodehub/commit/4d9c187ebc790af7acb1165bdb5a80910b002ab7))
* **mcp:** surface structured FrameworkDetection in project_profile tool ([15fb309](https://github.com/theagenticguy/opencodehub/commit/15fb3093b0723d65065229092ef2c4e08a12bcc7))
* replace LSP oracle with SCIP indexers (TS/Py/Go/Rust/Java) ([#32](https://github.com/theagenticguy/opencodehub/issues/32)) ([1cceb24](https://github.com/theagenticguy/opencodehub/commit/1cceb24e876fafed06e2742952242efe06a21870))
* **search:** add filter-aware zoom retrieval across hierarchical tiers ([5ab80c4](https://github.com/theagenticguy/opencodehub/commit/5ab80c4760b34babef067b8ea4129294bb54c405))
* v1 finalize Track C — debt sweep (7 ACs) ([#73](https://github.com/theagenticguy/opencodehub/issues/73)) ([06d2bb1](https://github.com/theagenticguy/opencodehub/commit/06d2bb17ffae9d74783bd917f417841bd14c7561))


### Documentation

* **repo:** pre-publish npm readiness — READMEs, GOVERNANCE, CODEOWNERS, package metadata ([dd10f72](https://github.com/theagenticguy/opencodehub/commit/dd10f72aa490136076bf0632cccd2965c6b17e23))


### Refactoring

* **mcp:** consume shared tryOpenEmbedder + embeddingsPopulated from @opencodehub/search ([54f00de](https://github.com/theagenticguy/opencodehub/commit/54f00de8ed30326616e8ce6ca17367f606dc10da))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/analysis bumped to 0.1.1
    * @opencodehub/core-types bumped to 0.2.0
    * @opencodehub/embedder bumped to 0.1.1
    * @opencodehub/sarif bumped to 0.1.1
    * @opencodehub/scanners bumped to 0.1.1
    * @opencodehub/search bumped to 0.1.1
    * @opencodehub/storage bumped to 0.1.1
