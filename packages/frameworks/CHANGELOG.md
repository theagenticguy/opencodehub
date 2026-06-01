# Changelog

## [0.2.0](https://github.com/theagenticguy/opencodehub/compare/frameworks-v0.1.1...frameworks-v0.2.0) (2026-06-01)


### ⚠ BREAKING CHANGES

* **sweep:** the `rename` and `remove_dead_code` MCP tools are removed. OpenCodeHub plans and verifies refactors via read-only analysis (impact/context/detect_changes); it does not apply source edits.

### Features

* **sweep:** remediate 44 findings, rip stack-graphs + source-mutating MCP tools ([#175](https://github.com/theagenticguy/opencodehub/issues/175)) ([dbb574a](https://github.com/theagenticguy/opencodehub/commit/dbb574a11ae2d457f8f26ed69278e157189d8dad))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/core-types bumped to 0.4.0

## [0.1.1](https://github.com/theagenticguy/opencodehub/compare/frameworks-v0.1.0...frameworks-v0.1.1) (2026-05-12)


### Documentation

* **repo:** pre-publish npm readiness — READMEs, GOVERNANCE, CODEOWNERS, package metadata ([dd10f72](https://github.com/theagenticguy/opencodehub/commit/dd10f72aa490136076bf0632cccd2965c6b17e23))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/core-types bumped to 0.3.0
