/**
 * Shared extraction result shapes for the route / tool / ORM detectors.
 *
 * These types are deliberately minimal: they describe the evidence a detector
 * has discovered in a single file (or, for filesystem-routed frameworks, a
 * group of files) without taking any dependency on the graph schema. Wave 6
 * pipeline phases are responsible for turning these records into graph nodes
 * and edges.
 */

/** A handler-to-URL mapping discovered by a route detector. */
export interface ExtractedRoute {
  /** Canonical URL path with `{param}` / `{+catchAll}` placeholders. */
  readonly url: string;
  /** HTTP method in uppercase, or `undefined` for filesystem pages. */
  readonly method?: string;
  /** Repo-relative path to the file that declared the route. */
  readonly handlerFile: string;
  /** Middleware identifiers observed on the route chain, in source order. */
  readonly middleware?: readonly string[];
  /** Response payload keys scraped from the handler body (best effort). */
  readonly responseKeys?: readonly string[];
  /** Framework the detector is claiming. */
  readonly framework: "nextjs" | "express" | "unknown";
}

/** A single tool definition (MCP / JSON-RPC) discovered by heuristic scan. */
export interface ExtractedTool {
  /** Name string from the tool definition literal. */
  readonly toolName: string;
  /** Repo-relative path to the file that declared the tool. */
  readonly handlerFile: string;
  /** Description string from the tool definition literal, if present. */
  readonly description?: string;
}

/** A file -> ORM model call edge discovered by regex scan. */
export interface ExtractedOrmEdge {
  /** Repo-relative path to the caller. */
  readonly callerFile: string;
  /** Model / table identifier as written in source. */
  readonly modelName: string;
  /** Operation identifier (e.g. "findMany", "create", "select"). */
  readonly operation: string;
  /** ORM family this edge belongs to. */
  readonly orm: "prisma" | "supabase";
  /** Detector confidence in [0, 1]. */
  readonly confidence: number;
}

/**
 * Input bundle passed to file-scoped detectors. The `captures` field is
 * reserved for a future AST-driven path and is unused at MVP; detectors rely
 * on the file path and raw UTF-8 content.
 */
export interface ExtractInput {
  readonly filePath: string;
  readonly content: string;
  readonly captures?: readonly unknown[];
}
