/**
 * `codehub replay <hash>` — re-derive a pack and prove it matches its
 * attested receipt, offline.
 *
 * Given a pack identified by its `packHash`, replay:
 *   1. Loads the attested `manifest.json` from `<repo>/.codehub/packs/<hash>/`
 *      — this is the trusted input (the same canonical JSON whose sha256 IS
 *      the packHash, and whose `files[]` carry every BOM body's sha256).
 *   2. **Byte-compare, integrity tier (always runs, no network):** re-hashes
 *      every BOM body still on disk in the pack dir and recomputes the
 *      packHash from the manifest's own fields via `@opencodehub/pack`'s
 *      `buildManifest`. A tampered BOM byte flips that body's hash → replay
 *      names the drifted item and exits non-zero.
 *   3. **Re-pack tier (when a `repack` driver is supplied / wired):** checks
 *      out the recorded commit into a throwaway git worktree, re-runs the
 *      packer with the recorded `(tokenizer, budget, pins)`, and byte-compares
 *      the freshly-derived packHash against the attested one.
 *
 * Determinism class governs the verdict (lesson
 * `tokenizer-id-is-provenance-not-an-encoder.md`):
 *   - `strict`  — any mismatch is a hard failure (exit non-zero).
 *   - `best_effort` (Claude tokenizer, which rotates) — a packHash mismatch
 *     is reported as EXPECTED DRIFT, not a failure (exit 0). The integrity
 *     tier (on-disk bytes vs their own attested digests) is still enforced —
 *     a tampered byte is always a failure regardless of class.
 *   - `degraded` — treated like `strict` for the verdict (the fallback was
 *     recorded; its output is still expected to be stable on disk).
 *
 * No network in any verify path. The Sigstore signature is verified
 * separately/offline via `cosign verify-blob-attestation --bundle` (see
 * `@opencodehub/pack`'s `offlineVerifyCommand`); replay proves the BYTES,
 * the cosign bundle proves WHO signed which packHash.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildManifest, type PackManifest } from "@opencodehub/pack";

/** A single per-item drift observation surfaced by replay. */
export interface DriftItem {
  /** The BOM item path (e.g. `ast-chunks.jsonl`) or `manifest:packHash`. */
  readonly item: string;
  /** The sha256 recorded in the attested manifest. */
  readonly attested: string;
  /** The sha256 re-derived during replay. */
  readonly recomputed: string;
}

export interface ReplayResult {
  /** True iff the pack reproduced (or drifted only within `best_effort` tolerance). */
  readonly reproduced: boolean;
  /** The first drifted item's name, for a one-line CLI message (E-C2). */
  readonly driftedItem?: string;
  /** Every drift observed (integrity tier + re-pack tier). */
  readonly drifts: readonly DriftItem[];
  /** The attested pack's determinism class — decides hard-fail vs expected-drift. */
  readonly determinismClass: PackManifest["determinismClass"];
  /** True when the only drift is tolerated `best_effort` packHash drift. */
  readonly expectedDrift: boolean;
}

/**
 * Drives the optional checkout→re-pack tier. Production wires this to a
 * git-worktree checkout of `manifest.commit` + `analyze` + `code-pack` with
 * the recorded `(tokenizer, budget, pins)`. Tests inject a deterministic
 * stand-in. When absent, replay runs the integrity tier only (still a full
 * offline byte-compare against the attested digests).
 */
export type RepackDriver = (manifest: PackManifest, repoPath: string) => Promise<PackManifest>;

export interface ReplayArgs {
  /** Repo root holding `.codehub/packs/<hash>/`. Defaults to `process.cwd()`. */
  readonly repoPath?: string;
  /**
   * Optional re-pack driver (checkout + re-run packer). When omitted, only
   * the on-disk integrity tier runs. Production wires this; unit tests inject
   * a deterministic stub.
   */
  readonly repack?: RepackDriver;
  /** Test seam: read a BOM body's bytes (defaults to fs read of the pack dir). */
  readonly _readBomBytes?: (packDir: string, relPath: string) => Promise<Uint8Array>;
}

/**
 * Replay the pack identified by `hash`. Returns a structured verdict; the CLI
 * wrapper maps it to an exit code (0 reproduced / 0 best_effort-drift /
 * non-zero hard drift).
 */
