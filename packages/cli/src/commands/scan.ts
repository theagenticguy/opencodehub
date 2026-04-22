/**
 * `codehub scan [path]` — run P1 + profile-gated P2 scanners, emit merged
 * SARIF, ingest findings into the graph.
 *
 * Flow:
 *   1. Resolve the target repo (optionally from the registry).
 *   2. Read the ProjectProfile row (if any) so we can gate scanners by
 *      detected languages / iacTypes / apiContracts.
 *   3. Filter the catalog by --scanners, --with, and the profile:
 *      - P1 scanners are gated by language overlap (polyglot always in).
 *      - P2 scanners (trivy, checkov, hadolint, tflint, spectral) are
 *        opt-in via ProjectProfile fields. `--with trivy,checkov`
 *        force-adds them regardless of profile.
 *   4. Build per-scanner context (checkov frameworks, hadolint Dockerfile
 *      list, spectral contract files, pip-audit requirements path) from
 *      the profile + filesystem probe.
 *   5. Run the selected scanners in parallel via `runScanners`.
 *   6. Merge SARIF and write to `.codehub/scan.sarif`.
 *   7. Ingest findings into the graph via `runIngestSarif`.
 *   8. Exit with 0 when no HIGH+CRIT findings, 1 when any, 2 when a
 *      scanner returned non-zero or crashed.
 *
 * The --severity filter gates the exit code only; every finding is
 * still written to SARIF and the graph.
 */

import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  applyBaselineState,
  applySuppressions,
  loadSuppressions,
  type SarifLog,
  SarifLogSchema,
} from "@opencodehub/sarif";
import {
  ALL_SPECS,
  CHECKOV_SPEC,
  createDefaultWrappers,
  type DefaultWrapperContext,
  filterSpecsByProfile,
  HADOLINT_SPEC,
  P1_SPECS,
  PIP_AUDIT_SPEC,
  type ProjectProfileGate,
  runScanners,
  type ScannerSpec,
  type ScannerStatus,
  SPECTRAL_SPEC,
} from "@opencodehub/scanners";
import { DuckDbStore, resolveDbPath, resolveRepoMetaDir } from "@opencodehub/storage";
import { readRegistry } from "../registry.js";
import { runIngestSarif } from "./ingest-sarif.js";

export interface ScanOptions {
  /** Explicit scanner ids (--scanners=semgrep,osv). Overrides profile gating. */
  readonly scanners?: readonly string[];
  /** Additional scanner ids to include on top of defaults. */
  readonly withScanners?: readonly string[];
  /** Override output path. Defaults to `<repo>/.codehub/scan.sarif`. */
  readonly output?: string;
  /** Severity filter for the exit-code gate (default: HIGH,CRITICAL). */
  readonly severity?: readonly string[];
  /**
   * Path to a baseline SARIF log. When supplied, every result in the
   * scan output is tagged via `applyBaselineState` and findings with
   * `baselineState === "unchanged"` are excluded from the severity-gate
   * exit code — they are not new relative to the baseline.
   */
  readonly baseline?: string;
  /** Override the registry home (tests). */
  readonly home?: string;
  /** `--repo <name>`: look up a registered repo instead of using `path`. */
  readonly repo?: string;
  /** Concurrency override. */
  readonly concurrency?: number;
  /** Per-scanner timeout override in ms. */
  readonly timeoutMs?: number;
}

export interface ScanSummary {
  readonly repoPath: string;
  readonly outputPath: string;
  readonly runs: readonly {
    readonly scanner: string;
    readonly findings: number;
    readonly skipped?: string;
  }[];
  readonly totalFindings: number;
  readonly bySeverity: Record<string, number>;
  /** 0 = clean, 1 = findings above severity threshold, 2 = scanner error. */
  readonly exitCode: 0 | 1 | 2;
}

const DEFAULT_SEVERITY_THRESHOLD: ReadonlySet<string> = new Set(["HIGH", "CRITICAL", "error"]);

