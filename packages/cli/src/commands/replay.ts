/**
 * `codehub replay --compare <pack-a> <pack-b>` — assert two packs are
 * decision-equivalent (spec 011 / ADR 0020).
 *
 * Decision-equivalence (the contract of record): two packs built from the same
 * inputs are equivalent iff they select the **same decision set** — the same
 * files + byte ranges, under the same budget — regardless of `tokenCount`,
 * `pins`, chunk text, or serialization. Byte-identity (`packHash`) stays the
 * cheap *sufficient witness*: if the two `packHash`es match, the decision
 * trivially matches and we short-circuit (R3).
 *
 * Tiers (R8 — the cheap byte-witness layers from the prior byte-identity
 * `replay` are kept, only the equivalence comparator changed to decision-set):
 *   1. **Integrity** (always, offline): re-hash every BOM body on disk vs its
 *      attested `fileHash` in `manifest.json`. A drifted/corrupt pack is
 *      reported before any comparison — you can't compare a tampered pack.
 *   2. **packHash fast path:** equal `packHash` ⇒ `EQUIVALENT` immediately.
 *   3. **decision-equivalence:** project each pack to its decision set
 *      (ast-chunks preferred, context-bom `byteRanges` fallback — R7) and
 *      compare. Different `budgetTokens` ⇒ `BUDGET_MISMATCH` (R5).
 *
 * `console.log` to stdout is sanctioned in command modules (biome override);
 * the JSON record goes to stdout, the human summary to stderr (the context-bom
 * discipline).
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson } from "@opencodehub/core-types";
import {
  type DecisionDiff,
  type DecisionSet,
  decisionHash,
  decisionSetFromByteRanges,
  decisionSetFromChunks,
  diffDecisionSets,
} from "@opencodehub/pack";

/** Minimal manifest fields `replay` reads (corrected for schema 2 — ADR 0019). */
interface ReplayManifest {
  readonly packHash: string;
  readonly budgetTokens: number;
  readonly commit: string;
  readonly files: ReadonlyArray<{
    readonly kind: string;
    readonly path: string;
    readonly fileHash: string;
  }>;
}

/** A chunk row read from `ast-chunks.jsonl`. */
interface AstChunkRow {
  readonly path: string;
  readonly startByte: number;
  readonly endByte: number;
}

/** Everything `replay` reads from one pack directory. */
export interface LoadedPack {
  readonly dir: string;
  readonly manifest: ReplayManifest;
  /** ast-chunks rows (empty when the file is absent/empty — production default). */
  readonly chunks: readonly AstChunkRow[];
  /** Per-path merged byte ranges parsed from context-bom.json. */
  readonly byteRangesByPath: ReadonlyMap<string, ReadonlyArray<{ start: number; end: number }>>;
  /** Integrity-tier drift: BOM bodies whose on-disk bytes ≠ attested fileHash. */
  readonly integrityDrift: readonly string[];
}

export type ReplayVerdict = "EQUIVALENT" | "DIVERGED" | "BUDGET_MISMATCH" | "CORRUPT";

export interface ReplayResult {
  readonly verdict: ReplayVerdict;
  readonly packHashA: string;
  readonly packHashB: string;
  /** Decision hashes — undefined when the packHash fast path settled it. */
  readonly decisionHashA?: string;
  readonly decisionHashB?: string;
  readonly budgetA: number;
  readonly budgetB: number;
  /** The structured diff, present on DIVERGED. */
  readonly diff?: DecisionDiff;
  /** Integrity drift surfaced from either pack (present on CORRUPT). */
  readonly corruptItems?: readonly string[];
}

export interface ReplayCompareArgs {
  /** Test seam — inject a pack loader so tests skip the filesystem. */
  readonly _loadPack?: (dir: string) => Promise<LoadedPack>;
}

/**
 * Compare two pack directories for decision-equivalence. Pure given the loaded
 * packs; the loader (default {@link loadPack}) is the only I/O.
 */
