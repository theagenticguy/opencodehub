/**
 * `codehub code-pack [path]` — produce the deterministic 8-item BOM via
 * `@opencodehub/pack`.
 *
 * Output goes to `<repo>/.codehub/packs/<packHash>/` so a pack's identity
 * is encoded in its on-disk path. The function writes to a temp directory
 * first, then renames into place once the manifest's `packHash` is known
 * — this keeps the path-includes-hash invariant without requiring
 * `generatePack` to know its own hash up front.
 *
 * Two engines are supported via the `--engine` flag:
 *   - `pack` (DEFAULT) — `@opencodehub/pack`'s `generatePack`. Opens a
 *     read-only graph store via `openStore({ readOnly: true })` and walks
 *     the indexed graph to produce the 7 BOM body items + manifest, plus a
 *     consumer-facing readme. cli/ passes the composed `Store`.
 *   - `repomix` — legacy single-file snapshot via `npx repomix`. Retained
 *     under an opt-in flag for one milestone before removal. Internally
 *     delegates to `runPack` so the repomix shell-out is implemented
 *     exactly once.
 *
 * The CLI surface is:
 *
 *   codehub code-pack [path]
 *     [--budget <N>]        token budget (default 100_000)
 *     [--tokenizer <ID>]    "<vendor>:<name>@<pin>" (default openai:o200k_base@tiktoken-0.8.0)
 *     [--out-dir <DIR>]     overrides the .codehub/packs/<packHash>/ default
 *     [--engine pack|repomix]  default "pack"
 *
 * Exits non-zero on missing index (the pack engine requires `codehub
 * analyze` to have already populated the graph store).
 */

import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FileNode, GraphNode, RepoNode } from "@opencodehub/core-types";
import { sha256Hex } from "@opencodehub/core-types";
import { parse as ingestionParse } from "@opencodehub/ingestion";
import {
  buildContextAttestation,
  type CacheChannel,
  DEFAULT_CACHE_CHANNEL,
  generatePack,
  type PackManifest,
  serializeAttestation,
} from "@opencodehub/pack";
import { type IGraphStore, openStore, resolveGraphPath, type Store } from "@opencodehub/storage";
import { runPack } from "./pack.js";

/** Default token budget when `--budget` is omitted. */
export const DEFAULT_BUDGET_TOKENS = 100_000;

/** Default tokenizer identifier when `--tokenizer` is omitted. */
export const DEFAULT_TOKENIZER_ID = "openai:o200k_base@tiktoken-0.8.0";

/**
 * Tokenizer-provenance lane for Claude Sonnet 5 (launched 2026-06-30).
 *
 * Sonnet 5 ships a new tokenizer that inflates the same source bytes by
 * ~30-35% vs prior Claude tokenizers, so a budget authored for the default
 * `openai:o200k_base` lane under-provisions when the *consuming* agent is
 * Sonnet 5 — the pack's budgetTokens→chunkSize map is 1:1, so the same budget
 * silently produces oversized chunks under the heavier tokenizer.
 *
 * This constant is provenance metadata ONLY: it records which tokenizer a pack
 * was authored against so a variance probe (Finding 0001 v2) can attribute
 * results to a lane. It does NOT change the bytes→token math — there is no
 * runtime Sonnet-5 encoder. The `anthropic:` vendor prefix is load-bearing:
 * `@opencodehub/pack`'s `resolveDeterminism` downgrades any `anthropic:`-prefixed
 * lane from `strict` to `best_effort`, which is the correct class for a pack
 * whose byte-identity guarantee is relaxed by a Claude tokenizer.
 *
 * Format follows the `<vendor>:<name>@<pin>` convention (see PackManifest).
 */
export const SONNET5_TOKENIZER_ID = "anthropic:claude-sonnet-5@2026-06-30";

/** Default engine when `--engine` is omitted — the new `@opencodehub/pack` BOM. */
export const DEFAULT_ENGINE: "pack" | "repomix" = "pack";

