/**
 * `@opencodehub/lsp-tier` — quarantined Tier-3 LSP fallback for SCIP-blind
 * languages (Swift, Zig, Elixir, Terraform, Clojure, Gleam, Nix, Lua, SQL).
 *
 * Vendors the **agent-lsp** (MIT) `pkg/lsp` + `blast_radius` batch logic to
 * drive `workspace/symbol`(empty) → `blast_radius` over a repo's file list,
 * producing symbols + cross-file edges WITHOUT agent-supplied positions — the
 * batch primitive ADR 0005 assumed LSP lacked, and the reason ADR 0019 can
 * amend 0005 to allow a labeled, batch-only, packHash-quarantined fallback.
 *
 * Every fact is tagged `source=lsp` / `server=<binary>@<pinnedVersion>`,
 * canonically re-sorted (U7), and written to a sidecar that is EXCLUDED from
 * the packHash preimage (U2) — adding/removing Tier-3 facts cannot move the
 * packHash. Opt-in only (O-A7); a partial/not-warm result is a hard failure
 * (S-A4b); each wrapped server is license-audited individually (AC-A5).
 *
 * See `docs/adr/0019-lsp-quarantined-tier3.md`.
 */

export type { LspTierFact } from "./provenance.js";
export { assertTagged, canonicalizeFacts, lspProvenanceReason } from "./provenance.js";
export type {
  BlastRadiusResult,
  LspBackend,
  LspSpawnPlan,
  LspTierOptions,
} from "./runner.js";
export {
  buildSpawnPlan,
  DEFAULT_WARMUP_TIMEOUT_MS,
  LspTierHardFailure,
  runLspTier,
} from "./runner.js";
export type {
  LspServerPin,
  ScipBlindLanguage,
  WrappedServerLicense,
  WrappedServerLicenseAudit,
} from "./servers.js";
export {
  AGENT_LSP_PIN,
  auditWrappedServerLicenses,
  isAllowedLspCommand,
  isScipBlindLanguage,
  LSP_ALLOWED_COMMANDS,
  LSP_SERVER_REGISTRY,
  pinForLanguage,
  serverTag,
} from "./servers.js";
export type { Tier3Sidecar } from "./sidecar.js";
export {
  serializeTier3Sidecar,
  TIER3_SIDECAR_FILENAME,
  TIER3_SIDECAR_SCHEMA_VERSION,
  writeTier3Sidecar,
} from "./sidecar.js";
