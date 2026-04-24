/**
 * Coverage overlay phase.
 *
 * Consumes a coverage report produced by an external test runner and
 * annotates each `File` node with:
 *   - `coveragePercent`  — covered / total, clamped to [0, 1].
 *   - `coveredLines`     — sorted, deduped list of covered 1-based line
 *                          numbers.
 *
 * Format auto-detection looks at a fixed set of well-known paths (in
 * priority order):
 *   1. `coverage/lcov.info`                                 → lcov.
 *   2. `lcov.info`                                          → lcov.
 *   3. `coverage.xml`                                       → cobertura.
 *   4. `build/reports/jacoco/test/jacocoTestReport.xml`     → jacoco.
 *   5. `coverage.json`                                      → coverage.py.
 *
 * The phase is a silent no-op unless `options.coverage === true`; runs after
 * `scan` and `profile` so a later framework-aware detection tier can refine
 * search paths per-language if needed (e.g. pytest vs Jest).
 *
 * Failure posture: parse errors and missing reports log a warning via
 * `ctx.onProgress` and still return a zero-result envelope — coverage is an
 * optional overlay and must never crash analyze.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { FileNode } from "@opencodehub/core-types";
import type { PipelineContext, PipelinePhase } from "../types.js";
import { parseCobertura } from "./coverage-parsers/cobertura.js";
import { parseCoveragePy } from "./coverage-parsers/coverage-py.js";
import { parseJacoco } from "./coverage-parsers/jacoco.js";
import { parseLcov } from "./coverage-parsers/lcov.js";
import type { FileCoverage } from "./coverage-parsers/types.js";
import { PROFILE_PHASE_NAME } from "./profile.js";
import { SCAN_PHASE_NAME } from "./scan.js";
import { STRUCTURE_PHASE_NAME } from "./structure.js";

export const COVERAGE_PHASE_NAME = "coverage" as const;

export type CoverageFormat = "lcov" | "cobertura" | "jacoco" | "coverage-py";

export interface CoverageOutput {
  readonly ran: boolean;
  readonly format?: CoverageFormat;
  readonly reportPath?: string;
  /** Count of File nodes that received a coverage annotation. */
  readonly annotatedFileCount: number;
  /** Count of entries in the report that did not match any File node. */
  readonly unmatchedFileCount: number;
}

/**
 * Detection table, sorted by priority. Each entry names the on-disk probe
 * path (relative to repoPath) plus its dispatch identifier.
 */
const CANDIDATES: readonly { readonly rel: string; readonly format: CoverageFormat }[] = [
  { rel: "coverage/lcov.info", format: "lcov" },
  { rel: "lcov.info", format: "lcov" },
  { rel: "coverage.xml", format: "cobertura" },
  { rel: "build/reports/jacoco/test/jacocoTestReport.xml", format: "jacoco" },
  { rel: "coverage.json", format: "coverage-py" },
];

export const coveragePhase: PipelinePhase<CoverageOutput> = {
  name: COVERAGE_PHASE_NAME,
  deps: [SCAN_PHASE_NAME, PROFILE_PHASE_NAME, STRUCTURE_PHASE_NAME],
  async run(ctx): Promise<CoverageOutput> {
    if (ctx.options.coverage !== true) {
      return { ran: false, annotatedFileCount: 0, unmatchedFileCount: 0 };
    }
    return runCoverage(ctx);
  },
};

async function runCoverage(ctx: PipelineContext): Promise<CoverageOutput> {
  const detected = await detectReport(ctx.repoPath);
  if (detected === undefined) {
    ctx.onProgress?.({
      phase: COVERAGE_PHASE_NAME,
      kind: "warn",
      message:
        "coverage: enabled but no report found (looked for coverage/lcov.info, lcov.info, coverage.xml, build/reports/jacoco/test/jacocoTestReport.xml, coverage.json)",
    });
    return { ran: true, annotatedFileCount: 0, unmatchedFileCount: 0 };
  }

  let raw: string;
  try {
    raw = await fs.readFile(detected.absPath, "utf8");
  } catch (err) {
    ctx.onProgress?.({
      phase: COVERAGE_PHASE_NAME,
      kind: "warn",
      message: `coverage: failed to read ${detected.relPath}: ${(err as Error).message}`,
    });
    return {
      ran: true,
      format: detected.format,
      reportPath: detected.relPath,
      annotatedFileCount: 0,
      unmatchedFileCount: 0,
    };
  }

  const parsed = dispatchParser(detected.format, raw, ctx.repoPath);

  // Apply parsed coverage to matching File nodes. Track both sides so
  // operators can surface mismatches (e.g. path-root drift in jacoco reports).
  const fileNodesByPath = new Map<string, FileNode>();
  for (const n of ctx.graph.nodes()) {
    if (n.kind === "File") fileNodesByPath.set(n.filePath, n);
  }

  let annotated = 0;
  let unmatched = 0;
  // Sort by path so graph mutation order stays deterministic.
  const sortedPaths = [...parsed.keys()].sort();
  for (const filePath of sortedPaths) {
    const cov = parsed.get(filePath);
    if (cov === undefined) continue;
    const fileNode = fileNodesByPath.get(filePath);
    if (fileNode === undefined) {
      unmatched += 1;
      continue;
    }
    const merged: FileNode = {
      ...fileNode,
      coveragePercent: cov.coveragePercent,
      coveredLines: cov.coveredLines,
    };
    ctx.graph.addNode(merged);
    annotated += 1;
  }

  ctx.onProgress?.({
    phase: COVERAGE_PHASE_NAME,
    kind: "note",
    message: `coverage: ${detected.format} report → ${annotated} files annotated, ${unmatched} unmatched`,
  });

  return {
    ran: true,
    format: detected.format,
    reportPath: detected.relPath,
    annotatedFileCount: annotated,
    unmatchedFileCount: unmatched,
  };
}

interface DetectedReport {
  readonly format: CoverageFormat;
  readonly absPath: string;
  readonly relPath: string;
}

async function detectReport(repoRoot: string): Promise<DetectedReport | undefined> {
  for (const cand of CANDIDATES) {
    const abs = path.join(repoRoot, cand.rel);
    try {
      const stat = await fs.stat(abs);
      if (stat.isFile()) {
        return { format: cand.format, absPath: abs, relPath: cand.rel };
      }
    } catch {
      // Missing file — try next candidate.
    }
  }
  return undefined;
}

function dispatchParser(
  format: CoverageFormat,
  raw: string,
  repoRoot: string,
): ReadonlyMap<string, FileCoverage> {
  switch (format) {
    case "lcov":
      return parseLcov(raw, repoRoot);
    case "cobertura":
      return parseCobertura(raw, repoRoot);
    case "jacoco":
      return parseJacoco(raw, repoRoot);
    case "coverage-py":
      return parseCoveragePy(raw, repoRoot);
  }
}
