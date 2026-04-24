/**
 * @opencodehub/ingestion — indexing pipeline root barrel.
 *
 * Exports the `parse`, `providers`, and `pipeline` subsystems. Extending
 * the default phase set does not change the exported shape.
 */

export * as parse from "./parse/index.js";
export * as pipeline from "./pipeline/index.js";
export * as providers from "./providers/index.js";
