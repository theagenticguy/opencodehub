# Changelog

## [1.0.0](https://github.com/theagenticguy/opencodehub/compare/root-v0.1.1...root-v1.0.0) (2026-05-01)


### ⚠ BREAKING CHANGES

* replace LSP oracle with SCIP indexers (TS/Py/Go/Rust/Java) ([#32](https://github.com/theagenticguy/opencodehub/issues/32))

### Features

* artifact factory + codehub init + CI UX fixes ([#38](https://github.com/theagenticguy/opencodehub/issues/38)) ([6e12272](https://github.com/theagenticguy/opencodehub/commit/6e1227220ca8c0601e67f5c542d5611ccb36d004))
* cleanups ([0936e12](https://github.com/theagenticguy/opencodehub/commit/0936e129ff5d561737ae74bd93e38f2ca07adc70))
* **cli:** add --granularity flag to analyze for hierarchical embeddings ([d8ab649](https://github.com/theagenticguy/opencodehub/commit/d8ab6496c67b95b7d5e6fbb48cd0f818704b3547))
* **cli:** add --strict-detectors flag + ts-morph optional dep ([446f491](https://github.com/theagenticguy/opencodehub/commit/446f4911391a3bd91edf081d6d608b1ee5ec6638))
* **cli:** add exact-name resolver and disambiguation flags to context ([059d1dc](https://github.com/theagenticguy/opencodehub/commit/059d1dc297bed3f0c4aa7975119e228d99a8b8ea))
* **cli:** flip query hybrid-by-default with --bm25-only + --rerank-top-k ([b51ae13](https://github.com/theagenticguy/opencodehub/commit/b51ae135665a2d5d1741e75046eea6db4560f3b1))
* **core-types:** scaffold v1.1 node-shape extensions for planned packets ([0915b43](https://github.com/theagenticguy/opencodehub/commit/0915b43e0a4a768c37d0cc3cff94a5205fcc82ed))
* **embedder:** add SageMaker backend for remote embeddings ([16939f7](https://github.com/theagenticguy/opencodehub/commit/16939f720eb176659930464dab9a37a579684f72))
* **embedder:** replace Arctic Embed XS with gte-modernbert-base ([#31](https://github.com/theagenticguy/opencodehub/issues/31)) ([6b791c5](https://github.com/theagenticguy/opencodehub/commit/6b791c58ae30e464b21200f1917befd7c5a9477a))
* **gym:** add rust-spike trigger benchmark ([9b28096](https://github.com/theagenticguy/opencodehub/commit/9b28096670aea25fe638656b301b67f4f3f1eb86))
* **ingestion:** [@doc](https://github.com/doc) captures + description field populated ([b6f2a66](https://github.com/theagenticguy/opencodehub/commit/b6f2a66261e75dfff6b7b1514d7aa6d11e7e9b14))
* **ingestion:** add receiver resolver + detector precision (P06) ([d2bea02](https://github.com/theagenticguy/opencodehub/commit/d2bea02ec42487f072218b2b23108c4813ff232c))
* **ingestion:** add top-20 framework detection catalog and dispatcher ([a946864](https://github.com/theagenticguy/opencodehub/commit/a946864f7ba54721d214ae0c74e6412def66efa7))
* **ingestion:** capture MCP tool inputSchema as canonical JSON ([ec3063a](https://github.com/theagenticguy/opencodehub/commit/ec3063ae86f6b375c75ea7a71e0f19a791866987))
* **ingestion:** emit CodeElement stubs for external imports ([752023d](https://github.com/theagenticguy/opencodehub/commit/752023d9d1f9da8c46bbd3057c3c5a8f5e52424a))
* **ingestion:** emit file-level and community-level embeddings ([2b7ae6d](https://github.com/theagenticguy/opencodehub/commit/2b7ae6dc121f6ed3428f19c80e93fb4a42303939))
* **ingestion:** FastAPI, Spring, NestJS, Rails route detectors ([d6ca585](https://github.com/theagenticguy/opencodehub/commit/d6ca5855046ff11096c078f17396ed185b78840b))
* **ingestion:** Go IMPLEMENTS method-set resolver + C++20 import ([844b29d](https://github.com/theagenticguy/opencodehub/commit/844b29db99b1222b42b16ef69be880d8f7b481a1))
* **ingestion:** nested .gitignore with layered negation ([7ec7379](https://github.com/theagenticguy/opencodehub/commit/7ec7379e61fb87f1bc5e6d24e29b72cbe122531e))
* **ingestion:** populate DependencyNode license from manifest ([878dbec](https://github.com/theagenticguy/opencodehub/commit/878dbec604ba745c82148edc6c86378db7da40b0))
* **ingestion:** provider-driven complexity + Halstead volume ([f107b64](https://github.com/theagenticguy/opencodehub/commit/f107b64f85b38ad921cd608e7f5514d0d1f5ce9e))
* **ingestion:** soft-fail summarize on credential errors, thread summaryModel ([6b941d8](https://github.com/theagenticguy/opencodehub/commit/6b941d8aae2561c5b8a86b7ca2f0ae645af343eb))
* **ingestion:** WASM fallback via web-tree-sitter + --wasm-only flag ([856e054](https://github.com/theagenticguy/opencodehub/commit/856e054a255b10b540cf14ae8d6960aeded3dd48))
* **ingestion:** wire framework catalog into profile phase ([46b6a81](https://github.com/theagenticguy/opencodehub/commit/46b6a8167867308b93fdfa57ec5ea72e53f02da1))
* initial public release of opencodehub v0.1.1 ([7980892](https://github.com/theagenticguy/opencodehub/commit/7980892a37881ebd94004bdbca0db5f0eb818c8b))
* **mcp,cli:** join symbol summaries into query results (P04 surface) ([d45bf6e](https://github.com/theagenticguy/opencodehub/commit/d45bf6e3fc0ac6e8f4873acbf7fdbd8ba1589d71))
* **mcp:** short-circuit list_findings_delta via stored baselineState ([ba027c8](https://github.com/theagenticguy/opencodehub/commit/ba027c8825f3c0fa39430437f686a8ad3504bc6c))
* **mcp:** surface structured FrameworkDetection in project_profile tool ([281390c](https://github.com/theagenticguy/opencodehub/commit/281390c19a5224811aabd179341911f16b9f9ad9))
* replace LSP oracle with SCIP indexers (TS/Py/Go/Rust/Java) ([#32](https://github.com/theagenticguy/opencodehub/issues/32)) ([d757cd2](https://github.com/theagenticguy/opencodehub/commit/d757cd252dc8343d0074b1d5ddf5bc4293ccc146))
* **scanners:** persist partialFingerprint, baselineState, suppressedJson ([05cabfb](https://github.com/theagenticguy/opencodehub/commit/05cabfbfcb8fc74ee5a9824f6407b2e9045fa11c))
* **search:** add filter-aware zoom retrieval across hierarchical tiers ([3d5117a](https://github.com/theagenticguy/opencodehub/commit/3d5117abbc3cbf0a7bbc8b52808ea314337b6ce7))
* **search:** extract tryOpenEmbedder + embeddingsPopulated, demote NullEmbedder throw ([550ab48](https://github.com/theagenticguy/opencodehub/commit/550ab4804fd719ae63573df5adaec8eda9f88b46))
* **storage:** add granularity column to embeddings for hierarchical retrieval ([4b939a1](https://github.com/theagenticguy/opencodehub/commit/4b939a13ae853ca0930da58ea60ce0c25675f36b))
* **storage:** add summary fields to SearchResult and batch lookup helper ([2acde54](https://github.com/theagenticguy/opencodehub/commit/2acde5486255b6b7bcc4e4cae75f3bf76857cfc3))
* **storage:** persist structured FrameworkDetection in frameworks_json ([8c16e4a](https://github.com/theagenticguy/opencodehub/commit/8c16e4a9a520f540cc454300052b8387161f09ba))
* **storage:** populate reserved complexity, coverage, deadness columns ([81172ee](https://github.com/theagenticguy/opencodehub/commit/81172ee28d84670320703eb3520940d6476604e1))


### Bug Fixes

* **ci:** pin gopls@v0.18.1 for Go 1.23 + add pnpm build-script allowlist ([2c4f755](https://github.com/theagenticguy/opencodehub/commit/2c4f75527cc3c1b69328c4dd3f6c9327b47d62de))
* **cli:** accurate doctor native-binding + int8 weights checks ([116dafe](https://github.com/theagenticguy/opencodehub/commit/116dafebd12c00deb7ac1e20b2907cefc476f9f0))
* **deps:** bump minimatch override to 9.0.7 (GHSA-23c5/-7r86) ([5efcbac](https://github.com/theagenticguy/opencodehub/commit/5efcbacee7516768c7dd7a2fbe969885eb12c857))
* **deps:** pin brace-expansion/minimatch/picomatch to patched versions ([4bc7763](https://github.com/theagenticguy/opencodehub/commit/4bc7763e3f776c78c5b2c73de157c9ab981023ab))
* **deps:** refresh pnpm-lock.yaml with ts-morph optional dep from P06 ([c1b55c1](https://github.com/theagenticguy/opencodehub/commit/c1b55c1ad98ad5fe982158d3f3c6c2dbb24f717c))
* **gym:** update corpus test waiver ID to window.desktop after PR [#38](https://github.com/theagenticguy/opencodehub/issues/38) rename ([e58fa2f](https://github.com/theagenticguy/opencodehub/commit/e58fa2fa02e815e040e3a12b1d360bbc7e999c88))
* **ingestion:** enumerate git submodule paths in the scan phase ([929830b](https://github.com/theagenticguy/opencodehub/commit/929830bff9f8f232644053e478256186dfd575af))
* **ingestion:** skip submodule paths in the ownership blame pass ([736d157](https://github.com/theagenticguy/opencodehub/commit/736d157eff51eebbe0e4bf98e370a4f419fd3bee))
* **repo:** replace stale lsp-oracle tsconfig reference with scip-ingest ([be5f5cf](https://github.com/theagenticguy/opencodehub/commit/be5f5cf0afd01d0456fa56fe0e4076154f63a5fb))
* **scip-ingest:** resolve caller/callee correctly for SCIP edges ([77f670e](https://github.com/theagenticguy/opencodehub/commit/77f670e187ddfc2c4cc9f604006d111ef60c7b63))


### Performance

* **embeddings:** cross-node batching + worker pool ([#33](https://github.com/theagenticguy/opencodehub/issues/33)) ([f8454b5](https://github.com/theagenticguy/opencodehub/commit/f8454b50467ba8ecfded6ee599bda962bddfa203))


### Documentation

* add SPECS, USECASE, and OBJECTIVES docs ([f4d499c](https://github.com/theagenticguy/opencodehub/commit/f4d499c6ec5cb43509b60d3347db75bcf7b926c6))
* **adr:** record hierarchical embeddings decision (0004) ([42ae9b8](https://github.com/theagenticguy/opencodehub/commit/42ae9b841f62baeab7971fad6e392599e7d139fc))
* **adr:** update 0002 with P09 Phase 1 measurements ([63ffe90](https://github.com/theagenticguy/opencodehub/commit/63ffe90b018eb0cf0e2cb10d23506176b18810ce))
* deep refresh + sync + new architecture pages ([3e6e926](https://github.com/theagenticguy/opencodehub/commit/3e6e926d7e9e61e540bd8b6a8a985059844c2958))
* **repo:** durable lesson — set NODE_ENV at script scope for astro in CI ([5d03b49](https://github.com/theagenticguy/opencodehub/commit/5d03b49e93fa614248f8490224b2a49af3868261))
* **repo:** durable lesson — stale tsconfig project references ([4906d69](https://github.com/theagenticguy/opencodehub/commit/4906d6960d6933276a7b991f73111d82c6749748))
* **site:** add Astro Starlight docs site + GitHub Pages deploy ([#34](https://github.com/theagenticguy/opencodehub/issues/34)) ([e86b29f](https://github.com/theagenticguy/opencodehub/commit/e86b29f4ba14429f8fb8dc1c77a40c8ebd661844))
* **site:** add llms.txt + Copy-as-Markdown + Open-in-ChatGPT/Claude ([#36](https://github.com/theagenticguy/opencodehub/issues/36)) ([75b9988](https://github.com/theagenticguy/opencodehub/commit/75b998848b694a6234e3377b2428f8c76c49b998))
* **site:** inject LLM-nav banner + 'See also' footer into every .md ([#37](https://github.com/theagenticguy/opencodehub/issues/37)) ([560a7a6](https://github.com/theagenticguy/opencodehub/commit/560a7a659ade38d208e377c17a63690e95ea5c08))
* strip legacy stanzas + capture session lessons ([b848c2f](https://github.com/theagenticguy/opencodehub/commit/b848c2f2f6c2941ac9fae5e6261c1fd780297e8c))


### Refactoring

* consolidate repo-local dir references on META_DIR_NAME ([a77bb23](https://github.com/theagenticguy/opencodehub/commit/a77bb2397d92072f57256a900e6125be351eb720))
* **core-types:** centralize LanguageId in core-types ([b9caf99](https://github.com/theagenticguy/opencodehub/commit/b9caf99516e9f3317eacc0cae6e08dedce4a9448))
* **mcp:** consume shared tryOpenEmbedder + embeddingsPopulated from @opencodehub/search ([71f95cc](https://github.com/theagenticguy/opencodehub/commit/71f95cc0a90cd8ad111fa3a8128f9b55edbf8954))
* **plugin:** file-level packet skeletons for codehub-document ([a876c78](https://github.com/theagenticguy/opencodehub/commit/a876c782b1d3dbd88cc6df7c8467ff9ae31ce3ce))

## [0.1.1](https://github.com/theagenticguy/opencodehub/compare/root-v0.1.0...root-v0.1.1) (2026-04-22)


### Bug Fixes

* **ci:** build workspace dist before typecheck so cross-package .d.ts resolves ([2935965](https://github.com/theagenticguy/opencodehub/commit/29359651d5e1a88226c86057082870d3e2f2a3fb))
* **ci:** pin osv-scanner reusable workflow to v2.3.5 ([fb7f137](https://github.com/theagenticguy/opencodehub/commit/fb7f137424d162478fdfce27ef8046465d0769a8))
