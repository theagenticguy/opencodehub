/**
 * @opencodehub/cobol-proleap — COBOL deep-parse bridge.
 *
 * Public entry point `parseCobolDeep()` accepts a list of file paths and an
 * options record pointing at an on-disk JAR + compiled wrapper, and returns
 * the ASG-derived symbol ref records. On JVM crash or malformed stdout, the
 * bridge silently falls back to the regex hot path in
 * `@opencodehub/ingestion` so a single bad file never aborts a batch.
 *
 * Scaffolded in commit 1; subprocess wiring + crash fallback land in commits
 * 2 and 4.
 */

export { parseCobolDeep } from "./parse.js";
export type { CobolDeepElement, CobolDeepResult, ParseCobolDeepOptions } from "./types.js";