export async function runReplayCompare(
  packDirA: string,
  packDirB: string,
  args: ReplayCompareArgs = {},
): Promise<ReplayResult> {
  const load = args._loadPack ?? loadPack;
  const a = await load(resolve(packDirA));
  const b = await load(resolve(packDirB));

  // Tier 1: integrity. A pack whose bytes disagree with its own manifest is
  // corrupt — refuse to compare it (the comparison would be meaningless).
  const corrupt = [...a.integrityDrift, ...b.integrityDrift];
  if (corrupt.length > 0) {
    return {
      verdict: "CORRUPT",
      packHashA: a.manifest.packHash,
      packHashB: b.manifest.packHash,
      budgetA: a.manifest.budgetTokens,
      budgetB: b.manifest.budgetTokens,
      corruptItems: corrupt,
    };
  }

  // Tier 2: packHash fast path (R3) — byte-identity is a sufficient witness.
  if (a.manifest.packHash === b.manifest.packHash) {
    return {
      verdict: "EQUIVALENT",
      packHashA: a.manifest.packHash,
      packHashB: b.manifest.packHash,
      budgetA: a.manifest.budgetTokens,
      budgetB: b.manifest.budgetTokens,
    };
  }

  // Different budgets are expected to differ — report distinctly (R5), before
  // the decision diff (a different budget is not a contract violation).
  if (a.manifest.budgetTokens !== b.manifest.budgetTokens) {
    return {
      verdict: "BUDGET_MISMATCH",
      packHashA: a.manifest.packHash,
      packHashB: b.manifest.packHash,
      budgetA: a.manifest.budgetTokens,
      budgetB: b.manifest.budgetTokens,
    };
  }

  // Tier 3: decision-equivalence.
  const setA = packDecisionSet(a);
  const setB = packDecisionSet(b);
  const diff = diffDecisionSets(setA, setB);
  return {
    verdict: diff.equivalent ? "EQUIVALENT" : "DIVERGED",
    packHashA: a.manifest.packHash,
    packHashB: b.manifest.packHash,
    decisionHashA: decisionHash(setA),
    decisionHashB: decisionHash(setB),
    budgetA: a.manifest.budgetTokens,
    budgetB: b.manifest.budgetTokens,
    ...(diff.equivalent ? {} : { diff }),
  };
}

/**
 * Project a loaded pack to its decision set: ast-chunks preferred, context-bom
 * `byteRanges` fallback (R7). Exported for tests.
 */
export function packDecisionSet(pack: LoadedPack): DecisionSet {
  if (pack.chunks.length > 0) {
    return decisionSetFromChunks(pack.chunks, pack.manifest.budgetTokens);
  }
  return decisionSetFromByteRanges(pack.byteRangesByPath, pack.manifest.budgetTokens);
}

/**
 * Load + parse a pack directory: manifest.json (snake_case → camelCase),
 * ast-chunks.jsonl (JSONL), context-bom.json (CycloneDX byteRanges), and run
 * the integrity tier (re-hash bodies vs attested fileHash).
 */
export async function loadPack(dir: string): Promise<LoadedPack> {
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `codehub replay: no pack at ${dir} (missing manifest.json). ` +
        "Pass a .codehub/packs/<packHash>/ directory produced by `codehub code-pack`.",
    );
  }
  const manifest = parseManifest(await readFile(manifestPath, "utf8"));

  // Integrity tier: re-hash each BOM body on disk vs its attested digest.
  const integrityDrift: string[] = [];
  for (const f of manifest.files) {
    const bodyPath = join(dir, f.path);
    if (!existsSync(bodyPath)) {
      integrityDrift.push(f.path);
      continue;
    }
    const recomputed = sha256HexBytes(await readFile(bodyPath));
    if (recomputed !== f.fileHash) integrityDrift.push(f.path);
  }

  const chunks = await loadAstChunks(dir);
  const byteRangesByPath = await loadContextBomRanges(dir);
  return { dir, manifest, chunks, byteRangesByPath, integrityDrift };
}

/**
 * Parse the on-disk snake_case manifest into the fields `replay` needs.
 * Corrected for schema 2 (ADR 0019): no legacy native-backend version pin,
 * `budget_tokens` is read for the decision set.
 */
function parseManifest(json: string): ReplayManifest {
  const w = JSON.parse(json) as Record<string, unknown>;
  const files = (w["files"] ?? []) as Array<Record<string, unknown>>;
  return {
    packHash: String(w["pack_hash"] ?? ""),
    budgetTokens: Number(w["budget_tokens"] ?? 0),
    commit: String(w["commit"] ?? ""),
    files: files.map((f) => ({
      kind: String(f["kind"] ?? ""),
      path: String(f["path"] ?? ""),
      fileHash: String(f["file_hash"] ?? ""),
    })),
  };
}

/** Read `ast-chunks.jsonl` (one canonical-JSON AstChunk per line). Absent → []. */
async function loadAstChunks(dir: string): Promise<AstChunkRow[]> {
  const p = join(dir, "ast-chunks.jsonl");
  if (!existsSync(p)) return [];
  const text = await readFile(p, "utf8");
  const rows: AstChunkRow[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const row = JSON.parse(trimmed) as Record<string, unknown>;
    rows.push({
      path: String(row["path"] ?? ""),
      startByte: Number(row["startByte"] ?? 0),
      endByte: Number(row["endByte"] ?? 0),
    });
  }
  return rows;
}

/**
 * Read `context-bom.json` and extract per-path byte ranges from the
 * `opencodehub:byteRanges` property (a JSON-stringified `[[start,end],...]`).
 * Absent → empty map.
 */
