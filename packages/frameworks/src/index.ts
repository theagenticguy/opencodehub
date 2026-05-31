/**
 * `@opencodehub/frameworks` — framework detection over a curated catalog.
 *
 * The dispatcher (`detector.ts`) merges three stages into each
 * `FrameworkDetection` (`{name, version?, confidence, evidence[]}`):
 *   1. Manifest presence + declared deps (`package.json`, `pyproject.toml`,
 *      `pom.xml`, …)
 *   2. Lockfile exact versions, overriding manifest semver ranges
 *      (`package-lock.json`, `pnpm-lock.yaml`, `Gemfile.lock`,
 *      `poetry.lock`, `uv.lock`, `Cargo.lock`)
 *   4. Folder / file-marker convention (`app/`, `pages/`, `vite.config.ts`,
 *      `src/main/java/`, …)
 *
 * Two further stages ship as standalone, independently tested modules but
 * are not yet wired into the ingestion profile phase (their findings do not
 * reach `FrameworkDetection.evidence` until a caller passes the extra
 * inputs through):
 *   3. Config AST (`config-ast.ts`) — `next.config.*`, `astro.config.*`,
 *      `vite.config.*`, `spring.factories`; needs the config-file text.
 *   5. Import / SCIP (`imports.ts`) — consumes the graph's `IMPORTS` edges;
 *      needs the `KnowledgeGraph`.
 *
 * Every stage is pure-local file-system + string/regex inspection; no
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
