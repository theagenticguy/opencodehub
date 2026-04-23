/**
 * @opencodehub/embedder — deterministic ONNX text embedder.
 *
 * The public surface is intentionally small: an {@link Embedder} interface,
 * an {@link EmbedderConfig}, and the {@link openOnnxEmbedder} factory that
 * opens a 384-dim Arctic Embed XS embedder backed by onnxruntime-node. Weight
 * files are installed out-of-band by `codehub setup --embeddings`; this
 * module never touches the network.
 */

export {
  ARCTIC_EMBED_XS_PINS,
  ARCTIC_EMBED_XS_REPO,
  embedderModelId,
  type PinnedFile,
  type VariantPins,
} from "./model-pins.js";
export { openOnnxEmbedder } from "./onnx-embedder.js";
export {
  getDefaultModelRoot,
  modelFileName,
  resolveModelDir,
  TOKENIZER_FILES,
} from "./paths.js";
export {
  type Embedder,
  type EmbedderConfig,
  EmbedderNotSetupError,
} from "./types.js";
