# Changelog

## [0.4.0](https://github.com/theagenticguy/opencodehub/compare/analysis-v0.3.3...analysis-v0.4.0) (2026-06-01)


### ⚠ BREAKING CHANGES

* **sweep:** the `rename` and `remove_dead_code` MCP tools are removed. OpenCodeHub plans and verifies refactors via read-only analysis (impact/context/detect_changes); it does not apply source edits.

### Features

* **sweep:** remediate 44 findings, rip stack-graphs + source-mutating MCP tools ([#175](https://github.com/theagenticguy/opencodehub/issues/175)) ([dbb574a](https://github.com/theagenticguy/opencodehub/commit/dbb574a11ae2d457f8f26ed69278e157189d8dad))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/core-types bumped to 0.4.0
    * @opencodehub/sarif bumped to 0.2.0
    * @opencodehub/storage bumped to 0.3.0
    * @opencodehub/wiki bumped to 0.3.0

## [0.3.3](https://github.com/theagenticguy/opencodehub/compare/analysis-v0.3.2...analysis-v0.3.3) (2026-05-29)


### Features

* **cli:** expose 9 read-only graph tools as CLI subcommands ([#174](https://github.com/theagenticguy/opencodehub/issues/174)) ([be15666](https://github.com/theagenticguy/opencodehub/commit/be156663e486eaee185c800089afaa589dd8a2af))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/storage bumped to 0.2.3
    * @opencodehub/wiki bumped to 0.2.3

## [0.3.2](https://github.com/theagenticguy/opencodehub/compare/analysis-v0.3.1...analysis-v0.3.2) (2026-05-29)


### Bug Fixes

* **deps:** downgrade write-file-atomic 8.0.0→7.0.1 to match supported node range ([#155](https://github.com/theagenticguy/opencodehub/issues/155)) ([a723e53](https://github.com/theagenticguy/opencodehub/commit/a723e53d4442878fd2ec40b264349d728ff054ef))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/storage bumped to 0.2.2
    * @opencodehub/wiki bumped to 0.2.2

## [0.3.1](https://github.com/theagenticguy/opencodehub/compare/analysis-v0.3.0...analysis-v0.3.1) (2026-05-28)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/storage bumped to 0.2.1
    * @opencodehub/wiki bumped to 0.2.1

## [0.3.0](https://github.com/theagenticguy/opencodehub/compare/analysis-v0.2.0...analysis-v0.3.0) (2026-05-16)


### ⚠ BREAKING CHANGES

* lbug-only graph backend; rip DuckDB graph adapter ([#117](https://github.com/theagenticguy/opencodehub/issues/117))

### Features

* lbug-only graph backend; rip DuckDB graph adapter ([#117](https://github.com/theagenticguy/opencodehub/issues/117)) ([49e14fd](https://github.com/theagenticguy/opencodehub/commit/49e14fdd3901e57dec3c86dd8645b5940d5d7c0a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/storage bumped to 0.2.0
    * @opencodehub/wiki bumped to 0.2.0

## [0.2.0](https://github.com/theagenticguy/opencodehub/compare/analysis-v0.1.2...analysis-v0.2.0) (2026-05-15)


### ⚠ BREAKING CHANGES

* WASM-only parser path; drop native tree-sitter from runtime ([#113](https://github.com/theagenticguy/opencodehub/issues/113))

### Features

* WASM-only parser path; drop native tree-sitter from runtime ([#113](https://github.com/theagenticguy/opencodehub/issues/113)) ([0a9e0cb](https://github.com/theagenticguy/opencodehub/commit/0a9e0cb65e3a4666204a2a80d3c41a8befee8269))

## [0.1.2](https://github.com/theagenticguy/opencodehub/compare/analysis-v0.1.1...analysis-v0.1.2) (2026-05-12)


### Features

* initial public release of opencodehub v0.1.1 ([3f23006](https://github.com/theagenticguy/opencodehub/commit/3f230065fe17c7c0b4c5d7568063b786fb72c81f))
* M7 LadybugDB default + IGraphStore abstraction hardening (Track A) ([#71](https://github.com/theagenticguy/opencodehub/issues/71)) ([0175113](https://github.com/theagenticguy/opencodehub/commit/017511304fe050e69f92e3c3eb0bdad92235c9e0))


### Documentation

* **repo:** pre-publish npm readiness — READMEs, GOVERNANCE, CODEOWNERS, package metadata ([dd10f72](https://github.com/theagenticguy/opencodehub/commit/dd10f72aa490136076bf0632cccd2965c6b17e23))


### Refactoring

* consolidate repo-local dir references on META_DIR_NAME ([ce4b63d](https://github.com/theagenticguy/opencodehub/commit/ce4b63d298172dff3a26b1f5d4bf129c5cad7435))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/core-types bumped to 0.3.0
    * @opencodehub/sarif bumped to 0.1.2
    * @opencodehub/storage bumped to 0.1.2
    * @opencodehub/wiki bumped to 0.1.1

## [0.1.1](https://github.com/theagenticguy/opencodehub/compare/analysis-v0.1.0...analysis-v0.1.1) (2026-05-12)


### Features

* initial public release of opencodehub v0.1.1 ([3f23006](https://github.com/theagenticguy/opencodehub/commit/3f230065fe17c7c0b4c5d7568063b786fb72c81f))
* M7 LadybugDB default + IGraphStore abstraction hardening (Track A) ([#71](https://github.com/theagenticguy/opencodehub/issues/71)) ([0175113](https://github.com/theagenticguy/opencodehub/commit/017511304fe050e69f92e3c3eb0bdad92235c9e0))


### Documentation

* **repo:** pre-publish npm readiness — READMEs, GOVERNANCE, CODEOWNERS, package metadata ([dd10f72](https://github.com/theagenticguy/opencodehub/commit/dd10f72aa490136076bf0632cccd2965c6b17e23))


### Refactoring

* consolidate repo-local dir references on META_DIR_NAME ([ce4b63d](https://github.com/theagenticguy/opencodehub/commit/ce4b63d298172dff3a26b1f5d4bf129c5cad7435))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/core-types bumped to 0.2.0
    * @opencodehub/sarif bumped to 0.1.1
    * @opencodehub/storage bumped to 0.1.1