export async function runScan(path: string, opts: ScanOptions = {}): Promise<ScanSummary> {
  const repoPath = await resolveRepoPath(path, opts);
  const outputPath = resolve(opts.output ?? `${resolveRepoMetaDir(repoPath)}/scan.sarif`);

  const profile = await readProjectProfile(repoPath);
  const specs = selectScanners(profile, opts);
  if (specs.length === 0) {
    console.warn("codehub scan: no scanners selected — nothing to do.");
    return {
      repoPath,
      outputPath,
      runs: [],
      totalFindings: 0,
      bySeverity: {},
      exitCode: 0,
    };
  }
  console.warn(
    `codehub scan: running ${specs.length} scanner(s): ${specs.map((s) => s.id).join(", ")}`,
  );

  const wrapperContext = await buildWrapperContext(repoPath, profile, specs);
  const wrappers = createDefaultWrappers(specs, undefined, wrapperContext);
  const runnerOpts = {
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    onProgress: (spec: ScannerSpec, status: ScannerStatus, note?: string) => {
      if (status === "error") {
        console.warn(`codehub scan: ${spec.id} errored: ${note ?? ""}`);
      } else if (status === "skipped" && note) {
        console.warn(`codehub scan: ${spec.id} skipped: ${note}`);
      } else {
        console.warn(`codehub scan: ${spec.id} ${status}`);
      }
    },
  };
  const result = await runScanners(repoPath, wrappers, runnerOpts);

  // Optional baseline diff (Stream T): tag every result with
  // `baselineState` so downstream consumers (scan output, ingest-sarif,
  // verdict) can distinguish pre-existing debt from newly introduced
  // findings. Results with baselineState === "unchanged" are suppressed
  // from the severity-gate exit code below.
  const baselineLog = await loadBaselineLog(opts.baseline);
  const afterBaseline: SarifLog =
    baselineLog !== undefined ? applyBaselineState(result.sarif, baselineLog) : result.sarif;

  // Stream T: tag suppressed findings from `.codehub/suppressions.yaml` +
  // inline `codehub-suppress: <ruleId> <reason>` comments. Suppressed
  // results still travel through SARIF and the graph; `codehub verdict`
  // and the severity gate below treat them as non-blocking.
  const finalSarif = applySuppressionsForRepo(repoPath, afterBaseline);

  // Write merged SARIF to disk.
  await mkdir(resolveRepoMetaDir(repoPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(finalSarif, null, 2)}\n`, "utf8");

  // Ingest into the graph (best effort — missing graph is non-fatal).
  try {
    const ingestOpts: { repo?: string; home?: string } = {};
    if (opts.repo !== undefined) ingestOpts.repo = opts.repo;
    if (opts.home !== undefined) ingestOpts.home = opts.home;
    await runIngestSarif(outputPath, ingestOpts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`codehub scan: ingest-sarif skipped: ${msg}`);
  }

  // Summarize. Suppressed findings (Stream T) AND baseline-unchanged
  // findings are excluded from the severity-gate exit code but still
  // counted in `totalFindings` so operators see the full footprint.
  const bySeverity: Record<string, number> = {};
  const bySeverityGated: Record<string, number> = {};
  let totalFindings = 0;
  let suppressedCount = 0;
  let unchangedCount = 0;
  for (const run of finalSarif.runs) {
    const results = run.results ?? [];
    for (const r of results) {
      const level = r.level ?? "note";
      bySeverity[level] = (bySeverity[level] ?? 0) + 1;
      totalFindings += 1;
      const suppArr = (r as unknown as { suppressions?: readonly unknown[] }).suppressions;
      const suppressed = Array.isArray(suppArr) && suppArr.length > 0;
      const state = (r as unknown as { baselineState?: string }).baselineState;
      const unchangedVsBaseline = state === "unchanged";
      if (suppressed) suppressedCount += 1;
      if (unchangedVsBaseline) unchangedCount += 1;
      if (!suppressed && !unchangedVsBaseline) {
        bySeverityGated[level] = (bySeverityGated[level] ?? 0) + 1;
      }
    }
  }

  const severityThreshold = resolveSeverityThreshold(opts.severity);
  let exitCode: 0 | 1 | 2 = 0;
  if (result.errored.length > 0) {
    exitCode = 2;
  } else {
    for (const [level, count] of Object.entries(bySeverityGated)) {
      if (count > 0 && severityThreshold.has(level)) {
        exitCode = 1;
        break;
      }
    }
  }

  const runs = result.runs.map((r) => {
    const findings = (r.sarif.runs[0]?.results ?? []).length;
    return r.skipped !== undefined
      ? { scanner: r.spec.id, findings, skipped: r.skipped }
      : { scanner: r.spec.id, findings };
  });

  const suppressedNote = suppressedCount > 0 ? ` (${suppressedCount} suppressed)` : "";
  const baselineNote =
    baselineLog !== undefined ? ` (${unchangedCount} unchanged vs baseline)` : "";
  console.warn(
    `codehub scan: wrote ${outputPath} — ${totalFindings} findings${baselineNote}${suppressedNote} across ${runs.length} scanner(s), exit=${exitCode}`,
  );

  return { repoPath, outputPath, runs, totalFindings, bySeverity, exitCode };
}

/**
 * Load `.codehub/suppressions.yaml` (if present) and apply both YAML rules
 * and inline `codehub-suppress:` markers to the merged SARIF log. Missing
 * files resolve silently; malformed files emit a warning through
 * loadSuppressions but never abort the scan. Source files are read lazily
 * through a memoized reader so the same file isn't slurped for every
 * finding.
 */
function applySuppressionsForRepo(repoPath: string, log: SarifLog): SarifLog {
  const yamlPath = join(repoPath, ".codehub", "suppressions.yaml");
  const loaded = loadSuppressions(yamlPath);
  for (const w of loaded.warnings) {
    console.warn(`codehub scan: ${w}`);
  }
  const sourceCache = new Map<string, string | undefined>();
  const readSource = (uri: string): string | undefined => {
    if (sourceCache.has(uri)) return sourceCache.get(uri);
    let content: string | undefined;
    try {
      content = readFileSync(resolve(repoPath, uri), "utf8");
    } catch {
      content = undefined;
    }
    sourceCache.set(uri, content);
    return content;
  };
  return applySuppressions(log, loaded.rules, readSource);
}

/**
 * Read the ProjectProfile node (if present) so we can gate scanners by
 * detected languages, IaC types, and API contracts. If the graph is
 * absent, every field is returned empty — falls back to the polyglot P1
 * subset.
 */
export async function readProjectProfile(repoPath: string): Promise<ProjectProfileGate> {
  const dbPath = resolveDbPath(repoPath);
  try {
    const store = new DuckDbStore(dbPath, { readOnly: true });
    try {
      await store.open();
      const rows = (await store.query(
        "SELECT languages_json, iac_types_json, api_contracts_json FROM nodes WHERE kind = 'ProjectProfile' LIMIT 1",
        [],
      )) as ReadonlyArray<Record<string, unknown>>;
      const row = rows[0];
      if (!row) return {};
      return {
        languages: parseJsonArray(row["languages_json"]),
        iacTypes: parseJsonArray(row["iac_types_json"]),
        apiContracts: parseJsonArray(row["api_contracts_json"]),
      };
    } finally {
      await store.close();
    }
  } catch {
    return {};
  }
}

function parseJsonArray(value: unknown): readonly string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

/**
 * Exported for tests: apply --scanners / --with / profile gating to
 * produce the final scanner list.
 */
export function selectScanners(
  profile: ProjectProfileGate,
  opts: ScanOptions,
): readonly ScannerSpec[] {
  const requested = opts.scanners;
  const withList = opts.withScanners ?? [];

  // --scanners=... overrides profile gating entirely. `--with` is
  // additive either way.
  if (requested !== undefined) {
    const merged = new Set<string>([...requested, ...withList]);
    return ALL_SPECS.filter((s) => merged.has(s.id));
  }

  const gated = filterSpecsByProfile(ALL_SPECS, profile);
  if (withList.length === 0) return gated;

  // --with adds scanners on top of profile gating (useful for forcing a
  // P2 scanner to run even when the profile didn't flag the relevant
  // IaC type, e.g. `--with trivy` on a repo with no Dockerfiles).
  const byId = new Map(gated.map((s) => [s.id, s]));
  for (const id of withList) {
    const spec = ALL_SPECS.find((s) => s.id === id);
    if (spec) byId.set(id, spec);
  }
  return [...byId.values()];
}

/**
 * Build the per-scanner context passed to `createDefaultWrappers`. Only
 * populates fields for scanners that are actually in `specs` — avoids
 * wasted filesystem work.
 */
async function buildWrapperContext(
  repoPath: string,
  profile: ProjectProfileGate,
  specs: readonly ScannerSpec[],
): Promise<DefaultWrapperContext> {
  const ids = new Set(specs.map((s) => s.id));
  const ctx: {
    -readonly [K in keyof DefaultWrapperContext]?: DefaultWrapperContext[K];
  } = {};
  if (ids.has(CHECKOV_SPEC.id)) {
    ctx.checkov = { frameworks: profile.iacTypes ?? [] };
  }
  if (ids.has(HADOLINT_SPEC.id)) {
    ctx.hadolint = { dockerfiles: await findDockerfiles(repoPath) };
  }
  if (ids.has(SPECTRAL_SPEC.id)) {
    ctx.spectral = { contractFiles: await findOpenApiFiles(repoPath) };
  }
  if (ids.has(PIP_AUDIT_SPEC.id)) {
    ctx.pipAudit = { requirementsPath: "requirements.txt" };
  }
  return ctx;
}

/**
 * Walk the repo for Dockerfile* files. Bounded to one breadth-first pass
 * with a per-directory file cap so huge repos don't explode; the typical
 * case has ≤5 Dockerfiles.
 */
async function findDockerfiles(repoPath: string): Promise<readonly string[]> {
  const { readdir } = await import("node:fs/promises");
  const { join, relative } = await import("node:path");
  type DirEntry = import("node:fs").Dirent;
  const MAX_FILES = 256;
  const out: string[] = [];
  const queue: string[] = [repoPath];
  while (queue.length > 0 && out.length < MAX_FILES) {
    const dir = queue.shift();
    if (dir === undefined) break;
    let entries: DirEntry[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git" || e.name.startsWith(".codehub")) {
        continue;
      }
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        queue.push(abs);
      } else if (e.isFile() && /^Dockerfile(\..+)?$/.test(e.name)) {
        out.push(relative(repoPath, abs));
      }
    }
  }
  return out;
}

/**
 * Locate OpenAPI / Swagger / AsyncAPI / Arazzo contracts. Mirrors the
 * ProjectProfile API-contract detector's matching rules but just pulls
 * the paths (no content sniff — good enough for Spectral invocation).
 */
async function findOpenApiFiles(repoPath: string): Promise<readonly string[]> {
  const { readdir } = await import("node:fs/promises");
  const { join, relative } = await import("node:path");
  type DirEntry = import("node:fs").Dirent;
  const MAX_FILES = 64;
  const RE = /^(openapi|swagger|asyncapi|arazzo)\.(ya?ml|json)$/i;
  const out: string[] = [];
  const queue: string[] = [repoPath];
  while (queue.length > 0 && out.length < MAX_FILES) {
    const dir = queue.shift();
    if (dir === undefined) break;
    let entries: DirEntry[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git" || e.name.startsWith(".codehub")) {
        continue;
      }
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        queue.push(abs);
      } else if (e.isFile() && RE.test(e.name)) {
        out.push(relative(repoPath, abs));
      }
    }
  }
  return out;
}

function resolveSeverityThreshold(input: readonly string[] | undefined): ReadonlySet<string> {
  if (input === undefined || input.length === 0) return DEFAULT_SEVERITY_THRESHOLD;
  const out = new Set<string>();
  for (const s of input) {
    const trimmed = s.trim();
    if (trimmed.length === 0) continue;
    out.add(trimmed);
    // Translate common aliases so users can write either SARIF levels or
    // severity words.
    if (trimmed === "HIGH") out.add("error");
    if (trimmed === "CRITICAL") out.add("error");
    if (trimmed === "MEDIUM") out.add("warning");
    if (trimmed === "LOW") out.add("note");
  }
  return out;
}

async function resolveRepoPath(path: string, opts: ScanOptions): Promise<string> {
  if (opts.repo !== undefined) {
    const registryOpts = opts.home !== undefined ? { home: opts.home } : {};
    const registry = await readRegistry(registryOpts);
    const hit = registry[opts.repo];
    if (hit) return resolve(hit.path);
    return resolve(opts.repo);
  }
  return resolve(path);
}

/** Helper exposed for tests: parse a SARIF file from disk. */
export async function readSarifFile(path: string): Promise<unknown> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as unknown;
}

/**
 * Read + validate a baseline SARIF log. Returns undefined when no
 * baseline was requested. Throws when the path was given but the file
 * is missing or corrupt — a bad baseline should fail loudly, not silently
 * skip the diff.
 */
async function loadBaselineLog(path: string | undefined): Promise<SarifLog | undefined> {
  if (path === undefined) return undefined;
  const resolved = resolve(path);
  const raw = await readFile(resolved, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const result = SarifLogSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `codehub scan: baseline ${resolved} is not a valid SARIF 2.1.0 log: ${result.error.message}`,
    );
  }
  return result.data;
}

// `P1_SPECS` re-export preserves the import shape for any existing consumers
// that have been reading it via the CLI barrel. New callers should import
// from `@opencodehub/scanners` directly.
export { P1_SPECS };
