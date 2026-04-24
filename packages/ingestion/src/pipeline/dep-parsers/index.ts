/**
 * Per-ecosystem dependency parser registry.
 *
 * The `dependencies` pipeline phase consumes this map: it inspects the
 * scanned file list, dispatches each recognised manifest path to the
 * matching parser, and merges the returned `ParsedDependency[]` arrays
 * into the shared `KnowledgeGraph`.
 */

export { parseGoDeps } from "./go.js";
export { parseMavenDeps } from "./maven.js";
export { parseNpmDeps } from "./npm.js";
export { parseNugetDeps } from "./nuget.js";
export { parsePythonDeps } from "./python.js";
export { parseRustDeps } from "./rust.js";
export type {
  Ecosystem,
  ParseDepsFn,
  ParseDepsInput,
  ParsedDependency,
  WarnFn,
} from "./types.js";
export { compareParsedDependency, dedupAndSort } from "./types.js";
