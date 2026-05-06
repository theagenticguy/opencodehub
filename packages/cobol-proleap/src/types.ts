/**
 * Shared types for the cobol-proleap bridge.
 *
 * The element shape deliberately mirrors `CobolElement` from the regex hot
 * path (`@opencodehub/ingestion`) so downstream graph-ingestion code can
 * treat deep-parse and regex emissions uniformly — confidence is the only
 * discriminator.
 */

import type { LanguageId } from "@opencodehub/core-types";

export type CobolDeepElementKind =
  | "program-id"
  | "paragraph"
  | "perform"
  | "copy"
  | "cics"
  | "data-item"
  | "file-descriptor";

export interface CobolDeepElement {
  readonly kind: CobolDeepElementKind;
  readonly name: string;
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly language: LanguageId;
  /**
   * "parse" when the ASG confirmed the construct; "heuristic" when the row
   * originated from the regex fallback path after a JVM crash.
   */
  readonly confidence: "parse" | "heuristic";
  readonly snippet?: string;
}

/** Options for {@link parseCobolDeep}. */
export interface ParseCobolDeepOptions {
  /**
   * Absolute path to the uwol/cobol-parser JAR. Typically
   * `~/.codehub/vendor/proleap/proleap-cobol-parser-<version>.jar`.
   */
  readonly jarPath: string;
  /**
   * Absolute path to the directory containing the compiled wrapper class
   * (`cobol_to_scip.class`). The wrapper is compiled at setup time.
   */
  readonly wrapperClassPath: string;
  /**
   * Override `java` binary. Default: "java" on PATH.
   */
  readonly javaBin?: string;
  /**
   * Max files per JVM invocation. Amortizes the ~500 ms startup cost across
   * a batch. Default: 64.
   */
  readonly batchSize?: number;
  /**
   * Per-batch timeout in milliseconds. Default: 60 000.
   */
  readonly timeoutMs?: number;
  /**
   * Structured log sink. Default: silent.
   */
  readonly log?: (message: string) => void;
}

export interface CobolDeepResult {
  readonly elements: readonly CobolDeepElement[];
  readonly diagnostics: readonly string[];
  /**
   * True when at least one batch crashed and was reparsed via the regex
   * fallback. The graph-ingestion layer surfaces this as a diagnostic node.
   */
  readonly fellBackToRegex: boolean;
}