export interface CodePackArgs {
  /** Path to the repo. Defaults to `process.cwd()` when omitted. */
  readonly repo?: string;
  /** Token budget passed to the AST chunker. Defaults to 100_000. */
  readonly budget?: number;
  /** Tokenizer identifier ("<vendor>:<name>@<pin>"). */
  readonly tokenizer?: string;
  /** Override the `.codehub/packs/<packHash>/` default. */
  readonly outDir?: string;
  /** Engine: "pack" (default) or "repomix" (legacy opt-in). */
  readonly engine?: "pack" | "repomix";
  /**
   * Delivery channel for channel-aware cache-prefix enforcement (Move 4).
   * Recorded on the pack options and threaded into the agent-facing assembly.
   * Kept OUT of the manifest/packHash preimage, so the default (`auto`) leaves
   * pack output byte-identical to pre-Move-4. Defaults to `auto`.
   */
  readonly cacheChannel?: CacheChannel;
  /**
   * Test seam — inject a custom `generatePack` so unit tests don't need
   * to load native storage bindings. Production callers leave this
   * unset.
   */
  readonly _generatePack?: typeof generatePack;
  /**
   * Test seam — inject a pre-opened {@link Store} (or a graph-only
   * stand-in via {@link IGraphStore}) so unit tests can stub the graph
   * entirely. Production callers leave this unset; the command opens a
   * composed store via `openStore` on demand. Backwards-compatible:
   * tests that only need graph reads can keep passing a plain
   * `IGraphStore` and the command auto-wraps it.
   */
  readonly _store?: Store | IGraphStore;
  /**
   * Test seam — inject a custom `runPack` so unit tests don't actually
   * shell-out to `npx repomix`. Production callers leave this unset.
   */
  readonly _runRepomix?: typeof runPack;
}

export interface CodePackResult {
  /** Final on-disk directory containing the BOM. */
  readonly outDir: string;
  /** SHA256 of the manifest's canonical JSON (excluding `packHash`). */
  readonly packHash: string;
  /**
   * Number of artifacts on disk that contribute to the BOM (7 BOM body
   * items + manifest = 8). For the repomix engine this is 1 — repomix
   * produces a single output file rather than the 8-item BOM.
   */
  readonly bomItemCount: number;
  /** The pack manifest. `null` for the repomix engine — it does not produce one. */
  readonly manifest: PackManifest | null;
  /** Engine that produced the result. */
  readonly engine: "pack" | "repomix";
  /**
   * On the repomix path, the absolute path of the single repomix output
   * file. Undefined on the pack path (the pack engine writes a
   * directory; consumers should walk `outDir`).
   */
  readonly repomixOutputPath?: string;
  /**
   * Absolute path of the in-toto context attestation, present only when the
   * `--prove` flag emitted one (pack engine only). Undefined otherwise.
   */
  readonly attestationPath?: string;
}

export async function runCodePack(args: CodePackArgs = {}): Promise<CodePackResult> {
  const repoPath = resolve(args.repo ?? process.cwd());
  const engine: "pack" | "repomix" = args.engine ?? DEFAULT_ENGINE;

  if (engine === "repomix") {
    return runRepomixEngine(repoPath, args);
  }
  return runPackEngine(repoPath, args);
}

