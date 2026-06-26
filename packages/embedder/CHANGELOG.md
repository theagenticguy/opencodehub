# Changelog

## [0.2.0](https://github.com/theagenticguy/opencodehub/compare/embedder-v0.1.3...embedder-v0.2.0) (2026-06-26)


### ⚠ BREAKING CHANGES

* **embedder:** swap the local ONNX model from `gte-modernbert-base` (768-dim) to `codefuse-ai/F2LLM-v2-80M` (320-dim). The dimension change is incompatible with existing stores — re-index with `codehub analyze --embeddings`. The fingerprint guard already refuses queries against a stale store on a `modelId` mismatch.


### Features

* **embedder:** replace gte-modernbert-base with `codefuse-ai/F2LLM-v2-80M` (Qwen3-0.6B-Base derivative, 80.1M params, 320-dim). Last-token pooling + L2 normalization are baked into the ONNX graph — the graph emits a single already-unit-length `embedding` output of shape `[B, 320]`.
* **embedder:** add `embedQuery()` to the Embedder interface for query/document asymmetry — queries get an `Instruct: {instruction}\nQuery: {query}` prefix (instruction: "Given a code search query, retrieve the most relevant code snippet."), documents are embedded raw. Applied only at the hybrid-search query seam.
* **embedder:** ship the model as a custom ONNX export hosted as a GitHub release asset (`github.com/theagenticguy/opencodehub/releases/download/embed-v1/...`), SHA256-pinned in `model-pins.ts` (`F2LLM_V2_80M_PINS`, renamed from `GTE_MODERNBERT_BASE_PINS`). fp32 ~321 MB / int8 ~81 MB. Tokenizer is Qwen2 BPE (`tokenizer.json` + `tokenizer_config.json`). Runtime unchanged: `onnxruntime-web` (WASM), single-threaded deterministic. License: Apache-2.0.

## [0.1.3](https://github.com/theagenticguy/opencodehub/compare/embedder-v0.1.2...embedder-v0.1.3) (2026-06-01)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/core-types bumped to 0.4.0

## [0.1.2](https://github.com/theagenticguy/opencodehub/compare/embedder-v0.1.1...embedder-v0.1.2) (2026-05-12)


### Features

* detect-secrets as 20th scanner (Track B) ([#72](https://github.com/theagenticguy/opencodehub/issues/72)) ([8fbdd61](https://github.com/theagenticguy/opencodehub/commit/8fbdd61715ae61386a7a3b49ac2b036b1f6d31dd))
* **embedder:** add SageMaker backend for remote embeddings ([9b5c53d](https://github.com/theagenticguy/opencodehub/commit/9b5c53d7f2cc7241a4794e6e095da0279887c28f))
* **embedder:** replace Arctic Embed XS with gte-modernbert-base ([#31](https://github.com/theagenticguy/opencodehub/issues/31)) ([1214071](https://github.com/theagenticguy/opencodehub/commit/12140717414c6efbd0e1ebb3f3810ce612f2de50))
* initial public release of opencodehub v0.1.1 ([3f23006](https://github.com/theagenticguy/opencodehub/commit/3f230065fe17c7c0b4c5d7568063b786fb72c81f))
* v1 finalize Track C — debt sweep (7 ACs) ([#73](https://github.com/theagenticguy/opencodehub/issues/73)) ([06d2bb1](https://github.com/theagenticguy/opencodehub/commit/06d2bb17ffae9d74783bd917f417841bd14c7561))


### Documentation

* **repo:** pre-publish npm readiness — READMEs, GOVERNANCE, CODEOWNERS, package metadata ([dd10f72](https://github.com/theagenticguy/opencodehub/commit/dd10f72aa490136076bf0632cccd2965c6b17e23))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/core-types bumped to 0.3.0

## [0.1.1](https://github.com/theagenticguy/opencodehub/compare/embedder-v0.1.0...embedder-v0.1.1) (2026-05-12)


### Features

* detect-secrets as 20th scanner (Track B) ([#72](https://github.com/theagenticguy/opencodehub/issues/72)) ([8fbdd61](https://github.com/theagenticguy/opencodehub/commit/8fbdd61715ae61386a7a3b49ac2b036b1f6d31dd))
* **embedder:** add SageMaker backend for remote embeddings ([9b5c53d](https://github.com/theagenticguy/opencodehub/commit/9b5c53d7f2cc7241a4794e6e095da0279887c28f))
* **embedder:** replace Arctic Embed XS with gte-modernbert-base ([#31](https://github.com/theagenticguy/opencodehub/issues/31)) ([1214071](https://github.com/theagenticguy/opencodehub/commit/12140717414c6efbd0e1ebb3f3810ce612f2de50))
* initial public release of opencodehub v0.1.1 ([3f23006](https://github.com/theagenticguy/opencodehub/commit/3f230065fe17c7c0b4c5d7568063b786fb72c81f))
* v1 finalize Track C — debt sweep (7 ACs) ([#73](https://github.com/theagenticguy/opencodehub/issues/73)) ([06d2bb1](https://github.com/theagenticguy/opencodehub/commit/06d2bb17ffae9d74783bd917f417841bd14c7561))


### Documentation

* **repo:** pre-publish npm readiness — READMEs, GOVERNANCE, CODEOWNERS, package metadata ([dd10f72](https://github.com/theagenticguy/opencodehub/commit/dd10f72aa490136076bf0632cccd2965c6b17e23))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @opencodehub/core-types bumped to 0.2.0
