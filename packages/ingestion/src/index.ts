/**
 * @opencodehub/ingestion — indexing pipeline root barrel.
 *
 * Wave 3b ships the `parse` subsystem; Wave 3c ships the `providers`
 * subsystem (language-provider scaffolding + three-tier resolution + MRO).
 * Wave 5 adds the `pipeline` subsystem (DAG runner, scan/structure/parse
 * phases, top-level orchestrator). Later waves extend the default phase
 * set without changing the exported shape.
 */

export * as parse from "./parse/index.js";
export * as pipeline from "./pipeline/index.js";
export * as providers from "./providers/index.js";
