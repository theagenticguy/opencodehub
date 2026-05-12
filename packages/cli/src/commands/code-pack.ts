/**
 * `codehub code-pack [path]` — produce the deterministic 9-item BOM via
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
 *     the indexed graph to produce the 8 mandatory BOM items + manifest +
 *     optional Parquet embeddings sidecar. The sidecar emitter lives in
 *     `@opencodehub/pack`; cli/ passes the composed `Store` and pack
 *     dispatches on `store.backend` (DuckDB COPY for `duck`, degraded
 *     stamp for `lbug` v1).
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
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generatePack, type PackManifest } from "@opencodehub/pack";
import { type IGraphStore, openStore, resolveDbPath, type Store } from "@opencodehub/storage";
import { runPack } from "./pack.js";

/** Default token budget when `--budget` is omitted. */
export const DEFAULT_BUDGET_TOKENS = 100_000;

/** Default tokenizer identifier when `--tokenizer` is omitted. */
export const DEFAULT_TOKENIZER_ID = "openai:o200k_base@tiktoken-0.8.0";

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
   * Test seam — inject a custom `generatePack` so unit tests don't need
   * to load native DuckDB bindings. Production callers leave this
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
   * Number of artifacts on disk that contribute to the BOM (mandatory
   * 8 BOM items + manifest = 9; +1 if the embeddings.parquet sidecar
   * was emitted). For the repomix engine this is 1 — repomix produces a
   * single output file rather than the 9-item BOM.
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
  const generate = args._generatePack ?? generatePack;

  // Production: open a read-only graph store via the backend-agnostic
  // factory; tests inject `_store` to skip the native binding entirely.
  const dbPath = resolveDbPath(repoPath);
  if (args._store === undefined) {
    // The store factory accepts a `graph.duckdb` path and rewrites it to
    // the lbug sibling when the backend resolves to lbug. Check both so
    // the error surfaces only when neither artifact is on disk.
    const lbugPath = resolve(repoPath, ".codehub", "graph.lbug");
    if (!existsSync(dbPath) && !existsSync(lbugPath)) {
      throw new Error(
        `codehub code-pack: no graph index at ${dbPath} or ${lbugPath}. ` +
          "Run `codehub analyze` first to populate the store.",
      );
    }
  }
  const ownsStore = args._store === undefined;
  // Composed-store envelope used only when this command owns lifecycle.
  // Holds it here so the finally block can close graph + temporal in
  // deterministic order without re-running the factory.
  const owned = ownsStore
    ? await (async () => {
        const composed = await openStore({ path: dbPath, backend: "auto", readOnly: true });
        await composed.graph.open();
        return composed;
      })()
    : undefined;
  // generatePack consumes `Store` (= `OpenStoreResult`) so the
  // embeddings sidecar can dispatch on `store.backend`. Tests
  // historically passed an `IGraphStore` stub via `_store`; route that
  // through the `internal.graphOnly` seam which auto-wraps it into a
  // no-op-temporal Store with `backend: "duck"` (the sidecar then
  // resolves to absent unless the stub duck-types
  // `exportEmbeddingsParquet` itself).
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
    const manifest = await generate(
      {
        repoPath,
        outDir: stagingDir,
        budgetTokens: budget,
        tokenizerId: tokenizer,
      },
      composedStore !== undefined
        ? { store: composedStore }
        : { graphOnly: graphOnlyStub as IGraphStore },
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
    // ast-chunks, xrefs, findings, licenses, [embeddings.parquet]) + 1 for
    // the manifest itself. The readme.md is consumer-facing metadata and is
    // not part of the manifest hash preimage; we still report it as an
    // on-disk artifact downstream by walking the dir, but the BOM count
    // tracks the deterministic items only.
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
 * Discriminate between the composed {@link Store} and a bare
 * {@link IGraphStore} stub. Tests historically passed a flat IGraphStore
 * via `_store`; production passes the full Store envelope from
 * {@link openStore}. We detect the envelope shape by the presence of
 * `graph` + `temporal` + `backend` so both paths flow through the
 * sidecar dispatch correctly.
 */
function isStoreShape(s: Store | IGraphStore | undefined): s is Store {
  if (s === undefined) return false;
  const obj = s as { backend?: unknown; graph?: unknown; temporal?: unknown };
  return typeof obj.backend === "string" && obj.graph !== undefined && obj.temporal !== undefined;
}