async function runPackEngine(repoPath: string, args: CodePackArgs): Promise<CodePackResult> {
  const budget = args.budget ?? DEFAULT_BUDGET_TOKENS;
  const tokenizer = args.tokenizer ?? DEFAULT_TOKENIZER_ID;
  const cacheChannel = args.cacheChannel ?? DEFAULT_CACHE_CHANNEL;
  const generate = args._generatePack ?? generatePack;

  // Production: open a read-only graph store; tests inject `_store` to
  // skip the native binding entirely.
  const dbPath = resolveGraphPath(repoPath);
  if (args._store === undefined && !existsSync(dbPath)) {
    throw new Error(
      `codehub code-pack: no graph index at ${dbPath}. ` +
        "Run `codehub analyze` first to populate the store.",
    );
  }
  const ownsStore = args._store === undefined;
  // Composed-store envelope used only when this command owns lifecycle.
  // Holds it here so the finally block can close graph + temporal in
  // deterministic order without re-running the factory.
  const owned = ownsStore
    ? await (async () => {
        const composed = await openStore({ path: dbPath, readOnly: true });
        // graph and temporal are the same single-file SqliteStore instance
        // (open() is idempotent); the pack reads only the graph view.
        await composed.graph.open();
        return composed;
      })()
    : undefined;
  // generatePack consumes `Store` (= `OpenStoreResult`). Tests historically
  // passed an `IGraphStore` stub via `_store`; route that through the
  // `internal.graphOnly` seam which auto-wraps it into a no-op-temporal Store.
  const composedStore: Store | undefined = isStoreShape(args._store)
    ? args._store
    : (owned ?? undefined);
  const graphOnlyStub: IGraphStore | undefined = isStoreShape(args._store)
    ? undefined
    : args._store;

  // Stage in a temp dir; we don't know `packHash` until generatePack returns,
  // and the canonical layout puts the hash in the directory name.
  const stagingDir = await mkdtemp(join(tmpdir(), "codehub-code-pack-"));

  try {
    // Resolve the production provenance the pack manifest records — commit,
    // origin, the source files to chunk, and grammar pins — from the indexed
    // graph + the vendored grammar manifest. `generatePack`'s `internal` seam
    // accepts all of these; the CLI is the documented integration layer that
    // populates them (without this, every real pack ships commit="", empty
    // ast-chunks, and unknown pins). Derivation reads the graph the command
    // already opened — no second store open, no git spawn.
    const graphForProvenance: IGraphStore | undefined = composedStore?.graph ?? graphOnlyStub;
    const provenance = await resolvePackProvenance(graphForProvenance, repoPath);

    const manifest = await generate(
      {
        repoPath,
        outDir: stagingDir,
        budgetTokens: budget,
        tokenizerId: tokenizer,
        // Recorded on the pack options; deliberately not part of the manifest
        // preimage (Move 4), so `auto` keeps packHash byte-identical to today.
        cacheChannel,
      },
      composedStore !== undefined
        ? { store: composedStore, ...provenance }
        : { graphOnly: graphOnlyStub as IGraphStore, ...provenance },
    );

    const finalOutDir =
      args.outDir !== undefined
        ? resolve(args.outDir)
        : join(repoPath, ".codehub", "packs", manifest.packHash);
    // If `--out-dir` was supplied, honor it as the literal final path; otherwise
    // build the canonical .codehub/packs/<hash>/ layout. Either way, ensure the
    // parent exists, then move the staging dir into place.
    await mkdir(join(finalOutDir, ".."), { recursive: true });
    if (existsSync(finalOutDir)) {
      // Idempotent re-runs land on the same packHash — clear the old dir so
      // `rename` succeeds atomically. The rm is recursive because the
      // staging contents are non-empty.
      await rm(finalOutDir, { recursive: true, force: true });
    }
    await rename(stagingDir, finalOutDir);

    // BOM item count = manifest.files[].length (skeleton, file-tree, deps,
    // ast-chunks, xrefs, findings, licenses) + 1 for the manifest itself.
    // The readme.md is consumer-facing metadata and is not part of the
    // manifest hash preimage; we still report it as an on-disk artifact
    // downstream by walking the dir, but the BOM count tracks the
    // deterministic items only.
    const bomItemCount = manifest.files.length + 1;

    return {
      outDir: finalOutDir,
      packHash: manifest.packHash,
      bomItemCount,
      manifest,
      engine: "pack",
    };
  } finally {
    if (owned !== undefined) {
      await owned.close();
    }
    // Best-effort cleanup of the staging dir if we never renamed it (e.g.
    // generatePack threw). `rm` with `force` swallows ENOENT.
    await rm(stagingDir, { recursive: true, force: true });
  }
}

async function runRepomixEngine(repoPath: string, args: CodePackArgs): Promise<CodePackResult> {
  const repomix = args._runRepomix ?? runPack;
  const result = await repomix(repoPath, {});
  // Build a CodePackResult-shaped envelope so callers can reason about
  // either engine uniformly. `packHash` is a sha256 over the file's bytes,
  // which gives operators a deterministic identifier even though repomix
  // does not emit a manifest. `bomItemCount` is 1 — repomix is a
  // single-file snapshot, not the 9-item BOM.
  const bytes = await readFile(result.outputPath);
  const packHash = createHash("sha256").update(bytes).digest("hex");
  return {
    outDir: repoPath,
    packHash,
    bomItemCount: 1,
    manifest: null,
    engine: "repomix",
    repomixOutputPath: result.outputPath,
  };
}

/**
 * Production provenance the pack manifest records, derived from the indexed
 * graph + the working tree. Each field maps to a `generatePack` `internal`
 * input. Every field is best-effort: a graph missing the data (or a stubbed
 * store in tests) yields safe empties, never a throw, so packing never fails
 * on absent provenance.
 */
interface PackProvenance {
  readonly commit: string;
  readonly repoOriginUrl: string | null;
  readonly chunkerFiles: ReadonlyArray<{
    readonly path: string;
    readonly bytes: Uint8Array;
    readonly language?: string;
  }>;
  readonly grammarCommits: Readonly<Record<string, string>>;
}

