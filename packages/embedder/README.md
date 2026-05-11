# @opencodehub/embedder

Deterministic text embedder for OpenCodeHub. Uses the
`gte-modernbert-base` model via ONNX Runtime (CPU) locally or
Amazon SageMaker for larger deployments.

## Surface

```ts
import { embed, EmbedderBackend } from "@opencodehub/embedder";

// Local ONNX (default)
const vectors = await embed(["function foo(): void {}", "class Bar {}"]);

// SageMaker
const vectors = await embed(texts, { backend: EmbedderBackend.SageMaker });
```

- **Local backend** — runs `gte-modernbert-base` via `onnxruntime-node`
  (CPU only; CUDA postinstall is suppressed via `.npmrc`).
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
| `OCH_EMBED_DIM` | `768` | Expected embedding dimension (validation) |

## Design

- Embeddings are optional in the pipeline — the `embeddings` phase is a
  no-op unless explicitly enabled, so a default `codehub analyze` works
  fully offline.
- The SageMaker path is the recommended backend for CI and cloud
  deployments; the ONNX path is the default for local dev.
- `onnxruntime_node_install_cuda=skip` in `.npmrc` prevents the ~400 MB
  CUDA EP postinstall download.
