/**
 * The Tier-3 LSP extraction driver (vendored agent-lsp logic).
 *
 * Drives, per SCIP-blind language detected in a repo:
 *
 *   warmup-block  →  workspace/symbol(empty)  →  blast_radius(file list)
 *                 →  symbols + cross-file edges  →  re-sorted, tagged facts
 *
 * This ports agent-lsp's `pkg/lsp` + `blast_radius` BATCH primitive — the
 * primitive ADR 0005 assumed LSP lacked. We do NOT add a runtime npm dep on
 * agent-lsp; we wrap its logic and pin server versions ourselves.
 *
 * ## Invariants enforced here
 *
 * - **O-A7 (opt-in)**: when `optIn` is false, NO server is spawned, NO daemon
 *   warms up, and the function returns an empty fact list — the caller degrades
 *   SCIP-blind languages to Tree-sitter heuristics silently. The opt-in check
 *   short-circuits BEFORE the spawn boundary is ever touched.
 * - **S-A4b (warmup hard-fail)**: the runner blocks until the server reports
 *   FULL warmup readiness. A query that returns before readiness, or a result
 *   flagged partial/timed-out, is a HARD failure (throw). A partial is NEVER
 *   written to the SQLite cache or the sidecar.
 * - **Spawn discipline**: every spawn is validated against
 *   {@link isAllowedLspCommand} and the canonical literal is recovered from the
 *   allowlist (`shell: false`), mirroring `scip-ingest`'s `runCommand`.
 * - **U7 (determinism)**: facts are canonically re-sorted + tagged
 *   `source=lsp`/`server=<bin>@<pin>` before return.
 *
 * ## Testability
 *
 * agent-lsp + the wrapped servers are NOT installed in the build environment.
 * The live spawn/RPC layer is injected via {@link LspBackend}, so unit tests
 * drive the runner with FIXTURES (mirroring `scip-ingest`'s ruby.test.ts
 * "assert plan + skip semantics without spawning" pattern). A live end-to-end
 * extraction against real servers is BLOCKED-ON-ENV.
 */

import type { LspTierFact } from "./provenance.js";
import { assertTagged, canonicalizeFacts } from "./provenance.js";
import type { LspServerPin, ScipBlindLanguage } from "./servers.js";
import { isAllowedLspCommand, pinForLanguage, serverTag } from "./servers.js";

/** Options for one Tier-3 extraction run over a single SCIP-blind language. */
export interface LspTierOptions {
  readonly projectRoot: string;
  /** The SCIP-blind language to extract (must be in the server registry). */
  readonly language: ScipBlindLanguage;
  /** The repo file list `blast_radius` runs over. */
  readonly files: readonly string[];
  /**
   * O-A7: when false the LSP server is NOT spawned and the run degrades to
   * Tree-sitter heuristics silently (empty result, no daemon, no warmup cost).
   */
  readonly optIn: boolean;
  /** S-A4b: block until full readiness within this bound (default 5 min). */
  readonly warmupTimeoutMs?: number;
}

/** Default cold-start warmup bound — agent-lsp's documented 5-min ceiling. */
export const DEFAULT_WARMUP_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The result of an agent-lsp `blast_radius` batch over a file list. `partial`
 * is the S-A4b signal: agent-lsp sets it when the server was not fully warm,
 * the warmup watcher timed out, or the batch returned an incomplete symbol
 * set. The runner treats `partial: true` as a HARD failure.
 */
export interface BlastRadiusResult {
  /** The detected/probed server version. Checked against the pin. */
  readonly serverVersion: string;
  /** True iff the server reached full warmup readiness before the query. */
  readonly warm: boolean;
  /**
   * True iff the result is incomplete (server not warm, timeout, or partial
   * symbol enumeration). HARD failure — never cached, never sidecar-written.
   */
  readonly partial: boolean;
  /** Raw (unsorted) symbol → cross-file refs from `blast_radius`. */
  readonly symbols: readonly { readonly symbol: string; readonly edges: readonly string[] }[];
}

/**
 * The injected live layer. Production wires this to the vendored agent-lsp Go
 * binary (spawned through the allowlist); tests inject a fixture. The runner
 * itself owns the opt-in gate, the spawn-allowlist check, the warmup/partial
 * hard-fail, and the re-sort — the backend only performs the actual
 * warmup-block + `workspace/symbol`+`blast_radius` round-trip.
 */
export interface LspBackend {
  /**
   * Block until the server for `pin.binary` is fully warm (S-A4b), then run
   * `workspace/symbol`(empty) → `blast_radius` over `files`. MUST resolve only
   * after warmup completes or the timeout elapses; on timeout it returns a
   * result with `warm: false` / `partial: true` (the runner throws on it).
   */
  warmupAndBlastRadius(
    pin: LspServerPin,
    projectRoot: string,
    files: readonly string[],
    warmupTimeoutMs: number,
  ): Promise<BlastRadiusResult>;
}

/** Thrown when a Tier-3 run hard-fails (S-A4b). Never written to cache/sidecar. */
export class LspTierHardFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LspTierHardFailure";
  }
}

