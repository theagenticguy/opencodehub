# Changelog

## [1.0.0](https://github.com/theagenticguy/opencodehub/compare/mcp-v0.1.0...mcp-v1.0.0) (2026-05-01)


### ⚠ BREAKING CHANGES

* replace LSP oracle with SCIP indexers (TS/Py/Go/Rust/Java) ([#32](https://github.com/theagenticguy/opencodehub/issues/32))

### Features

* **embedder:** replace Arctic Embed XS with gte-modernbert-base ([#31](https://github.com/theagenticguy/opencodehub/issues/31)) ([1214071](https://github.com/theagenticguy/opencodehub/commit/12140717414c6efbd0e1ebb3f3810ce612f2de50))
* initial public release of opencodehub v0.1.1 ([3f23006](https://github.com/theagenticguy/opencodehub/commit/3f230065fe17c7c0b4c5d7568063b786fb72c81f))
* **mcp,cli:** join symbol summaries into query results (P04 surface) ([3d73b65](https://github.com/theagenticguy/opencodehub/commit/3d73b65aac852d23871c70468b9521103123d5e8))
* **mcp:** short-circuit list_findings_delta via stored baselineState ([4d9c187](https://github.com/theagenticguy/opencodehub/commit/4d9c187ebc790af7acb1165bdb5a80910b002ab7))
* **mcp:** surface structured FrameworkDetection in project_profile tool ([15fb309](https://github.com/theagenticguy/opencodehub/commit/15fb3093b0723d65065229092ef2c4e08a12bcc7))
* replace LSP oracle with SCIP indexers (TS/Py/Go/Rust/Java) ([#32](https://github.com/theagenticguy/opencodehub/issues/32)) ([1cceb24](https://github.com/theagenticguy/opencodehub/commit/1cceb24e876fafed06e2742952242efe06a21870))
* **search:** add filter-aware zoom retrieval across hierarchical tiers ([5ab80c4](https://github.com/theagenticguy/opencodehub/commit/5ab80c4760b34babef067b8ea4129294bb54c405))


### Refactoring

* **mcp:** consume shared tryOpenEmbedder + embeddingsPopulated from @opencodehub/search ([54f00de](https://github.com/theagenticguy/opencodehub/commit/54f00de8ed30326616e8ce6ca17367f606dc10da))


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
