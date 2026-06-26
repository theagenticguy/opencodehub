# @opencodehub/embedder

Deterministic text embedder for OpenCodeHub. Uses the
`codefuse-ai/F2LLM-v2-80M` model (320-dim) via ONNX Runtime (WASM, CPU)
locally or Amazon SageMaker for larger deployments.

## Surface

```ts
import { embed, EmbedderBackend } from "@opencodehub/embedder";

// Local ONNX (default)
const vectors = await embed(["function foo(): void {}", "class Bar {}"]);

// SageMaker
const vectors = await embed(texts, { backend: EmbedderBackend.SageMaker });
```

- **Local backend** — runs `F2LLM-v2-80M` via `onnxruntime-web`
  (WASM, single-threaded, deterministic; no native bindings). Last-token
  pooling + L2 normalization are baked into the ONNX graph.
- **SageMaker backend** — sends batches to an endpoint via
  `@aws-sdk/client-sagemaker-runtime`; endpoint URL read from
  `OCH_SAGEMAKER_ENDPOINT`.
- Tokenisation is handled by `@huggingface/tokenizers` (WASM) so the
  output is identical regardless of backend.

## Env vars

| Variable | Default | Description |
|---|---|---|
| `OCH_EMBED_BACKEND` | `onnx` | `onnx` or `sagemaker` |
| `OCH_SAGEMAKER_ENDPOINT` | — | SageMaker real-time endpoint URL |
| `OCH_EMBED_DIM` | `320` | Expected embedding dimension (validation) |

## Design

- Embeddings are optional in the pipeline — the `embeddings` phase is a
  no-op unless explicitly enabled, so a default `codehub analyze` works
  fully offline.
- The SageMaker path is the recommended backend for CI and cloud
  deployments; the ONNX path is the default for local dev.
- `onnxruntime-web` runs the model as WASM with no native postinstall —
  the local backend ships zero native bindings.
