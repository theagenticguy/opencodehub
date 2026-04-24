/**
 * Shared extraction result shapes for the route / tool / ORM detectors.
 *
 * These types are deliberately minimal: they describe the evidence a detector
 * has discovered in a single file (or, for filesystem-routed frameworks, a
 * group of files) without taking any dependency on the graph schema. The
 * routes / tools / orm pipeline phases turn these records into graph nodes
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
  readonly framework: "nextjs" | "express" | "fastapi" | "spring" | "nestjs" | "rails" | "unknown";
}

/** A single tool definition (MCP / JSON-RPC) discovered by heuristic scan. */
export interface ExtractedTool {
  /** Name string from the tool definition literal. */
  readonly toolName: string;
  /** Repo-relative path to the file that declared the tool. */
  readonly handlerFile: string;
  /** Description string from the tool definition literal, if present. */
  readonly description?: string;
  /**
   * Canonical (key-sorted) JSON-encoded `inputSchema` literal harvested
   * from the tool definition object, when present. Absent when the
   * detector can't find a parseable literal nearby.
   */
  readonly inputSchemaJson?: string;
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
  /**
   * Provenance tag: `"receiver-confirmed"` when the receiver type was
   * confirmed via import graph or ts-morph, `"heuristic"` when the emit
   * was based on regex alone (legacy behavior, used only when
   * `strictDetectors` is false and no import map is available).
   */
  readonly reason?: "receiver-confirmed" | "heuristic";
}

/**
 * Input bundle passed to file-scoped detectors. The `captures` field is
 * reserved for a future AST-driven path and is unused at MVP; detectors rely
 * on the file path and raw UTF-8 content.
 *
 * `importsByFile` + `tsMorphProject` are the P06 plumbing used by the
 * receiver resolver to confirm that a call's receiver truly originates
 * from the framework the detector claims. Both are optional — when
 * absent, detectors fall back to the pre-P06 regex-only behavior unless
 * `strictDetectors` is set.
 */
export interface ExtractInput {
  readonly filePath: string;
  readonly content: string;
  readonly captures?: readonly unknown[];
  /**
   * Per-file import declarations the parse phase already extracted.
   * Used by the receiver resolver's fast path.
   */
  readonly importsByFile?: ReadonlyMap<
    string,
    readonly import("./receiver-resolver.js").ImportedSymbol[]
  >;
  /** Optional ts-morph project for the receiver resolver's type-check path. */
  readonly tsMorphProject?: import("./receiver-resolver.js").TsMorphProject;
  /**
   * When `true`, drop heuristic-only matches entirely — detectors emit
   * only records whose receiver resolved successfully. Exposed through
   * the `codehub analyze --strict-detectors` flag.
   */
  readonly strictDetectors?: boolean;
}
