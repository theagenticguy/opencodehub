# Changelog

## [0.2.3](https://github.com/theagenticguy/opencodehub/compare/scanners-v0.2.2...scanners-v0.2.3) (2026-05-29)


### Bug Fixes

* **scanners:** exclude indexer-ignored dirs from vulture/radon/ty (drop .venv noise) ([#168](https://github.com/theagenticguy/opencodehub/issues/168)) ([848aa34](https://github.com/theagenticguy/opencodehub/commit/848aa34eba622c976ba6be968383824f0912e6b3))

## [0.2.2](https://github.com/theagenticguy/opencodehub/compare/scanners-v0.2.1...scanners-v0.2.2) (2026-05-29)


### Bug Fixes

* **scanners:** uv-first bandit[sarif] install + pip-audit pyproject.toml support ([#166](https://github.com/theagenticguy/opencodehub/issues/166)) ([5ad02d8](https://github.com/theagenticguy/opencodehub/commit/5ad02d8184df9af69e7f6a70f3860af3927b8dd7))

## [0.2.1](https://github.com/theagenticguy/opencodehub/compare/scanners-v0.2.0...scanners-v0.2.1) (2026-05-29)


### Bug Fixes

* **scanners:** correct scanner exit-code handling and stop duplicate skip logs ([#156](https://github.com/theagenticguy/opencodehub/issues/156)) ([5d30eb4](https://github.com/theagenticguy/opencodehub/commit/5d30eb4f5b26edfc0a4460ba1aef8bc728ea6120))

## [0.2.0](https://github.com/theagenticguy/opencodehub/compare/scanners-v0.1.2...scanners-v0.2.0) (2026-05-16)


### ⚠ BREAKING CHANGES

* drop detect-secrets; ship tuned betterleaks default config ([#118](https://github.com/theagenticguy/opencodehub/issues/118))

### Features

* drop detect-secrets; ship tuned betterleaks default config ([#118](https://github.com/theagenticguy/opencodehub/issues/118)) ([d370f9e](https://github.com/theagenticguy/opencodehub/commit/d370f9e9ad3acbcc1231403e00bbee5cf0e487bd))

## [0.1.2](https://github.com/theagenticguy/opencodehub/compare/scanners-v0.1.1...scanners-v0.1.2) (2026-05-12)


### Features

* detect-secrets as 20th scanner (Track B) ([#72](https://github.com/theagenticguy/opencodehub/issues/72)) ([8fbdd61](https://github.com/theagenticguy/opencodehub/commit/8fbdd61715ae61386a7a3b49ac2b036b1f6d31dd))
* **embedder:** replace Arctic Embed XS with gte-modernbert-base ([#31](https://github.com/theagenticguy/opencodehub/issues/31)) ([1214071](https://github.com/theagenticguy/opencodehub/commit/12140717414c6efbd0e1ebb3f3810ce612f2de50))
* initial public release of opencodehub v0.1.1 ([3f23006](https://github.com/theagenticguy/opencodehub/commit/3f230065fe17c7c0b4c5d7568063b786fb72c81f))
* v1 finalize Track C — debt sweep (7 ACs) ([#73](https://github.com/theagenticguy/opencodehub/issues/73)) ([06d2bb1](https://github.com/theagenticguy/opencodehub/commit/06d2bb17ffae9d74783bd917f417841bd14c7561))


### Documentation

* **repo:** pre-publish npm readiness — READMEs, GOVERNANCE, CODEOWNERS, package metadata ([dd10f72](https://github.com/theagenticguy/opencodehub/commit/dd10f72aa490136076bf0632cccd2965c6b17e23))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/sarif bumped to 0.1.2

## [0.1.1](https://github.com/theagenticguy/opencodehub/compare/scanners-v0.1.0...scanners-v0.1.1) (2026-05-12)


### Features

* detect-secrets as 20th scanner (Track B) ([#72](https://github.com/theagenticguy/opencodehub/issues/72)) ([8fbdd61](https://github.com/theagenticguy/opencodehub/commit/8fbdd61715ae61386a7a3b49ac2b036b1f6d31dd))
* **embedder:** replace Arctic Embed XS with gte-modernbert-base ([#31](https://github.com/theagenticguy/opencodehub/issues/31)) ([1214071](https://github.com/theagenticguy/opencodehub/commit/12140717414c6efbd0e1ebb3f3810ce612f2de50))
* initial public release of opencodehub v0.1.1 ([3f23006](https://github.com/theagenticguy/opencodehub/commit/3f230065fe17c7c0b4c5d7568063b786fb72c81f))
* v1 finalize Track C — debt sweep (7 ACs) ([#73](https://github.com/theagenticguy/opencodehub/issues/73)) ([06d2bb1](https://github.com/theagenticguy/opencodehub/commit/06d2bb17ffae9d74783bd917f417841bd14c7561))


### Documentation

* **repo:** pre-publish npm readiness — READMEs, GOVERNANCE, CODEOWNERS, package metadata ([dd10f72](https://github.com/theagenticguy/opencodehub/commit/dd10f72aa490136076bf0632cccd2965c6b17e23))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/sarif bumped to 0.1.1
