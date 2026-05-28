# Changelog

## [0.6.4](https://github.com/theagenticguy/opencodehub/compare/root-v0.6.3...root-v0.6.4) (2026-05-28)


### Documentation

* **repo:** add 2 release-recovery durable lessons (v0.6.2→v0.6.3) ([#149](https://github.com/theagenticguy/opencodehub/issues/149)) ([6a59d38](https://github.com/theagenticguy/opencodehub/commit/6a59d38a8e1e6758bb764e594c2164b4cfe775df))

## [0.6.3](https://github.com/theagenticguy/opencodehub/compare/root-v0.6.2...root-v0.6.3) (2026-05-28)


### Bug Fixes

* **ingestion:** re-vendor web-tree-sitter 0.26.9 runtime wasm ([#147](https://github.com/theagenticguy/opencodehub/issues/147)) ([9a146a5](https://github.com/theagenticguy/opencodehub/commit/9a146a5948981559bbad7bf5490c86406640a010))

## [0.6.2](https://github.com/theagenticguy/opencodehub/compare/root-v0.6.1...root-v0.6.2) (2026-05-28)


### Bug Fixes

* harden SCIP proto-reader bounds; drop dead native tree-sitter doctor probe ([#138](https://github.com/theagenticguy/opencodehub/issues/138)) ([b1a4772](https://github.com/theagenticguy/opencodehub/commit/b1a4772528ad573962d549e11479e5796608c362))


### Performance

* **ingestion:** O(N) complexity lookup; fix sql hint; reuse openStoreForCommand ([#142](https://github.com/theagenticguy/opencodehub/issues/142)) ([976b877](https://github.com/theagenticguy/opencodehub/commit/976b8773dbb96dcc3de6b0c64840e2a63dc5b7d7))


### Documentation

* **repo:** add 2 ERPAVal durable lessons from PR [#138](https://github.com/theagenticguy/opencodehub/issues/138) Compound phase ([#140](https://github.com/theagenticguy/opencodehub/issues/140)) ([ffd2435](https://github.com/theagenticguy/opencodehub/commit/ffd2435b43e6b32ea2ee1fd0fc88c9f9285765d5))
* **repo:** add collapse-parallel-switches-into-record-registry lesson ([#144](https://github.com/theagenticguy/opencodehub/issues/144)) ([b1685f5](https://github.com/theagenticguy/opencodehub/commit/b1685f595300d665fe7442fea781e5b21cab4ab1))
* sweep stale ADR-0015/0016 prose; unify CI test install path ([#146](https://github.com/theagenticguy/opencodehub/issues/146)) ([3b2e05e](https://github.com/theagenticguy/opencodehub/commit/3b2e05ee19b9d42351bf99659cd4bc26dd0f98bd))


### Refactoring

* drop dead materialize() + cross-backend parity script (−425 LOC) ([#141](https://github.com/theagenticguy/opencodehub/issues/141)) ([216121a](https://github.com/theagenticguy/opencodehub/commit/216121ac454f0d884bad3553db306de3e38e8d9f))
* **ingestion:** collapse 3 IndexerKind switches into LANG_REGISTRY ([#143](https://github.com/theagenticguy/opencodehub/issues/143)) ([dea4001](https://github.com/theagenticguy/opencodehub/commit/dea4001093d7fe4583488ca171b4c7a87cdc1ba0))

## [0.6.1](https://github.com/theagenticguy/opencodehub/compare/root-v0.6.0...root-v0.6.1) (2026-05-17)


### Bug Fixes

* **cli:** code-pack must open temporal store for embeddings staging ([#121](https://github.com/theagenticguy/opencodehub/issues/121)) ([f609542](https://github.com/theagenticguy/opencodehub/commit/f609542b9f7ba3476433cb58f918607176133423))

## [0.6.0](https://github.com/theagenticguy/opencodehub/compare/root-v0.5.0...root-v0.6.0) (2026-05-16)


### ⚠ BREAKING CHANGES

* drop detect-secrets; ship tuned betterleaks default config ([#118](https://github.com/theagenticguy/opencodehub/issues/118))
* lbug-only graph backend; rip DuckDB graph adapter ([#117](https://github.com/theagenticguy/opencodehub/issues/117))

### Features

* drop detect-secrets; ship tuned betterleaks default config ([#118](https://github.com/theagenticguy/opencodehub/issues/118)) ([d370f9e](https://github.com/theagenticguy/opencodehub/commit/d370f9e9ad3acbcc1231403e00bbee5cf0e487bd))
* lbug-only graph backend; rip DuckDB graph adapter ([#117](https://github.com/theagenticguy/opencodehub/issues/117)) ([49e14fd](https://github.com/theagenticguy/opencodehub/commit/49e14fdd3901e57dec3c86dd8645b5940d5d7c0a))


### Bug Fixes

* **ci:** grant id-token: write at release-please.yml top level ([#115](https://github.com/theagenticguy/opencodehub/issues/115)) ([a87a6eb](https://github.com/theagenticguy/opencodehub/commit/a87a6eb0c57f9974a03a12979cd3a5ac9403061c))
* **ci:** install betterleaks via mise so the pre-release gate finds it ([#120](https://github.com/theagenticguy/opencodehub/issues/120)) ([522a4ec](https://github.com/theagenticguy/opencodehub/commit/522a4eca47b25582192af9cfd92cb9070c13f10c))
* **ci:** pre-release gate aggregator needs betterleaks (was detect-secrets) ([#119](https://github.com/theagenticguy/opencodehub/issues/119)) ([a6f3448](https://github.com/theagenticguy/opencodehub/commit/a6f3448d836e0f3e93c2ef0ccc19d53922e556cf))

## [0.5.0](https://github.com/theagenticguy/opencodehub/compare/root-v0.4.0...root-v0.5.0) (2026-05-15)


### ⚠ BREAKING CHANGES

* WASM-only parser path; drop native tree-sitter from runtime ([#113](https://github.com/theagenticguy/opencodehub/issues/113))

### Features

* WASM-only parser path; drop native tree-sitter from runtime ([#113](https://github.com/theagenticguy/opencodehub/issues/113)) ([0a9e0cb](https://github.com/theagenticguy/opencodehub/commit/0a9e0cb65e3a4666204a2a80d3c41a8befee8269))

## [0.4.0](https://github.com/theagenticguy/opencodehub/compare/root-v0.3.2...root-v0.4.0) (2026-05-15)


### ⚠ BREAKING CHANGES

* **cli:** make `codehub analyze` the one-command index (fast + scan + sbom + coverage-auto; summaries opt-in) ([#110](https://github.com/theagenticguy/opencodehub/issues/110))
* **plugin:** the five slash commands (/probe, /verdict, /owners, /audit-deps, /rename) shipped by the Claude Code plugin are gone with no backward compatibility. Slash commands as a plugin surface are deprecated; the same workflows are still available via:

### Features

* **cli:** make `codehub analyze` the one-command index (fast + scan + sbom + coverage-auto; summaries opt-in) ([#110](https://github.com/theagenticguy/opencodehub/issues/110)) ([62bff2f](https://github.com/theagenticguy/opencodehub/commit/62bff2fe81a6d734747d4196cbb025af0e7bbbce))
* **plugin:** remove deprecated Claude Code slash commands ([5769fc1](https://github.com/theagenticguy/opencodehub/commit/5769fc16446107d0b8f8faadd1fd306c53e3b999))

## [0.3.2](https://github.com/theagenticguy/opencodehub/compare/root-v0.3.1...root-v0.3.2) (2026-05-12)


### Bug Fixes

* **cli:** codehub --version reads the real version from package.json ([bac9b61](https://github.com/theagenticguy/opencodehub/commit/bac9b61d6df0a228e3f15b9d95581c79178de339))
* **cli:** ship dist/plugin-assets and dist/commands/ci-templates in npm tarball ([e6df976](https://github.com/theagenticguy/opencodehub/commit/e6df9760d5df3f246bfa047f8d2bb11f08c37050))
* **ingestion:** ship vendor/wasms in npm tarball ([6e3bf24](https://github.com/theagenticguy/opencodehub/commit/6e3bf24507bff60edcfe07532a65d6b3a0ece8f7))

## [0.3.1](https://github.com/theagenticguy/opencodehub/compare/root-v0.3.0...root-v0.3.1) (2026-05-12)


### Bug Fixes

* **repo:** track all 17 packages in release-please + republish pack/cobol-proleap on fixed ingestion ([f4656d5](https://github.com/theagenticguy/opencodehub/commit/f4656d5f5f3faf6980ba872672191142eae3d722))

## [0.3.0](https://github.com/theagenticguy/opencodehub/compare/root-v0.2.0...root-v0.3.0) (2026-05-12)


### ⚠ BREAKING CHANGES

* **ingestion:** OCH_NATIVE_PARSER=1 + Dart now throws instead of loading a native binding. Real impact: zero for npm installs; the binding never worked there anyway.

### Bug Fixes

* **ingestion:** drop tree-sitter-dart git-URL dep — Dart is WASM-only on npm ([b709f64](https://github.com/theagenticguy/opencodehub/commit/b709f64f73080ca1444e8f52f961009d581c3fdf))

## [0.2.0](https://github.com/theagenticguy/opencodehub/compare/root-v0.1.1...root-v0.2.0) (2026-05-12)


### ⚠ BREAKING CHANGES

* **release:** footers in the commit log.
* replace LSP oracle with SCIP indexers (TS/Py/Go/Rust/Java) ([#32](https://github.com/theagenticguy/opencodehub/issues/32))

### Features

* artifact factory + codehub init + CI UX fixes ([#38](https://github.com/theagenticguy/opencodehub/issues/38)) ([d6ffafa](https://github.com/theagenticguy/opencodehub/commit/d6ffafac74f04212458f4eafaba22146505f7490))
* cleanups ([bf1536e](https://github.com/theagenticguy/opencodehub/commit/bf1536e2a7e5979fa1a0f5960d3d792c60458c3b))
* **cli:** add --granularity flag to analyze for hierarchical embeddings ([defa9b6](https://github.com/theagenticguy/opencodehub/commit/defa9b6dd9d686daaaf51f561c81c2bb02dbed87))
* **cli:** add --strict-detectors flag + ts-morph optional dep ([329f5c3](https://github.com/theagenticguy/opencodehub/commit/329f5c3e5c3429c5f160d7ce283c0115ea0b8934))
* **cli:** add exact-name resolver and disambiguation flags to context ([7f279a9](https://github.com/theagenticguy/opencodehub/commit/7f279a9a63b36be969198f2b39d26ed86ceb814b))
* **cli:** flip query hybrid-by-default with --bm25-only + --rerank-top-k ([3e924b5](https://github.com/theagenticguy/opencodehub/commit/3e924b5dcf35cb3953bf069cfbbabfd8ae643cf6))
* **core-types:** scaffold v1.1 node-shape extensions for planned packets ([e17a4b5](https://github.com/theagenticguy/opencodehub/commit/e17a4b5c68beb193878904140d688f351fadb5a3))
* detect-secrets as 20th scanner (Track B) ([#72](https://github.com/theagenticguy/opencodehub/issues/72)) ([8fbdd61](https://github.com/theagenticguy/opencodehub/commit/8fbdd61715ae61386a7a3b49ac2b036b1f6d31dd))
* **embedder:** add SageMaker backend for remote embeddings ([9b5c53d](https://github.com/theagenticguy/opencodehub/commit/9b5c53d7f2cc7241a4794e6e095da0279887c28f))
* **embedder:** replace Arctic Embed XS with gte-modernbert-base ([#31](https://github.com/theagenticguy/opencodehub/issues/31)) ([1214071](https://github.com/theagenticguy/opencodehub/commit/12140717414c6efbd0e1ebb3f3810ce612f2de50))
* **gym:** add rust-spike trigger benchmark ([43c26d3](https://github.com/theagenticguy/opencodehub/commit/43c26d325a9d401312251a85c96d22da117b576a))
* **ingestion:** [@doc](https://github.com/doc) captures + description field populated ([d63dfa6](https://github.com/theagenticguy/opencodehub/commit/d63dfa6fc7fbcf56853f12d15c9524bef467e22f))
* **ingestion:** add receiver resolver + detector precision (P06) ([431f428](https://github.com/theagenticguy/opencodehub/commit/431f4285f39fba38b822936bdd73f24e72bf1ec4))
* **ingestion:** add top-20 framework detection catalog and dispatcher ([02f4864](https://github.com/theagenticguy/opencodehub/commit/02f48640f499551a596ef677b353d0c6103370d2))
* **ingestion:** capture MCP tool inputSchema as canonical JSON ([9872710](https://github.com/theagenticguy/opencodehub/commit/9872710674648f21c82227294dc88fdeb63b4ab0))
* **ingestion:** emit CodeElement stubs for external imports ([49eefe7](https://github.com/theagenticguy/opencodehub/commit/49eefe7f1e46fdf43cec8ef2cfb121619e91c094))
* **ingestion:** emit file-level and community-level embeddings ([09a117f](https://github.com/theagenticguy/opencodehub/commit/09a117f6266772c197fe6385888f71fe9c767f51))
* **ingestion:** FastAPI, Spring, NestJS, Rails route detectors ([62bebfb](https://github.com/theagenticguy/opencodehub/commit/62bebfbb6ccf4883482cc73d2f879d1e604a4eeb))
* **ingestion:** Go IMPLEMENTS method-set resolver + C++20 import ([85c60f9](https://github.com/theagenticguy/opencodehub/commit/85c60f99712d5ff30a54c7bb7a5d8c83f1acbcd5))
* **ingestion:** nested .gitignore with layered negation ([40b5286](https://github.com/theagenticguy/opencodehub/commit/40b52863e83aad27fc4aff691909d31b7f46efca))
* **ingestion:** populate DependencyNode license from manifest ([f947194](https://github.com/theagenticguy/opencodehub/commit/f947194014c18f839b407e1ce388390aa47c23a6))
* **ingestion:** provider-driven complexity + Halstead volume ([5e1379a](https://github.com/theagenticguy/opencodehub/commit/5e1379a3597ecb3d290fde87fbbbdfd0f573eba1))
* **ingestion:** soft-fail summarize on credential errors, thread summaryModel ([d90eb38](https://github.com/theagenticguy/opencodehub/commit/d90eb387ea378a2e6e90ba6bda0ab8afcfdfdf87))
* **ingestion:** WASM fallback via web-tree-sitter + --wasm-only flag ([cecb401](https://github.com/theagenticguy/opencodehub/commit/cecb4011fad9aebb25c7169c41ce28f366f57d64))
* **ingestion:** wire framework catalog into profile phase ([d491401](https://github.com/theagenticguy/opencodehub/commit/d4914011721e60cb51e7ea1124a9602df39a36ab))
* initial public release of opencodehub v0.1.1 ([3f23006](https://github.com/theagenticguy/opencodehub/commit/3f230065fe17c7c0b4c5d7568063b786fb72c81f))
* M7 LadybugDB default + IGraphStore abstraction hardening (Track A) ([#71](https://github.com/theagenticguy/opencodehub/issues/71)) ([0175113](https://github.com/theagenticguy/opencodehub/commit/017511304fe050e69f92e3c3eb0bdad92235c9e0))
* **mcp,cli:** join symbol summaries into query results (P04 surface) ([3d73b65](https://github.com/theagenticguy/opencodehub/commit/3d73b65aac852d23871c70468b9521103123d5e8))
* **mcp:** short-circuit list_findings_delta via stored baselineState ([4d9c187](https://github.com/theagenticguy/opencodehub/commit/4d9c187ebc790af7acb1165bdb5a80910b002ab7))
* **mcp:** surface structured FrameworkDetection in project_profile tool ([15fb309](https://github.com/theagenticguy/opencodehub/commit/15fb3093b0723d65065229092ef2c4e08a12bcc7))
* replace LSP oracle with SCIP indexers (TS/Py/Go/Rust/Java) ([#32](https://github.com/theagenticguy/opencodehub/issues/32)) ([1cceb24](https://github.com/theagenticguy/opencodehub/commit/1cceb24e876fafed06e2742952242efe06a21870))
* **scanners:** persist partialFingerprint, baselineState, suppressedJson ([fb4585d](https://github.com/theagenticguy/opencodehub/commit/fb4585d5f37afd9921917d46f25017adc6fd02ed))
* **search:** add filter-aware zoom retrieval across hierarchical tiers ([5ab80c4](https://github.com/theagenticguy/opencodehub/commit/5ab80c4760b34babef067b8ea4129294bb54c405))
* **search:** extract tryOpenEmbedder + embeddingsPopulated, demote NullEmbedder throw ([c4cc680](https://github.com/theagenticguy/opencodehub/commit/c4cc68083f69fa6dc31562867f431875ee9b3da9))
* **storage:** add granularity column to embeddings for hierarchical retrieval ([b5bd5f8](https://github.com/theagenticguy/opencodehub/commit/b5bd5f8d093850d75ed99d01106f2c2484e3b067))
* **storage:** add summary fields to SearchResult and batch lookup helper ([4944a56](https://github.com/theagenticguy/opencodehub/commit/4944a56f73fc05492926ce4c1023742367d9bca4))
* **storage:** persist structured FrameworkDetection in frameworks_json ([75423fe](https://github.com/theagenticguy/opencodehub/commit/75423febad556f2357c8d2c20c333425035aa2bf))
* **storage:** populate reserved complexity, coverage, deadness columns ([c81e4c3](https://github.com/theagenticguy/opencodehub/commit/c81e4c385961e9326569066f8f9d596bc6b1779a))
* v1 finalize Track C — debt sweep (7 ACs) ([#73](https://github.com/theagenticguy/opencodehub/issues/73)) ([06d2bb1](https://github.com/theagenticguy/opencodehub/commit/06d2bb17ffae9d74783bd917f417841bd14c7561))
* v1 finalize Track D — dogfood polish (6 ACs) ([#75](https://github.com/theagenticguy/opencodehub/issues/75)) ([e9da048](https://github.com/theagenticguy/opencodehub/commit/e9da04887c319a3b18da99eef125e96fb576f0e8))


### Bug Fixes

* **ci:** pin gopls@v0.18.1 for Go 1.23 + add pnpm build-script allowlist ([c78b31d](https://github.com/theagenticguy/opencodehub/commit/c78b31db40b938acbd71aedd6bb91df381541712))
* **cli:** accurate doctor native-binding + int8 weights checks ([fb569f9](https://github.com/theagenticguy/opencodehub/commit/fb569f9e4ca21be1046206a315fdb9638b28f70a))
* **deps:** bump minimatch override to 9.0.7 (GHSA-23c5/-7r86) ([7f6e2ae](https://github.com/theagenticguy/opencodehub/commit/7f6e2aeaccc5f1f27cc157723745c2ef5d2afd43))
* **deps:** pin brace-expansion/minimatch/picomatch to patched versions ([5a7d1e0](https://github.com/theagenticguy/opencodehub/commit/5a7d1e0fa5d436d3ac8472593ddb645448a8bea3))
* **deps:** refresh pnpm-lock.yaml with ts-morph optional dep from P06 ([0dfee11](https://github.com/theagenticguy/opencodehub/commit/0dfee11146cbe69550ace5bfde6f1b78b81d4a97))
* **docs:** rename agents/*.md to .mdx so JSX components render ([#89](https://github.com/theagenticguy/opencodehub/issues/89)) ([d2d8bc7](https://github.com/theagenticguy/opencodehub/commit/d2d8bc724359fb55211068540b1cd7353d9f1c23))
* **gym:** update corpus test waiver ID to window.desktop after PR [#38](https://github.com/theagenticguy/opencodehub/issues/38) rename ([933b5f2](https://github.com/theagenticguy/opencodehub/commit/933b5f2a6e4ebae77fb16a886f4e3ad2dd8bd059))
* **ingestion:** enumerate git submodule paths in the scan phase ([d290d04](https://github.com/theagenticguy/opencodehub/commit/d290d048252e3035dae8078197133d222db3edf3))
* **ingestion:** skip submodule paths in the ownership blame pass ([e28f3e6](https://github.com/theagenticguy/opencodehub/commit/e28f3e64ecc30656e65625b5ca57658aaa3620a0))
* **repo:** replace stale lsp-oracle tsconfig reference with scip-ingest ([0ce5e29](https://github.com/theagenticguy/opencodehub/commit/0ce5e294c9b89d449627aa0f9986cbe805e91ac5))
* **scip-ingest:** resolve caller/callee correctly for SCIP edges ([c15f928](https://github.com/theagenticguy/opencodehub/commit/c15f9286550646f254b0d37e7e3d82aa080d96d6))
* **storage:** wire @ladybugdb/core binding, fix lbug open() guards, upgrade pnpm v10→v11 ([#93](https://github.com/theagenticguy/opencodehub/issues/93)) ([78d6a85](https://github.com/theagenticguy/opencodehub/commit/78d6a8549ef450888e231427dbc1df673d19a9b6))


### Performance

* **embeddings:** cross-node batching + worker pool ([#33](https://github.com/theagenticguy/opencodehub/issues/33)) ([acb59d0](https://github.com/theagenticguy/opencodehub/commit/acb59d0dede2e7936ce7af0b7c43fb9ed1a100e6))


### Documentation

* add SPECS, USECASE, and OBJECTIVES docs ([f3120de](https://github.com/theagenticguy/opencodehub/commit/f3120ded5db27624fa8aa1a1a2310f69d30c2f07))
* **adr:** record hierarchical embeddings decision (0004) ([6d28631](https://github.com/theagenticguy/opencodehub/commit/6d28631a0795bfc8726b9a66c8a8a159d08f3c4a))
* **adr:** update 0002 with P09 Phase 1 measurements ([92b9a1c](https://github.com/theagenticguy/opencodehub/commit/92b9a1cc4e47a9fd26979340acc98b7d40340668))
* clean-slate v1 — drop migration prose, milestone framing, 0.x caveats ([#90](https://github.com/theagenticguy/opencodehub/issues/90)) ([af88fbc](https://github.com/theagenticguy/opencodehub/commit/af88fbc6b8d6e86495c026bcbc3e6dbad968eedb))
* compound — durable lessons from docs site revival ([#88](https://github.com/theagenticguy/opencodehub/issues/88)) ([95642f0](https://github.com/theagenticguy/opencodehub/commit/95642f0fa9ac0bf3e6badb42f25b3b88b36b98df))
* compound — durable lessons from v1 upstream bug sweep ([#77](https://github.com/theagenticguy/opencodehub/issues/77)) ([60eef57](https://github.com/theagenticguy/opencodehub/commit/60eef57c5554c5bdb803f311ac692f596cdff9bd))
* deep refresh + sync + new architecture pages ([3693ddd](https://github.com/theagenticguy/opencodehub/commit/3693ddd57ff78978e8489c76ad7e654cdc21eb63))
* **repo:** durable lesson — set NODE_ENV at script scope for astro in CI ([18c159b](https://github.com/theagenticguy/opencodehub/commit/18c159bed2f84f780c4bdd91182adff739afd7e1))
* **repo:** durable lesson — stale tsconfig project references ([ea67d7a](https://github.com/theagenticguy/opencodehub/commit/ea67d7aae6d14e67beb5782d3dc8bbb07c93a74e))
* **repo:** EARS 006 spec — v1 finalize (M7 + constraint-10 + debt + dogfood) ([67198e3](https://github.com/theagenticguy/opencodehub/commit/67198e3c0d7187d8286f50f870602ac02915ea05))
* **repo:** pre-publish npm readiness — READMEs, GOVERNANCE, CODEOWNERS, package metadata ([dd10f72](https://github.com/theagenticguy/opencodehub/commit/dd10f72aa490136076bf0632cccd2965c6b17e23))
* restore Starlight site + refresh for v1 + agent-friendly USAGE section ([#87](https://github.com/theagenticguy/opencodehub/issues/87)) ([d9b2b30](https://github.com/theagenticguy/opencodehub/commit/d9b2b302246a9f2edfe796f28ce5d475e08d5af4))
* **site:** add Astro Starlight docs site + GitHub Pages deploy ([#34](https://github.com/theagenticguy/opencodehub/issues/34)) ([5ce0191](https://github.com/theagenticguy/opencodehub/commit/5ce01919c7515e0bf14272b447b8801d9abfa8b7))
* **site:** add llms.txt + Copy-as-Markdown + Open-in-ChatGPT/Claude ([#36](https://github.com/theagenticguy/opencodehub/issues/36)) ([149ba4e](https://github.com/theagenticguy/opencodehub/commit/149ba4efb7a9e785b86aefe59ef440cc30194906))
* **site:** inject LLM-nav banner + 'See also' footer into every .md ([#37](https://github.com/theagenticguy/opencodehub/issues/37)) ([77190a5](https://github.com/theagenticguy/opencodehub/commit/77190a5e8e1332440decb54e5ecc6f2aa7fb989b))
* strip legacy stanzas + capture session lessons ([85f6881](https://github.com/theagenticguy/opencodehub/commit/85f6881bd77dd1e185556fcb232b439cd1d3a07a))


### Refactoring

* consolidate repo-local dir references on META_DIR_NAME ([ce4b63d](https://github.com/theagenticguy/opencodehub/commit/ce4b63d298172dff3a26b1f5d4bf129c5cad7435))
* **core-types:** centralize LanguageId in core-types ([4c33fc7](https://github.com/theagenticguy/opencodehub/commit/4c33fc7b67afac65f9648c92fafe9532d42f2c60))
* **mcp:** consume shared tryOpenEmbedder + embeddingsPopulated from @opencodehub/search ([54f00de](https://github.com/theagenticguy/opencodehub/commit/54f00de8ed30326616e8ce6ca17367f606dc10da))
* **plugin:** file-level packet skeletons for codehub-document ([40a09c8](https://github.com/theagenticguy/opencodehub/commit/40a09c8e9698ad2fcb0804d3ac0a727b9b1a9f41))


### CI

* **release:** keep 0.x semver — breaking changes bump minor, feats bump patch ([a6ee4bf](https://github.com/theagenticguy/opencodehub/commit/a6ee4bf1081dd9a0623694aadae1e6f72cf60254))

## [Unreleased]

### Fixed

- **cli:** `scan` ingests SARIF into the scanned repo, not CWD.
- **cli:** `doctor` resolves native bindings from owner workspaces.
- **smoke-mcp:** asserts 29 tools, matching the v1.0 server surface.

### Docs

- **repo:** README v1.0 status, 29-tool surface, parse-runtime section,
  and accurate 17-package list (drops `eval` / `gym`, adds
  `cobol-proleap`, `frameworks`, `pack`, `policy`, `wiki`).
- **adr:** cross-link the two concurrently-numbered ADR 0013 files,
  flip 0011 + 0013-m7 status to Accepted, and scrub session-local
  spec coordinates from ADR text.
- **repo:** sync `CHANGELOG`, `USECASE`, `AGENTS`, and `OBJECTIVES`
  with v1 reality (tool count, language count, package set).

## [0.1.1](https://github.com/theagenticguy/opencodehub/compare/root-v0.1.0...root-v0.1.1) (2026-04-22)


### Bug Fixes

* **ci:** build workspace dist before typecheck so cross-package .d.ts resolves ([2935965](https://github.com/theagenticguy/opencodehub/commit/29359651d5e1a88226c86057082870d3e2f2a3fb))
* **ci:** pin osv-scanner reusable workflow to v2.3.5 ([fb7f137](https://github.com/theagenticguy/opencodehub/commit/fb7f137424d162478fdfce27ef8046465d0769a8))