/**
 * Derive {@link PackProvenance} from the opened graph and the repo working
 * tree.
 *
 *   - commit / repoOriginUrl: read from the singleton `Repo` node, so the
 *     pack stays a pure read of the indexed state (no `git` spawn here).
 *   - chunkerFiles: every indexed `File` node's bytes, read from disk and
 *     **hash-verified against the node's `contentHash`**. A file whose
 *     working-tree bytes drifted from the index is skipped, so the pack never
 *     chunks content that disagrees with what was analyzed — preserving the
 *     "pack reflects the indexed commit" contract.
 *   - grammarCommits: the vendored grammar version pins.
 *
 * A `graph` of `undefined` (no store) or one lacking `listNodes` (a bare test
 * stub) yields empty file/commit provenance but still returns grammar pins.
 */
async function resolvePackProvenance(
  graph: IGraphStore | undefined,
  repoPath: string,
): Promise<PackProvenance> {
  const grammarCommits = await loadGrammarCommits();

  const canList = typeof graph?.listNodes === "function";
  if (graph === undefined || !canList) {
    return { commit: "", repoOriginUrl: null, chunkerFiles: [], grammarCommits };
  }

  const [repoNodes, fileNodes] = await Promise.all([
    graph.listNodes({ kinds: ["Repo"] }),
    graph.listNodes({ kinds: ["File"] }),
  ]);

  const repo = repoNodes.find((n): n is RepoNode => n.kind === "Repo");
  const commit = repo?.commitSha ?? "";
  const repoOriginUrl = repo?.originUrl ?? null;

  const chunkerFiles = await collectChunkerFiles(fileNodes, repoPath);
  return { commit, repoOriginUrl, chunkerFiles, grammarCommits };
}

/**
 * Read + hash-verify the bytes of every indexed `File` node. Only files whose
 * on-disk sha256 matches the indexed `contentHash` are returned, so a pack run
 * against a dirty working tree silently drops drifted files rather than
 * chunking stale bytes. Files with no recorded `contentHash` are read as-is
 * (the index never claimed a hash to verify against).
 */
async function collectChunkerFiles(
  fileNodes: readonly GraphNode[],
  repoPath: string,
): Promise<PackProvenance["chunkerFiles"]> {
  const out: Array<{ path: string; bytes: Uint8Array; language?: string }> = [];
  for (const node of fileNodes) {
    if (node.kind !== "File") continue;
    const file = node as FileNode;
    let buf: Buffer;
    try {
      buf = await readFile(resolve(repoPath, file.filePath));
    } catch {
      continue; // file vanished from the tree since indexing — skip it
    }
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    if (file.contentHash !== undefined && sha256Hex(bytes) !== file.contentHash) {
      continue; // working-tree bytes drifted from the indexed state — skip
    }
    out.push({
      path: file.filePath,
      bytes,
      ...(file.language !== undefined ? { language: file.language } : {}),
    });
  }
  return out;
}

/**
 * Load the vendored grammar version pins for the manifest. Best-effort: an
 * unreadable manifest yields `{}` rather than failing the pack.
 */
async function loadGrammarCommits(): Promise<Readonly<Record<string, string>>> {
  try {
    return await ingestionParse.grammarVersions();
  } catch {
    return {};
  }
}

/**
 * Read the on-disk size of `path`. Exported so the CLI's user-facing
 * recap can format byte counts without re-walking the dir tree.
 */
