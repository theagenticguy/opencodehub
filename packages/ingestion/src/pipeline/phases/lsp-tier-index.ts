/**
 * `lsp-tier` phase — quarantined Tier-3 LSP fallback for SCIP-blind languages.
 *
 * This phase is the ingestion wiring point for `@opencodehub/lsp-tier`. For
 * languages with NO SCIP indexer (Swift, Zig, Elixir, Terraform, Clojure,
 * Gleam, Nix, Lua, SQL — see `research-scip-lsp.yaml#gaps`), it drives the
 * vendored agent-lsp `workspace/symbol`(empty) → `blast_radius` batch over the
 * repo file list and writes a packHash-EXCLUDED sidecar (`lsp-tier.sidecar.json`).
 *
 * ## Non-negotiable invariants (ADR 0019)
 *
 * - **O-A7 (opt-in only)**: the phase is a silent no-op unless
 *   `options.tier3Lsp === true`. When off, NO LSP server is spawned, NO daemon
 *   warms up, and SCIP-blind languages keep their Tree-sitter heuristic edges.
 *   The `offline` flag always wins — an offline run never spawns a server.
 * - **U2 (packHash quarantine)**: the facts go to a SEPARATE sidecar, never the
 *   manifest preimage. This phase NEVER touches `buildManifest`.
 * - **S-A4b (warmup hard-fail)**: `runLspTier` throws `LspTierHardFailure` on a
 *   not-warm / partial / version-mismatched result; this phase records the
 *   failure as a per-language skip and writes NOTHING for that language (a
 *   partial is never cached or sidecar-written).
 *
 * ## Live extraction is BLOCKED-ON-ENV
 *
 * agent-lsp and the wrapped servers are NOT installed in this build/CI
 * environment, so the live `LspBackend` (the actual subprocess spawn + LSP
 * RPC) cannot run here. The phase accepts an injected backend; when none is
 * supplied AND opt-in is on, it surfaces a clear "backend unavailable —
 * BLOCKED-ON-ENV" skip rather than faking an extraction. The
 * opt-in/quarantine/sidecar contract is fully exercised by `@opencodehub/lsp-tier`'s
 * unit tests with fixtures.
 */

import { join } from "node:path";
import type { LspBackend, LspTierFact, ScipBlindLanguage } from "@opencodehub/lsp-tier";
import {
  isScipBlindLanguage,
  LspTierHardFailure,
  runLspTier,
  writeTier3Sidecar,
} from "@opencodehub/lsp-tier";
import { META_DIR_NAME } from "@opencodehub/storage";
import type { PipelineContext, PipelinePhase } from "../types.js";
import { PROFILE_PHASE_NAME, type ProfileOutput } from "./profile.js";
import { SCAN_PHASE_NAME } from "./scan.js";

export const LSP_TIER_PHASE_NAME = "lsp-tier";

export interface LspTierPerLanguage {
  readonly language: ScipBlindLanguage;
  readonly skipped: boolean;
  readonly skipReason?: string;
  readonly factsWritten: number;
}

export interface LspTierOutput {
  /** True iff at least one SCIP-blind language produced Tier-3 facts. */
  readonly enabled: boolean;
  readonly skippedReason?: string;
  readonly languages: readonly LspTierPerLanguage[];
  /** Absolute sidecar path, or undefined when nothing was written. */
  readonly sidecarPath?: string;
  readonly durationMs: number;
}

/**
 * The injected live backend. Production supplies the agent-lsp subprocess
 * driver (BLOCKED-ON-ENV here); tests supply a fixture. `undefined` means no
 * backend is available — opt-in runs surface a clear skip instead of faking it.
 */
export interface LspTierPhaseConfig {
  readonly backend?: LspBackend;
}

/**
 * Factory: build the `lsp-tier` phase with an (optional) injected backend.
 * Kept as a factory — not a singleton phase like `scipIndexPhase` — because
 * the backend is environment-provided and the default DAG omits this phase
 * unless the operator opts in.
 */
export function makeLspTierPhase(config: LspTierPhaseConfig = {}): PipelinePhase<LspTierOutput> {
  return {
    name: LSP_TIER_PHASE_NAME,
    deps: [SCAN_PHASE_NAME, PROFILE_PHASE_NAME],
    async run(ctx, deps) {
      return runLspTierPhase(ctx, deps, config);
    },
  };
}

