/**
 * BOM body item: aggregated LICENSES + NOTICES (AC-M5-5 — item 9 partial).
 *
 * Reads `Dependency` nodes via `IGraphStore.listNodes()`, classifies them
 * via `classifyDependencies` from `@opencodehub/analysis` (lifted in
 * AC-M5-3), and renders both:
 *
 *   - `licensesMd` — Markdown body listing every dependency by tier
 *     (BLOCK / WARN / OK) and a per-package section in
 *     `(ecosystem, name, version)` ASC order.
 *   - `noticesMd` — concatenated `NOTICE` / `NOTICES` / `NOTICE.md` files
 *     read from the repo root if any exist; empty string otherwise.
 *
 * Determinism contract:
 *   - Dependency rows are alpha-sorted by `(ecosystem, name, version, id)`
 *     before rendering — same key as `deps.ts` so the two BOM items agree
 *     on order.
 *   - The markdown body is reconstructed from the sorted rows; LF-only
 *     line endings (W-M5-4).
 *   - NOTICE file lookup probes a fixed list in lex order; the first
 *     match wins, but the function still concatenates every match found
 *     so two repos with the same NOTICES content produce byte-identical
 *     output.
 *
 * Why we re-implement the dep collection instead of calling `buildDeps`:
 *   - `classifyDependencies` requires a `license: string` field on every
 *     `DependencyRef` (the analysis-side schema); `buildDeps`'s `DepRow`
 *     intentionally keeps `license` optional so the BOM stores raw graph
 *     state. We coerce missing licenses to `"UNKNOWN"` for the classifier
 *     here — that's exactly what the MCP `license_audit` tool does.
 */

import type { LicenseAuditResult } from "@opencodehub/analysis";
import { classifyDependencies, type DependencyRef } from "@opencodehub/analysis";
import type { IGraphStore } from "@opencodehub/storage";

/** Aggregated `licenses.md` + `NOTICES` content + classifier result. */
export interface LicensesContent {
  /** Markdown body for the BOM `licenses.md` file. LF-only. */
  readonly licensesMd: string;
  /** Concatenated NOTICE content (may be empty). LF-only. */
  readonly noticesMd: string;
  /** Tier classification from the analysis package. */
  readonly classification: LicenseAuditResult;
}

export interface LicensesOpts {
  readonly store: IGraphStore;
  /** Repo root used to probe `NOTICE` / `NOTICES` / `NOTICE.md`. */
  readonly repoPath: string;
  /**
   * Optional file-read seam — overrides the default `node:fs/promises`
   * `readFile`. Tests inject a stub map; production callers leave unset.
   */
  readonly readFile?: (path: string) => Promise<string | undefined>;
}

/** Filenames probed for NOTICE content, in lex ASC order for determinism. */
const NOTICE_FILES = ["NOTICE", "NOTICE.md", "NOTICES"] as const;

/**
 * Build the licenses BOM slice.
 *
 * Empty graphs (no `Dependency` nodes) still produce a valid markdown
 * body with tier=OK and zero counts. Repos with no NOTICE files produce
 * an empty `noticesMd` string.
 */
export async function buildLicenses(opts: LicensesOpts): Promise<LicensesContent> {
  const deps = await loadDependencyRefs(opts.store);
  const classification = classifyDependencies(deps);
  const licensesMd = renderLicensesMd(deps, classification);
  const noticesMd = await readNotices(opts);
  return { licensesMd, noticesMd, classification };
}

/**
 * Load Dependency nodes and project them onto `DependencyRef`. Missing
 * `license` fields coerce to `"UNKNOWN"` (matching the MCP license_audit
 * default) so `classifyDependencies` produces a useful tier.
 */
async function loadDependencyRefs(store: IGraphStore): Promise<readonly DependencyRef[]> {
  const nodes = await store.listNodes({ kinds: ["Dependency"] });
  const refs: DependencyRef[] = [];
  for (const node of nodes) {
    if (node.kind !== "Dependency") continue;
    refs.push({
      id: node.id,
      name: node.name,
      version: node.version,
      ecosystem: node.ecosystem,
      lockfileSource: node.lockfileSource,
      license: node.license ?? "UNKNOWN",
    });
  }
  refs.sort((a, b) => {
    if (a.ecosystem !== b.ecosystem) return a.ecosystem < b.ecosystem ? -1 : 1;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    if (a.version !== b.version) return a.version < b.version ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return refs;
}

/**
 * Render the deterministic Markdown body. Header section lists the tier
 * + counts; the body lists every package in sorted order.
 */
function renderLicensesMd(
  deps: readonly DependencyRef[],
  classification: LicenseAuditResult,
): string {
  const lines: string[] = [];
  lines.push("# Licenses");
  lines.push("");
  lines.push(`Tier: ${classification.tier}`);
  lines.push("");
  lines.push(`Total: ${classification.summary.total}`);
  lines.push(`OK: ${classification.summary.okCount}`);
  lines.push(`Flagged: ${classification.summary.flaggedCount}`);
  lines.push(`- copyleft: ${classification.flagged.copyleft.length}`);
  lines.push(`- proprietary: ${classification.flagged.proprietary.length}`);
  lines.push(`- unknown: ${classification.flagged.unknown.length}`);
  lines.push("");

  if (deps.length === 0) {
    lines.push("(no dependencies)");
  } else {
    lines.push("## Packages");
    lines.push("");
    for (const d of deps) {
      lines.push(`### ${d.name}@${d.version} (${d.ecosystem})`);
      lines.push("");
      lines.push(`License: ${d.license}`);
      lines.push(`Lockfile: ${d.lockfileSource}`);
      lines.push("");
    }
  }

  // LF-only join + trailing newline so the file ends in a newline (the
  // POSIX-text convention that keeps `git diff` clean).
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Probe `NOTICE_FILES` in the repo root and concatenate any that exist.
 * Reads through the supplied `opts.readFile` if present, otherwise
 * dynamic-imports `node:fs/promises`.
 */
async function readNotices(opts: LicensesOpts): Promise<string> {
  const reader = opts.readFile ?? (await defaultReader());
  const chunks: string[] = [];
  for (const filename of NOTICE_FILES) {
    const content = await reader(joinPath(opts.repoPath, filename));
    if (content === undefined || content.length === 0) continue;
    chunks.push(`# ${filename}`);
    chunks.push("");
    // CRLF→LF normalize for byte-identity (W-M5-4).
    chunks.push(content.replace(/\r\n/g, "\n").trimEnd());
    chunks.push("");
  }
  if (chunks.length === 0) return "";
  return `${chunks.join("\n").trimEnd()}\n`;
}

/**
 * Default `readFile` impl that returns `undefined` for missing files.
 * Lazily imports `node:fs/promises` so the module is tree-shakeable in
 * non-Node environments.
 */
async function defaultReader(): Promise<(p: string) => Promise<string | undefined>> {
  const { readFile } = await import("node:fs/promises");
  return async (p: string) => {
    try {
      return await readFile(p, "utf8");
    } catch {
      return undefined;
    }
  };
}

/** Path join — keep it dependency-free since we only POSIX-join two parts. */
function joinPath(repo: string, name: string): string {
  if (repo.endsWith("/")) return `${repo}${name}`;
  return `${repo}/${name}`;
}
