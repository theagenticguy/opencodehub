/**
 * Embedder-fingerprint compatibility check.
 *
 * The `embeddings` table on disk was populated by ONE specific embedder
 * — usually identified by its {@link Embedder.modelId} (e.g.
 * `f2llm-v2-80m/fp32`, `f2llm-v2-80m/sagemaker:<endpoint>`).
 * If the operator switches the active embedder between index runs (ONNX
 * → SageMaker, fp32 → int8, or a different model entirely) the vector
 * subspace differs even when the dim coincides — hybrid search
 * silently corrupts ranking with no error.
 *
 * `assertEmbedderCompatible` makes the mismatch loud:
 *   - PASS  → the persisted modelId equals the current modelId, OR the
 *             persisted modelId is unset (legacy store, never tagged).
 *   - PASS  → mismatch but the caller passed `force: true` (the operator
 *             knows the vectors might be stale and accepts the risk).
 *   - FAIL  → mismatch + no force — return an envelope with a remediation
 *             hint. The caller (cli/query, mcp/query) decides how to
 *             surface: cli exits 2, MCP returns a structured error.
 */

/** Stable remediation hint surfaced on every embedder-mismatch refusal. */
export const EMBEDDER_MISMATCH_HINT: string =
  "Re-run 'codehub analyze --force' or pass --force-backend-mismatch to " +
  "query with potentially stale vectors.";

export type EmbedderCompatibilityResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly persistedModelId: string;
      readonly currentModelId: string;
      readonly hint: string;
    };

/**
 * Compare the embedder modelId persisted in `store_meta.embedder_model_id`
 * against the modelId of the embedder the caller just opened.
 *
 * @param persistedModelId - `StoreMeta.embedderModelId` from the store —
 *   pass `undefined` for legacy stores that never recorded it (the
 *   compatibility check passes; the open-time backfill attributes the
 *   row to the current embedder with a one-shot stderr warning).
 * @param currentModelId - {@link Embedder.modelId} of the embedder the
 *   caller opened for this query.
 * @param force - When `true`, force the check to pass even on mismatch.
 *   Set by the cli `--force-backend-mismatch` flag and the equivalent
 *   `force_backend_mismatch` MCP tool option.
 */
export function assertEmbedderCompatible(
  persistedModelId: string | undefined,
  currentModelId: string,
  force: boolean,
): EmbedderCompatibilityResult {
  if (force) return { ok: true };
  if (persistedModelId === undefined) return { ok: true };
  if (persistedModelId === currentModelId) return { ok: true };
  return {
    ok: false,
    persistedModelId,
    currentModelId,
    hint: EMBEDDER_MISMATCH_HINT,
  };
}