/**
 * Build the spawn plan for a server pin WITHOUT spawning. Exposed so tests can
 * assert the allowlist + `shell: false` discipline the way `scip-ingest`'s
 * `buildCommand` tests assert the SCIP plan (no live process required).
 */
export interface LspSpawnPlan {
  /** The canonical, allowlist-recovered binary literal that reaches exec. */
  readonly cmd: string;
  /** Always false — argv-array spawn, never a shell. */
  readonly shell: false;
  /** The version probe argv (bare flag only). */
  readonly versionArgs: readonly string[];
  /** Why this plan refuses to run, if it does (e.g. binary off the allowlist). */
  readonly refuseReason?: string;
}

/**
 * Construct the spawn plan for a SCIP-blind language. Validates the wrapped
 * server binary against the closed allowlist and recovers the canonical
 * literal — so the executable reaching the OS exec call is provably one of a
 * fixed set, never derived from repo contents.
 */
export function buildSpawnPlan(language: ScipBlindLanguage): LspSpawnPlan {
  const pin = pinForLanguage(language);
  if (pin === undefined) {
    return {
      cmd: "",
      shell: false,
      versionArgs: [],
      refuseReason: `unknown language: ${language}`,
    };
  }
  if (!isAllowedLspCommand(pin.binary)) {
    return {
      cmd: "",
      shell: false,
      versionArgs: [],
      refuseReason: `disallowed server binary: ${pin.binary}`,
    };
  }
  return { cmd: pin.binary, shell: false, versionArgs: ["--version"] };
}

/**
 * Drive a Tier-3 extraction for one SCIP-blind language.
 *
 * Returns canonically re-sorted, `source=lsp`/`server=<bin>@<pin>`-tagged facts
 * for the sidecar. NEVER returns a partial result — a partial throws
 * {@link LspTierHardFailure} (S-A4b) so the caller writes nothing.
 *
 * @throws {LspTierHardFailure} on opt-in-off (no — that returns empty), warmup
 *   timeout, partial result, off-allowlist binary, or a server-version mismatch
 *   against the pin (the version pin is load-bearing for cache determinism).
 */
export async function runLspTier(
  opts: LspTierOptions,
  backend: LspBackend,
): Promise<readonly LspTierFact[]> {
  // O-A7: opt-in gate. Short-circuit BEFORE any spawn/warmup work. No daemon,
  // no warmup cost — the caller silently degrades to Tree-sitter heuristics.
  if (!opts.optIn) {
    return [];
  }

  const pin = pinForLanguage(opts.language);
  if (pin === undefined) {
    throw new LspTierHardFailure(
      `lsp-tier: no server pin for SCIP-blind language ${opts.language}`,
    );
  }

  // Spawn-allowlist barrier (defense in depth — the registry binaries are
  // already on the allowlist by construction, but we refuse anything that
  // somehow is not, mirroring scip-ingest's pre-spawn validation).
  const plan = buildSpawnPlan(opts.language);
  if (plan.refuseReason !== undefined) {
    throw new LspTierHardFailure(`lsp-tier: ${plan.refuseReason}`);
  }

  const warmupTimeoutMs = opts.warmupTimeoutMs ?? DEFAULT_WARMUP_TIMEOUT_MS;
  const result = await backend.warmupAndBlastRadius(
    pin,
    opts.projectRoot,
    opts.files,
    warmupTimeoutMs,
  );

  // S-A4b: a not-fully-warm or partial result is a HARD failure. We throw
  // BEFORE building any fact, so nothing partial can reach the cache/sidecar.
  if (!result.warm) {
    throw new LspTierHardFailure(
      `lsp-tier: ${pin.binary} did not reach warmup readiness within ${warmupTimeoutMs}ms — refusing to write partial`,
    );
  }
  if (result.partial) {
    throw new LspTierHardFailure(
      `lsp-tier: ${pin.binary} returned a partial blast_radius result — partial is a hard failure, never cached`,
    );
  }

  // The server version is part of the determinism contract (agent-lsp's cache
  // key folds it in). A mismatch against the pin means the on-PATH server is
  // not the version this index was pinned to — a deliberate bump must update
  // the pin, not silently re-key the cache.
  if (result.serverVersion !== pin.pinnedVersion) {
    throw new LspTierHardFailure(
      `lsp-tier: ${pin.binary} version ${result.serverVersion} != pinned ${pin.pinnedVersion} — ` +
        "a server bump is a deliberate index-version bump; update the pin in servers.ts",
    );
  }

  // `serverTag(pin)` is the `<binary>@<pinnedVersion>` E-A4 tag; it is also the
  // tail of the edge reason a consumer folds in via `lspProvenanceReason(pin)`
  // (`lsp:${server}`), so the `server` field and the reason can never drift.
  const server = serverTag(pin);

  const facts: LspTierFact[] = result.symbols.map((s) => ({
    source: "lsp",
    server,
    symbol: s.symbol,
    edges: s.edges,
  }));

  // U7: tag-validate then canonically re-sort before any consumer reads.
  return canonicalizeFacts(assertTagged(facts));
}
