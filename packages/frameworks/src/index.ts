/**
 * `@opencodehub/frameworks` — framework detection over a curated catalog.
 *
 * The dispatcher (`detector.ts`) merges five stages into each
 * `FrameworkDetection` (`{name, version?, confidence, evidence[]}`):
 *   1. Manifest presence + declared deps (`package.json`, `pyproject.toml`,
 *      `pom.xml`, …)
 *   2. Lockfile exact versions, overriding manifest semver ranges
 *      (`package-lock.json`, `pnpm-lock.yaml`, `Gemfile.lock`,
 *      `poetry.lock`, `uv.lock`, `Cargo.lock`)
 *   3. Config AST (`config-ast.ts`) — `next.config.*`, `astro.config.*`,
 *      `vite.config.*`, `spring.factories`. The wrapper pre-reads these and
 *      passes `configText`; the dispatcher merges the findings as stage-3
 *      evidence into a framework that already hit on a manifest/layout signal
 *      (it corroborates, never creates a detection on its own).
 *   4. Folder / file-marker convention (`app/`, `pages/`, `vite.config.ts`,
 *      `src/main/java/`, …)
 *   5. Import / SCIP (`imports.ts`) — reads the graph's `IMPORTS` edges to
 *      external-import stubs via the `importGraph` input. The profile phase
 *      depends on `parse` so those edges exist by detection time. A
 *      `deterministic` (scip-resolved) import can create a detection on its
 *      own; a `heuristic` import only corroborates an existing hit.
 *
 * Every stage is pure-local file-system / graph + string/regex inspection; no
 * network, no LLM, no subprocess.
 */

export type { Evidence, FrameworkDetection } from "@opencodehub/core-types";
export {
  FRAMEWORK_CATALOG,
  type FrameworkEcosystem,
  type FrameworkRule,
  type FrameworkTier,
  type ManifestKey,
  type VariantDefinition,
} from "./catalog.js";
export { detectFrameworksStructured, type FrameworkDetectorInput } from "./detector.js";
export {
  detectFrameworks,
  detectFrameworksDetailed,
  type FrameworkDetectionInput,
  type FrameworkFileInput,
} from "./frameworks.js";
export { detectManifests } from "./manifests.js";
export {
  CONFIG_AST_FILES,
  type ConfigAstFinding,
  inspectConfigAst,
} from "./stages/config-ast.js";
export {
  detectFromImports,
  FRAMEWORK_ROOT_MODULES,
  type ImportEdgeLike,
  type ImportFinding,
  type ImportNodeLike,
  type ImportStageGraph,
} from "./stages/imports.js";
export {
  indexResolutions,
  KNOWN_LOCKFILES,
  type LockfileFile,
  type LockfileResolution,
  parseLockfile,
} from "./stages/lockfile.js";
export {
  VARIANT_RESOLVERS,
  type VariantResolveInput,
  type VariantResolver,
} from "./variant-detectors.js";