async function runLspTierPhase(
  ctx: PipelineContext,
  deps: ReadonlyMap<string, unknown>,
  config: LspTierPhaseConfig,
): Promise<LspTierOutput> {
  const start = Date.now();

  // O-A7: opt-in gate. Silent no-op when off — no detection, no spawn.
  if (ctx.options.tier3Lsp !== true) {
    return {
      enabled: false,
      skippedReason: "tier3-lsp-not-opted-in",
      languages: [],
      durationMs: Date.now() - start,
    };
  }
  // `offline` always wins — never spawn a server.
  if (ctx.options.offline === true) {
    return {
      enabled: false,
      skippedReason: "offline",
      languages: [],
      durationMs: Date.now() - start,
    };
  }

  const profile = deps.get(PROFILE_PHASE_NAME) as ProfileOutput | undefined;
  const profileLangs = findProfileLanguages(ctx);
  const scipBlind = [...new Set(profileLangs)].filter(isScipBlindLanguage).sort();
  if (profile === undefined || scipBlind.length === 0) {
    return {
      enabled: false,
      skippedReason: "no-scip-blind-languages",
      languages: [],
      durationMs: Date.now() - start,
    };
  }

  // Opt-in is ON and there ARE SCIP-blind languages, but the live agent-lsp
  // backend is not available in this environment. Surface BLOCKED-ON-ENV rather
  // than fake an extraction (anti-goal). The SCIP-blind languages keep their
  // Tree-sitter heuristic edges.
  const backend = config.backend;
  if (backend === undefined) {
    ctx.onProgress?.({
      phase: LSP_TIER_PHASE_NAME,
      kind: "warn",
      message:
        "lsp-tier: opted in but no agent-lsp backend available (servers not installed) — BLOCKED-ON-ENV; SCIP-blind languages stay on tree-sitter",
    });
    return {
      enabled: false,
      skippedReason: "backend-unavailable-blocked-on-env",
      languages: scipBlind.map((language) => ({
        language,
        skipped: true,
        skipReason: "backend-unavailable-blocked-on-env",
        factsWritten: 0,
      })),
      durationMs: Date.now() - start,
    };
  }

  const files = scannedFilePaths(ctx);
  const perLang: LspTierPerLanguage[] = [];
  const allFacts: LspTierFact[] = [];

  for (const language of scipBlind) {
    try {
      const facts = await runLspTier(
        { projectRoot: ctx.repoPath, language, files, optIn: true },
        backend,
      );
      allFacts.push(...facts);
      perLang.push({ language, skipped: false, factsWritten: facts.length });
    } catch (err) {
      // S-A4b: a hard failure (not-warm / partial / version-mismatch) is a
      // per-language skip — NOTHING is written for it. Other languages proceed.
      const reason =
        err instanceof LspTierHardFailure
          ? err.message
          : `lsp-tier-error:${(err as Error).message}`;
      ctx.onProgress?.({
        phase: LSP_TIER_PHASE_NAME,
        kind: "warn",
        message: `lsp-tier: ${language} skipped — ${reason}`,
      });
      perLang.push({ language, skipped: true, skipReason: reason, factsWritten: 0 });
    }
  }

  // Write the sidecar OUTSIDE the packHash preimage (U2). Only when there is at
  // least one fact — an empty sidecar is not written.
  let sidecarPath: string | undefined;
  if (allFacts.length > 0) {
    const outDir = join(ctx.repoPath, META_DIR_NAME);
    sidecarPath = await writeTier3Sidecar(allFacts, outDir);
  }

  return {
    enabled: allFacts.length > 0,
    languages: perLang,
    ...(sidecarPath !== undefined ? { sidecarPath } : {}),
    durationMs: Date.now() - start,
  };
}

// ---- helpers ------------------------------------------------------------

function findProfileLanguages(ctx: PipelineContext): readonly string[] {
  for (const n of ctx.graph.nodes()) {
    if (n.kind === "ProjectProfile") {
      return (n as { languages?: readonly string[] }).languages ?? [];
    }
  }
  return [];
}

function scannedFilePaths(ctx: PipelineContext): readonly string[] {
  const paths: string[] = [];
  for (const n of ctx.graph.nodes()) {
    if (n.kind === "File") paths.push(n.filePath);
  }
  return paths.sort();
}
