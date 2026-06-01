# Changelog

## [0.2.0](https://github.com/theagenticguy/opencodehub/compare/summarizer-v0.1.1...summarizer-v0.2.0) (2026-06-01)


### ⚠ BREAKING CHANGES

* **sweep:** the `rename` and `remove_dead_code` MCP tools are removed. OpenCodeHub plans and verifies refactors via read-only analysis (impact/context/detect_changes); it does not apply source edits.

### Features

* **sweep:** remediate 44 findings, rip stack-graphs + source-mutating MCP tools ([#175](https://github.com/theagenticguy/opencodehub/issues/175)) ([dbb574a](https://github.com/theagenticguy/opencodehub/commit/dbb574a11ae2d457f8f26ed69278e157189d8dad))

## [0.1.1](https://github.com/theagenticguy/opencodehub/compare/summarizer-v0.1.0...summarizer-v0.1.1) (2026-05-12)


### Features

* initial public release of opencodehub v0.1.1 ([3f23006](https://github.com/theagenticguy/opencodehub/commit/3f230065fe17c7c0b4c5d7568063b786fb72c81f))


### Documentation

* deep refresh + sync + new architecture pages ([3693ddd](https://github.com/theagenticguy/opencodehub/commit/3693ddd57ff78978e8489c76ad7e654cdc21eb63))
* **repo:** pre-publish npm readiness — READMEs, GOVERNANCE, CODEOWNERS, package metadata ([dd10f72](https://github.com/theagenticguy/opencodehub/commit/dd10f72aa490136076bf0632cccd2965c6b17e23))
