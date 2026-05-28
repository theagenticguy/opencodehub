# Changelog

## [0.5.2](https://github.com/theagenticguy/opencodehub/compare/cli-v0.5.1...cli-v0.5.2) (2026-05-28)


### Bug Fixes

* harden SCIP proto-reader bounds; drop dead native tree-sitter doctor probe ([#138](https://github.com/theagenticguy/opencodehub/issues/138)) ([b1a4772](https://github.com/theagenticguy/opencodehub/commit/b1a4772528ad573962d549e11479e5796608c362))


### Performance

* **ingestion:** O(N) complexity lookup; fix sql hint; reuse openStoreForCommand ([#142](https://github.com/theagenticguy/opencodehub/issues/142)) ([976b877](https://github.com/theagenticguy/opencodehub/commit/976b8773dbb96dcc3de6b0c64840e2a63dc5b7d7))


### Documentation

* sweep stale ADR-0015/0016 prose; unify CI test install path ([#146](https://github.com/theagenticguy/opencodehub/issues/146)) ([3b2e05e](https://github.com/theagenticguy/opencodehub/commit/3b2e05ee19b9d42351bf99659cd4bc26dd0f98bd))


### Refactoring

* drop dead materialize() + cross-backend parity script (−425 LOC) ([#141](https://github.com/theagenticguy/opencodehub/issues/141)) ([216121a](https://github.com/theagenticguy/opencodehub/commit/216121ac454f0d884bad3553db306de3e38e8d9f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/analysis bumped to 0.3.1
    * @opencodehub/ingestion bumped to 0.4.2
    * @opencodehub/mcp bumped to 0.4.1
    * @opencodehub/pack bumped to 0.2.1
    * @opencodehub/search bumped to 0.2.1
    * @opencodehub/storage bumped to 0.2.1
    * @opencodehub/wiki bumped to 0.2.1

## [0.5.1](https://github.com/theagenticguy/opencodehub/compare/cli-v0.5.0...cli-v0.5.1) (2026-05-17)


### Bug Fixes

* **cli:** code-pack must open temporal store for embeddings staging ([#121](https://github.com/theagenticguy/opencodehub/issues/121)) ([f609542](https://github.com/theagenticguy/opencodehub/commit/f609542b9f7ba3476433cb58f918607176133423))

## [0.5.0](https://github.com/theagenticguy/opencodehub/compare/cli-v0.4.0...cli-v0.5.0) (2026-05-16)


### ⚠ BREAKING CHANGES

* drop detect-secrets; ship tuned betterleaks default config ([#118](https://github.com/theagenticguy/opencodehub/issues/118))
* lbug-only graph backend; rip DuckDB graph adapter ([#117](https://github.com/theagenticguy/opencodehub/issues/117))

### Features

* drop detect-secrets; ship tuned betterleaks default config ([#118](https://github.com/theagenticguy/opencodehub/issues/118)) ([d370f9e](https://github.com/theagenticguy/opencodehub/commit/d370f9e9ad3acbcc1231403e00bbee5cf0e487bd))
* lbug-only graph backend; rip DuckDB graph adapter ([#117](https://github.com/theagenticguy/opencodehub/issues/117)) ([49e14fd](https://github.com/theagenticguy/opencodehub/commit/49e14fdd3901e57dec3c86dd8645b5940d5d7c0a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/analysis bumped to 0.3.0
    * @opencodehub/ingestion bumped to 0.4.1
    * @opencodehub/mcp bumped to 0.4.0
    * @opencodehub/pack bumped to 0.2.0
    * @opencodehub/scanners bumped to 0.2.0
    * @opencodehub/search bumped to 0.2.0
    * @opencodehub/storage bumped to 0.2.0
    * @opencodehub/wiki bumped to 0.2.0

## [0.4.0](https://github.com/theagenticguy/opencodehub/compare/cli-v0.3.0...cli-v0.4.0) (2026-05-15)


### ⚠ BREAKING CHANGES

* WASM-only parser path; drop native tree-sitter from runtime ([#113](https://github.com/theagenticguy/opencodehub/issues/113))

### Features

* WASM-only parser path; drop native tree-sitter from runtime ([#113](https://github.com/theagenticguy/opencodehub/issues/113)) ([0a9e0cb](https://github.com/theagenticguy/opencodehub/commit/0a9e0cb65e3a4666204a2a80d3c41a8befee8269))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/analysis bumped to 0.2.0
    * @opencodehub/ingestion bumped to 0.4.0
    * @opencodehub/mcp bumped to 0.3.2
    * @opencodehub/pack bumped to 0.1.4

## [0.3.0](https://github.com/theagenticguy/opencodehub/compare/cli-v0.2.3...cli-v0.3.0) (2026-05-15)


### ⚠ BREAKING CHANGES

* **cli:** make `codehub analyze` the one-command index (fast + scan + sbom + coverage-auto; summaries opt-in) ([#110](https://github.com/theagenticguy/opencodehub/issues/110))
* **plugin:** the five slash commands (/probe, /verdict, /owners, /audit-deps, /rename) shipped by the Claude Code plugin are gone with no backward compatibility. Slash commands as a plugin surface are deprecated; the same workflows are still available via:

### Features

* **cli:** make `codehub analyze` the one-command index (fast + scan + sbom + coverage-auto; summaries opt-in) ([#110](https://github.com/theagenticguy/opencodehub/issues/110)) ([62bff2f](https://github.com/theagenticguy/opencodehub/commit/62bff2fe81a6d734747d4196cbb025af0e7bbbce))
* **plugin:** remove deprecated Claude Code slash commands ([5769fc1](https://github.com/theagenticguy/opencodehub/commit/5769fc16446107d0b8f8faadd1fd306c53e3b999))

## [0.2.3](https://github.com/theagenticguy/opencodehub/compare/cli-v0.2.2...cli-v0.2.3) (2026-05-12)


### Bug Fixes

* **cli:** codehub --version reads the real version from package.json ([bac9b61](https://github.com/theagenticguy/opencodehub/commit/bac9b61d6df0a228e3f15b9d95581c79178de339))
* **cli:** ship dist/plugin-assets and dist/commands/ci-templates in npm tarball ([e6df976](https://github.com/theagenticguy/opencodehub/commit/e6df9760d5df3f246bfa047f8d2bb11f08c37050))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/ingestion bumped to 0.3.2
    * @opencodehub/mcp bumped to 0.3.1
    * @opencodehub/pack bumped to 0.1.3

## [0.2.2](https://github.com/theagenticguy/opencodehub/compare/cli-v0.2.1...cli-v0.2.2) (2026-05-12)


### Bug Fixes

* **repo:** track all 17 packages in release-please + republish pack/cobol-proleap on fixed ingestion ([f4656d5](https://github.com/theagenticguy/opencodehub/commit/f4656d5f5f3faf6980ba872672191142eae3d722))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/analysis bumped to 0.1.2
    * @opencodehub/core-types bumped to 0.3.0
    * @opencodehub/embedder bumped to 0.1.2
    * @opencodehub/ingestion bumped to 0.3.1
    * @opencodehub/mcp bumped to 0.3.0
    * @opencodehub/pack bumped to 0.1.2
    * @opencodehub/policy bumped to 0.1.1
    * @opencodehub/sarif bumped to 0.1.2
    * @opencodehub/scanners bumped to 0.1.2
    * @opencodehub/search bumped to 0.1.2
    * @opencodehub/storage bumped to 0.1.2
    * @opencodehub/wiki bumped to 0.1.1

## [0.2.1](https://github.com/theagenticguy/opencodehub/compare/cli-v0.2.0...cli-v0.2.1) (2026-05-12)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/ingestion bumped to 0.3.0

## [0.2.0](https://github.com/theagenticguy/opencodehub/compare/cli-v0.1.0...cli-v0.2.0) (2026-05-12)


### ⚠ BREAKING CHANGES

* replace LSP oracle with SCIP indexers (TS/Py/Go/Rust/Java) ([#32](https://github.com/theagenticguy/opencodehub/issues/32))

### Features

* artifact factory + codehub init + CI UX fixes ([#38](https://github.com/theagenticguy/opencodehub/issues/38)) ([d6ffafa](https://github.com/theagenticguy/opencodehub/commit/d6ffafac74f04212458f4eafaba22146505f7490))
* **cli:** add --granularity flag to analyze for hierarchical embeddings ([defa9b6](https://github.com/theagenticguy/opencodehub/commit/defa9b6dd9d686daaaf51f561c81c2bb02dbed87))
* **cli:** add --strict-detectors flag + ts-morph optional dep ([329f5c3](https://github.com/theagenticguy/opencodehub/commit/329f5c3e5c3429c5f160d7ce283c0115ea0b8934))
* **cli:** add exact-name resolver and disambiguation flags to context ([7f279a9](https://github.com/theagenticguy/opencodehub/commit/7f279a9a63b36be969198f2b39d26ed86ceb814b))
* **cli:** flip query hybrid-by-default with --bm25-only + --rerank-top-k ([3e924b5](https://github.com/theagenticguy/opencodehub/commit/3e924b5dcf35cb3953bf069cfbbabfd8ae643cf6))
* detect-secrets as 20th scanner (Track B) ([#72](https://github.com/theagenticguy/opencodehub/issues/72)) ([8fbdd61](https://github.com/theagenticguy/opencodehub/commit/8fbdd61715ae61386a7a3b49ac2b036b1f6d31dd))
* **embedder:** replace Arctic Embed XS with gte-modernbert-base ([#31](https://github.com/theagenticguy/opencodehub/issues/31)) ([1214071](https://github.com/theagenticguy/opencodehub/commit/12140717414c6efbd0e1ebb3f3810ce612f2de50))
* **ingestion:** WASM fallback via web-tree-sitter + --wasm-only flag ([cecb401](https://github.com/theagenticguy/opencodehub/commit/cecb4011fad9aebb25c7169c41ce28f366f57d64))
* initial public release of opencodehub v0.1.1 ([3f23006](https://github.com/theagenticguy/opencodehub/commit/3f230065fe17c7c0b4c5d7568063b786fb72c81f))
* M7 LadybugDB default + IGraphStore abstraction hardening (Track A) ([#71](https://github.com/theagenticguy/opencodehub/issues/71)) ([0175113](https://github.com/theagenticguy/opencodehub/commit/017511304fe050e69f92e3c3eb0bdad92235c9e0))
* **mcp,cli:** join symbol summaries into query results (P04 surface) ([3d73b65](https://github.com/theagenticguy/opencodehub/commit/3d73b65aac852d23871c70468b9521103123d5e8))
* replace LSP oracle with SCIP indexers (TS/Py/Go/Rust/Java) ([#32](https://github.com/theagenticguy/opencodehub/issues/32)) ([1cceb24](https://github.com/theagenticguy/opencodehub/commit/1cceb24e876fafed06e2742952242efe06a21870))
* **scanners:** persist partialFingerprint, baselineState, suppressedJson ([fb4585d](https://github.com/theagenticguy/opencodehub/commit/fb4585d5f37afd9921917d46f25017adc6fd02ed))
* **search:** add filter-aware zoom retrieval across hierarchical tiers ([5ab80c4](https://github.com/theagenticguy/opencodehub/commit/5ab80c4760b34babef067b8ea4129294bb54c405))
* v1 finalize Track C — debt sweep (7 ACs) ([#73](https://github.com/theagenticguy/opencodehub/issues/73)) ([06d2bb1](https://github.com/theagenticguy/opencodehub/commit/06d2bb17ffae9d74783bd917f417841bd14c7561))


### Bug Fixes

* **cli:** accurate doctor native-binding + int8 weights checks ([fb569f9](https://github.com/theagenticguy/opencodehub/commit/fb569f9e4ca21be1046206a315fdb9638b28f70a))
* **storage:** wire @ladybugdb/core binding, fix lbug open() guards, upgrade pnpm v10→v11 ([#93](https://github.com/theagenticguy/opencodehub/issues/93)) ([78d6a85](https://github.com/theagenticguy/opencodehub/commit/78d6a8549ef450888e231427dbc1df673d19a9b6))


### Performance

* **embeddings:** cross-node batching + worker pool ([#33](https://github.com/theagenticguy/opencodehub/issues/33)) ([acb59d0](https://github.com/theagenticguy/opencodehub/commit/acb59d0dede2e7936ce7af0b7c43fb9ed1a100e6))


### Documentation

* **repo:** pre-publish npm readiness — READMEs, GOVERNANCE, CODEOWNERS, package metadata ([dd10f72](https://github.com/theagenticguy/opencodehub/commit/dd10f72aa490136076bf0632cccd2965c6b17e23))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/analysis bumped to 0.1.1
    * @opencodehub/core-types bumped to 0.2.0
    * @opencodehub/embedder bumped to 0.1.1
    * @opencodehub/ingestion bumped to 0.2.0
    * @opencodehub/mcp bumped to 0.2.0
    * @opencodehub/sarif bumped to 0.1.1
    * @opencodehub/scanners bumped to 0.1.1
    * @opencodehub/search bumped to 0.1.1
    * @opencodehub/storage bumped to 0.1.1