export function statSizeOrZero(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Filename of the in-toto context attestation emitted by `--prove`, written
 * inside the pack directory alongside the BOM bodies.
 */
export const ATTESTATION_FILENAME = "attestation.intoto.json";

/**
 * Emit the in-toto context attestation for a finished pack (spec: Move 3 /
 * `--prove`). Builds the Statement from the manifest — subject = the pack's
 * `packHash`, predicate = the context provenance + BOM item list — and writes
 * its canonical JSON to `<outDir>/attestation.intoto.json`.
 *
 * The Statement is a pure function of the manifest (no clock / UUID / run-id),
 * so re-emitting over the same pack yields byte-identical bytes. This is the
 * UNSIGNED statement; signing (cosign keyless) stays a CI concern that can
 * layer a DSSE envelope over these bytes.
 *
 * Returns the absolute path written so the caller can surface it.
 */
export async function writeContextAttestation(
  outDir: string,
  manifest: PackManifest,
): Promise<string> {
  const statement = buildContextAttestation(manifest);
  const bytes = new TextEncoder().encode(serializeAttestation(statement));
  const attestationPath = join(outDir, ATTESTATION_FILENAME);
  await writeFile(attestationPath, bytes);
  return attestationPath;
}

/** Summary of a pack's context read-receipt, derived from context-bom.json. */
export interface ContextSummary {
  /** Number of source files recorded in the receipt. */
  readonly fileCount: number;
  /** Files carrying a SHA-256 content hash (provenance coverage). */
  readonly filesWithHash: number;
  /** Sum of recorded line counts across files. */
  readonly totalLines: number;
  /** File count per language id, sorted by language for stable output. */
  readonly byLanguage: ReadonlyArray<{ readonly language: string; readonly files: number }>;
}

/** Minimal shape of the CycloneDX components we read back. */
interface ReadComponent {
  readonly name?: string;
  readonly hashes?: ReadonlyArray<{ readonly alg?: string; readonly content?: string }>;
  readonly properties?: ReadonlyArray<{ readonly name?: string; readonly value?: string }>;
}

/**
 * Read `context-bom.json` from a finished pack directory and summarize it.
 * Pure read — does not re-run the pack. Throws a clear error when the file
 * is absent (e.g. a schema-1 pack predating the context receipt).
 */
export async function explainContextBom(outDir: string): Promise<ContextSummary> {
  const file = join(outDir, "context-bom.json");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new Error(
      `codehub code-pack: no context-bom.json at ${file}. ` +
        "This pack predates the context read-receipt; re-run `codehub code-pack`.",
    );
  }
  const doc = JSON.parse(raw) as { components?: readonly ReadComponent[] };
  const components = doc.components ?? [];

  let filesWithHash = 0;
  let totalLines = 0;
  const langCounts = new Map<string, number>();
  for (const c of components) {
    if ((c.hashes ?? []).some((h) => h.alg === "SHA-256" && typeof h.content === "string")) {
      filesWithHash++;
    }
    const props = c.properties ?? [];
    const lineProp = props.find((p) => p.name === "opencodehub:lineCount");
    if (lineProp?.value !== undefined) {
      const n = Number.parseInt(lineProp.value, 10);
      if (Number.isFinite(n)) totalLines += n;
    }
    const langProp = props.find((p) => p.name === "opencodehub:language");
    const lang = langProp?.value ?? "(unknown)";
    langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1);
  }

  const byLanguage = [...langCounts.entries()]
    .map(([language, files]) => ({ language, files }))
    .sort((a, b) => (a.language < b.language ? -1 : a.language > b.language ? 1 : 0));

  return { fileCount: components.length, filesWithHash, totalLines, byLanguage };
}

/**
 * Print a {@link ContextSummary} to the user. JSON goes to stdout (machine
 * consumers / `--json`); the human block goes to stderr so it never pollutes
 * a piped stdout. Lives in the command module because `console.log` to stdout
 * is sanctioned here (see biome.json override), not in the CLI entrypoint.
 */
export function printContextSummary(summary: ContextSummary, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.warn(formatContextSummary(summary));
  }
}

/** Render a {@link ContextSummary} as a short human-readable block. */
export function formatContextSummary(s: ContextSummary): string {
  const lines: string[] = [];
  lines.push("Context read-receipt:");
  lines.push(`  files indexed:   ${s.fileCount}`);
  lines.push(`  with SHA-256:    ${s.filesWithHash}/${s.fileCount}`);
  lines.push(`  total lines:     ${s.totalLines}`);
  if (s.byLanguage.length > 0) {
    lines.push("  by language:");
    for (const row of s.byLanguage) {
      lines.push(`    ${row.language}: ${row.files}`);
    }
  }
  return lines.join("\n");
}

/**
 * Discriminate between the composed {@link Store} and a bare
 * {@link IGraphStore} stub. Tests historically passed a flat IGraphStore
 * via `_store`; production passes the full Store envelope from
 * {@link openStore}. The composed envelope is the only shape carrying both
 * a `graph` and a `temporal` view, so the presence of both uniquely
 * identifies it. (The pre-ADR-0016 envelope also carried a `backend`
 * discriminator; that field was removed when the DuckDB-as-graph backend was
 * ripped out, so this no longer keys off it.)
 */
function isStoreShape(s: Store | IGraphStore | undefined): s is Store {
  if (s === undefined) return false;
  const obj = s as { graph?: unknown; temporal?: unknown };
  return obj.graph !== undefined && obj.temporal !== undefined;
}
