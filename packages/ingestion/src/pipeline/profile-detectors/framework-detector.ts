/**
 * Back-compat shim for `framework-detector`.
 *
 * Re-exports the framework dispatcher from `@opencodehub/frameworks` so
 * callers that still import from the old profile-detectors path continue
 * to compile. Slated for removal after one release per roadmap §M4 T-M4-7.
 *
 * @deprecated Import from `@opencodehub/frameworks` instead.
 */

export {
  detectFrameworksStructured,
  type FrameworkDetectorInput,
} from "@opencodehub/frameworks";