async function loadContextBomRanges(
  dir: string,
): Promise<ReadonlyMap<string, ReadonlyArray<{ start: number; end: number }>>> {
  const p = join(dir, "context-bom.json");
  const out = new Map<string, ReadonlyArray<{ start: number; end: number }>>();
  if (!existsSync(p)) return out;
  const doc = JSON.parse(await readFile(p, "utf8")) as {
    components?: ReadonlyArray<{
      name?: unknown;
      properties?: ReadonlyArray<{ name?: unknown; value?: unknown }>;
    }>;
  };
  for (const c of doc.components ?? []) {
    const path = typeof c.name === "string" ? c.name : undefined;
    if (path === undefined) continue;
    const prop = (c.properties ?? []).find((x) => x.name === "opencodehub:byteRanges");
    if (prop === undefined || typeof prop.value !== "string") continue;
    let pairs: unknown;
    try {
      pairs = JSON.parse(prop.value);
    } catch {
      continue;
    }
    if (!Array.isArray(pairs)) continue;
    const ranges: { start: number; end: number }[] = [];
    for (const pair of pairs) {
      if (Array.isArray(pair) && pair.length === 2) {
        ranges.push({ start: Number(pair[0]), end: Number(pair[1]) });
      }
    }
    if (ranges.length > 0) out.set(path, ranges);
  }
  return out;
}

/**
 * Render a {@link ReplayResult} to a one-line-plus-detail human summary and an
 * exit code. Exported so the CLI action stays a thin shim and the mapping is
 * unit-testable.
 */
export function replayVerdictLine(
  r: ReplayResult,
  budgetStrict: boolean,
): { line: string; exitCode: number } {
  switch (r.verdict) {
    case "EQUIVALENT":
      return { line: "codehub replay: EQUIVALENT — same decision set", exitCode: 0 };
    case "BUDGET_MISMATCH": {
      const line = `codehub replay: BUDGET_MISMATCH — A budget=${r.budgetA}, B budget=${r.budgetB} (decision sets not comparable under different budgets)`;
      return { line, exitCode: budgetStrict ? 1 : 0 };
    }
    case "CORRUPT":
      return {
        line: `codehub replay: CORRUPT — on-disk bytes drifted from the manifest for: ${(r.corruptItems ?? []).join(", ")}`,
        exitCode: 1,
      };
    case "DIVERGED":
      return { line: formatDivergedSummary(r), exitCode: 1 };
  }
}

/** Multi-line human summary of a DIVERGED verdict (the actionable diff). */
function formatDivergedSummary(r: ReplayResult): string {
  const lines: string[] = ["codehub replay: DIVERGED — the packs select different decision sets"];
  const diff = r.diff;
  if (diff !== undefined) {
    for (const p of diff.onlyInA) lines.push(`  only in A: ${p}`);
    for (const p of diff.onlyInB) lines.push(`  only in B: ${p}`);
    for (const d of diff.rangeDeltas) {
      lines.push(`  ranges differ: ${d.path}  A=${fmtRanges(d.a)}  B=${fmtRanges(d.b)}`);
    }
  }
  return lines.join("\n");
}

function fmtRanges(ranges: ReadonlyArray<readonly [number, number]>): string {
  return `[${ranges.map(([s, e]) => `${s}-${e}`).join(",")}]`;
}

/**
 * Print a {@link ReplayResult}. JSON → stdout (machine consumers / `--json`);
 * the human summary → stderr so it never pollutes a piped stdout.
 */
export function printReplayResult(r: ReplayResult, asJson: boolean, budgetStrict: boolean): void {
  const { line } = replayVerdictLine(r, budgetStrict);
  if (asJson) {
    console.log(serializeReplayRecord(r));
  } else {
    console.warn(line);
  }
}

/** Canonical JSON of the replay record — pure function of the inputs (R6). */
export function serializeReplayRecord(r: ReplayResult): string {
  // Reuse the decision-set canonical serializer's discipline by hand-building a
  // stable object; the record carries no clock/run-id, so it is reproducible.
  const record: Record<string, unknown> = {
    verdict: r.verdict,
    packHashA: r.packHashA,
    packHashB: r.packHashB,
    budgetA: r.budgetA,
    budgetB: r.budgetB,
  };
  if (r.decisionHashA !== undefined) record["decisionHashA"] = r.decisionHashA;
  if (r.decisionHashB !== undefined) record["decisionHashB"] = r.decisionHashB;
  if (r.diff !== undefined) record["diff"] = r.diff;
  if (r.corruptItems !== undefined) record["corruptItems"] = r.corruptItems;
  // The same RFC 8785 helper that backs packHash — sorts keys + normalizes
  // numbers, so the record serializes byte-identically given the same inputs.
  return canonicalJson(record);
}

function sha256HexBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