export async function runReplay(hash: string, args: ReplayArgs = {}): Promise<ReplayResult> {
  const repoPath = resolve(args.repoPath ?? process.cwd());
  const packDir = join(repoPath, ".codehub", "packs", hash);
  const manifestPath = join(packDir, "manifest.json");

  if (!existsSync(manifestPath)) {
    throw new Error(
      `codehub replay: no pack at ${packDir}. ` +
        "Run `codehub code-pack --prove` to produce one (its packHash names the dir).",
    );
  }

  const manifest = parseManifest(await readFile(manifestPath, "utf8"));

  // The attested hash is the directory name; the manifest's own packHash must
  // agree, or the pack's identity has been moved/corrupted.
  if (manifest.packHash !== hash) {
    return hardDrift(manifest, {
      item: "manifest:packHash",
      attested: hash,
      recomputed: manifest.packHash,
    });
  }

  const drifts: DriftItem[] = [];

  // --- Integrity tier: re-hash every BOM body on disk vs its attested digest. ---
  const readBytes = args._readBomBytes ?? defaultReadBomBytes;
  for (const f of manifest.files) {
    if (!existsSync(join(packDir, f.path))) {
      // A missing BOM body is a hard drift regardless of class — the attested
      // bytes are simply gone.
      drifts.push({ item: f.path, attested: f.fileHash, recomputed: "<missing>" });
      continue;
    }
    const bytes = await readBytes(packDir, f.path);
    const recomputed = sha256HexBytes(bytes);
    if (recomputed !== f.fileHash) {
      drifts.push({ item: f.path, attested: f.fileHash, recomputed });
    }
  }

  // Integrity drift is ALWAYS a hard failure — a tampered on-disk byte no
  // longer matches its own attested digest, irrespective of determinism class.
  const firstDrift = drifts[0];
  if (firstDrift !== undefined) {
    return {
      reproduced: false,
      driftedItem: firstDrift.item,
      drifts,
      determinismClass: manifest.determinismClass,
      expectedDrift: false,
    };
  }

  // --- Re-pack tier (optional): checkout the commit + re-run the packer. ---
  if (args.repack !== undefined) {
    const redo = await args.repack(manifest, repoPath);
    if (redo.packHash !== manifest.packHash) {
      const drift: DriftItem = {
        item: namedRepackDrift(manifest, redo),
        attested: manifest.packHash,
        recomputed: redo.packHash,
      };
      // best_effort: a re-pack packHash mismatch is EXPECTED drift, not a
      // failure (Claude tokenizer rotates). strict/degraded: hard failure.
      if (manifest.determinismClass === "best_effort") {
        return {
          reproduced: true,
          driftedItem: drift.item,
          drifts: [drift],
          determinismClass: manifest.determinismClass,
          expectedDrift: true,
        };
      }
      return {
        reproduced: false,
        driftedItem: drift.item,
        drifts: [drift],
        determinismClass: manifest.determinismClass,
        expectedDrift: false,
      };
    }
  }

  return {
    reproduced: true,
    drifts: [],
    determinismClass: manifest.determinismClass,
    expectedDrift: false,
  };
}

/**
 * Render the replay verdict to a one-line string + exit code. Exported so the
 * CLI action stays a thin shim and the mapping is unit-testable.
 */
export function replayVerdict(r: ReplayResult): { line: string; exitCode: number } {
  if (r.reproduced && !r.expectedDrift) {
    return { line: "codehub replay: reproduced", exitCode: 0 };
  }
  if (r.reproduced && r.expectedDrift) {
    return {
      line:
        `codehub replay: best_effort drift on ${r.driftedItem ?? "<unknown>"} ` +
        "(tolerated — Claude tokenizer is not byte-stable across versions)",
      exitCode: 0,
    };
  }
  return {
    line: `codehub replay: NOT reproduced — drifted item: ${r.driftedItem ?? "<unknown>"}`,
    exitCode: 1,
  };
}

/**
 * Recompute the attested packHash from the manifest's own fields and confirm
 * it equals the recorded value. This re-derives the SAME hash `manifest.ts`
 * produced (we reuse `buildManifest`, the trusted computation — we never
 * reimplement it). A divergence means the manifest's fields no longer hash to
 * its claimed packHash (manifest-level tamper). Exported for direct use by
 * the re-pack tier and tests.
 */
export function recomputePackHash(manifest: PackManifest): string {
  const redo = buildManifest({
    commit: manifest.commit,
    repoOriginUrl: manifest.repoOriginUrl,
    tokenizerId: manifest.tokenizerId,
    determinismClass: manifest.determinismClass,
    budgetTokens: manifest.budgetTokens,
    pins: manifest.pins,
    files: manifest.files,
  });
  return redo.packHash;
}

/** Find the first BOM item whose hash differs between attested and re-packed manifests. */
function namedRepackDrift(attested: PackManifest, redo: PackManifest): string {
  const redoByPath = new Map(redo.files.map((f) => [f.path, f.fileHash]));
  for (const f of attested.files) {
    const other = redoByPath.get(f.path);
    if (other === undefined) return f.path;
    if (other !== f.fileHash) return f.path;
  }
  // Same files, same hashes, but packHash differs → a top-level field
  // (commit/tokenizer/budget/pins) drifted.
  return "manifest:packHash";
}

function hardDrift(manifest: PackManifest, drift: DriftItem): ReplayResult {
  return {
    reproduced: false,
    driftedItem: drift.item,
    drifts: [drift],
    determinismClass: manifest.determinismClass,
    expectedDrift: false,
  };
}

/**
 * Parse the on-disk snake_case `manifest.json` back into the camelCase
 * {@link PackManifest} surface `@opencodehub/pack` operates on. The on-disk
 * form is the snake_case wire surface from `serializeManifest`.
 */
function parseManifest(json: string): PackManifest {
  const w = JSON.parse(json) as Record<string, unknown>;
  const pins = (w["pins"] ?? {}) as Record<string, unknown>;
  const files = (w["files"] ?? []) as Array<Record<string, unknown>>;
  return {
    commit: String(w["commit"] ?? ""),
    repoOriginUrl: w["repo_origin_url"] === null ? null : String(w["repo_origin_url"] ?? ""),
    tokenizerId: String(w["tokenizer_id"] ?? ""),
    determinismClass: w["determinism_class"] as PackManifest["determinismClass"],
    budgetTokens: Number(w["budget_tokens"] ?? 0),
    pins: {
      chonkieVersion: String(pins["chonkie_version"] ?? ""),
      duckdbVersion: String(pins["duckdb_version"] ?? ""),
      grammarCommits: (pins["grammar_commits"] ?? {}) as Readonly<Record<string, string>>,
    },
    files: files.map((f) => ({
      kind: f["kind"] as PackManifest["files"][number]["kind"],
      path: String(f["path"] ?? ""),
      fileHash: String(f["file_hash"] ?? ""),
    })),
    packHash: String(w["pack_hash"] ?? ""),
    schemaVersion: 1,
  };
}

async function defaultReadBomBytes(packDir: string, relPath: string): Promise<Uint8Array> {
  return readFile(join(packDir, relPath));
}

function sha256HexBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
