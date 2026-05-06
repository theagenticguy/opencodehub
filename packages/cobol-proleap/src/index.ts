/**
 * @opencodehub/cobol-proleap — COBOL deep-parse bridge.
 *
 * Public entry point `parseCobolDeep()` accepts a list of file paths and an
 * options record pointing at an on-disk JAR + compiled wrapper, and returns
 * the ASG-derived symbol ref records. On JVM crash or malformed stdout, the
 * bridge silently falls back to the regex hot path in
 * `@opencodehub/ingestion` so a single bad file never aborts a batch.
 */

export { JreMissingError, MIN_JRE_MAJOR, parseJreMajor, requireJre17 } from "./jre-probe.js";
export { parseCobolDeep } from "./parse.js";
export { JarMissingError } from "./subprocess.js";
export type { CobolDeepElement, CobolDeepResult, ParseCobolDeepOptions } from "./types.js";
