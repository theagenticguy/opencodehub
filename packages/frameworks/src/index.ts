/**
 * `@opencodehub/frameworks` — 5-stage framework detection over a curated
 * 23-entry registry.
 *
 * Stages (each emits `{name, version?, confidence, evidence[]}`):
 *   1. Manifest presence (`package.json`, `pyproject.toml`, `pom.xml`, …)
 *   2. Lockfile + exact versions (`package-lock.json`, `pnpm-lock.yaml`,
 *      `Gemfile.lock`, `poetry.lock`, `uv.lock`, `Cargo.lock`)
 *   3. Config AST (`next.config.*`, `astro.config.*`, `vite.config.*`,
 *      `spring.factories`)
 *   4. Folder convention (`app/`, `pages/`, `src/main/java/`, …)
 *   5. Import / SCIP usage patterns (consumes the graph's `IMPORTS` edges)
 *
 * All stages are pure-local file-system + string/regex inspection; no
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
