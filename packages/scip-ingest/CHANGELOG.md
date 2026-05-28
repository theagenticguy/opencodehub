# Changelog

## [0.2.3](https://github.com/theagenticguy/opencodehub/compare/scip-ingest-v0.2.2...scip-ingest-v0.2.3) (2026-05-28)


### Bug Fixes

* harden SCIP proto-reader bounds; drop dead native tree-sitter doctor probe ([#138](https://github.com/theagenticguy/opencodehub/issues/138)) ([b1a4772](https://github.com/theagenticguy/opencodehub/commit/b1a4772528ad573962d549e11479e5796608c362))


### Refactoring

* drop dead materialize() + cross-backend parity script (−425 LOC) ([#141](https://github.com/theagenticguy/opencodehub/issues/141)) ([216121a](https://github.com/theagenticguy/opencodehub/commit/216121ac454f0d884bad3553db306de3e38e8d9f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/analysis bumped to 0.3.1

## [0.2.2](https://github.com/theagenticguy/opencodehub/compare/scip-ingest-v0.2.1...scip-ingest-v0.2.2) (2026-05-16)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/analysis bumped to 0.3.0

## [0.2.1](https://github.com/theagenticguy/opencodehub/compare/scip-ingest-v0.2.0...scip-ingest-v0.2.1) (2026-05-15)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/analysis bumped to 0.2.0

## [0.2.0](https://github.com/theagenticguy/opencodehub/compare/scip-ingest-v0.1.0...scip-ingest-v0.2.0) (2026-05-12)


### ⚠ BREAKING CHANGES

* replace LSP oracle with SCIP indexers (TS/Py/Go/Rust/Java) ([#32](https://github.com/theagenticguy/opencodehub/issues/32))

### Features

* detect-secrets as 20th scanner (Track B) ([#72](https://github.com/theagenticguy/opencodehub/issues/72)) ([8fbdd61](https://github.com/theagenticguy/opencodehub/commit/8fbdd61715ae61386a7a3b49ac2b036b1f6d31dd))
* replace LSP oracle with SCIP indexers (TS/Py/Go/Rust/Java) ([#32](https://github.com/theagenticguy/opencodehub/issues/32)) ([1cceb24](https://github.com/theagenticguy/opencodehub/commit/1cceb24e876fafed06e2742952242efe06a21870))
* v1 finalize Track C — debt sweep (7 ACs) ([#73](https://github.com/theagenticguy/opencodehub/issues/73)) ([06d2bb1](https://github.com/theagenticguy/opencodehub/commit/06d2bb17ffae9d74783bd917f417841bd14c7561))


### Bug Fixes

* **scip-ingest:** resolve caller/callee correctly for SCIP edges ([c15f928](https://github.com/theagenticguy/opencodehub/commit/c15f9286550646f254b0d37e7e3d82aa080d96d6))


### Documentation

* **repo:** pre-publish npm readiness — READMEs, GOVERNANCE, CODEOWNERS, package metadata ([dd10f72](https://github.com/theagenticguy/opencodehub/commit/dd10f72aa490136076bf0632cccd2965c6b17e23))


### Refactoring

* consolidate repo-local dir references on META_DIR_NAME ([ce4b63d](https://github.com/theagenticguy/opencodehub/commit/ce4b63d298172dff3a26b1f5d4bf129c5cad7435))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/analysis bumped to 0.1.2
    * @opencodehub/core-types bumped to 0.3.0
