/**
 * Barrel of type re-exports so downstream packages can `import type { ... }`
 * from `@opencodehub/sarif` without reaching into `./schemas.js` or the
 * DefinitelyTyped `sarif` module directly.
 *
 * - `Sarif*` types here are zod-derived and line up with the slim subset
 *   we schematize.
 * - `SarifSpec` re-exports the full spec surface from @types/sarif for code
 *   paths that need ~80+ typed interfaces (e.g., downstream enrichers that
 *   touch CodeFlow, ThreadFlow, Fix, Artifact, Suppression, etc.).
 */

// Full SARIF 2.1.0 type surface from DefinitelyTyped.
export type * as SarifSpec from "sarif";

export type { EnrichmentInput, ResultEnrichment, RunEnrichment } from "./enrich.js";
export type {
  SarifArtifactLocation,
  SarifLocation,
  SarifLog,
  SarifMessage,
  SarifPhysicalLocation,
  SarifPropertyBag,
  SarifRegion,
  SarifResult,
  SarifRun,
  SarifTool,
  SarifToolDriver,
} from "./schemas.js";
