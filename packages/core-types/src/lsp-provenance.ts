/**
 * Oracle-edge provenance reason prefixes shared between the ingestion
 * confidence-demote phase, the summarize trust filter, the MCP
 * confidence-breakdown helper, and the analyze CLI's auto-cap.
 *
 * An edge is treated as "oracle-confirmed" when its `reason` starts with one
 * of these prefixes AND its confidence is at the oracle ceiling (1.0).
 * Prefixes are matched with `string.startsWith(...)`; the trailing `@`
 * segment is typically followed by a version identifier
 * (e.g. `scip:scip-typescript@0.4.0`).
 */
export const SCIP_PROVENANCE_PREFIXES: readonly string[] = [
  "scip:scip-typescript@",
  "scip:scip-python@",
  "scip:scip-go@",
  "scip:rust-analyzer@",
  "scip:scip-java@",
  "scip:scip-clang@",
  "scip:scip-ruby@",
  "scip:scip-dotnet@",
  "scip:scip-kotlin@",
];

/**
 * **Tier 1.5 (`scip-unofficial:`)** provenance prefixes — third-party /
 * pre-alpha SCIP indexers (php, dart) that are NOT first-party, CSC-governed
 * oracles. An edge whose `reason` starts with one of these is MID-confidence:
 * SCIP-shaped and deterministic, but NOT oracle-confirmed.
 *
 * This set is deliberately DISJOINT from {@link SCIP_PROVENANCE_PREFIXES} (which
 * stays first-party-only). A `scip-unofficial:` edge MUST NOT be treated as an
 * oracle confirmer by the confidence-demote phase, and MUST be surfaced as its
 * own tier (not merged into the first-party `confirmed` bucket) by the MCP
 * confidence-breakdown helper. Keeping the two arrays separate is what enforces
 * that split at every reader.
 */
export const SCIP_UNOFFICIAL_PROVENANCE_PREFIXES: readonly string[] = [
  "scip-unofficial:scip-php@",
  "scip-unofficial:scip-dart@",
];

/**
 * **Tier 3 (`lsp:`)** provenance prefixes — the quarantined LSP fallback for
 * SCIP-blind languages (Swift, Zig, Elixir, Terraform, Clojure, Gleam, Nix,
 * Lua, SQL) driven through the vendored agent-lsp wrapper (ADR 0019, amending
 * ADR 0005). An edge whose `reason` starts with one of these is LOWEST-tier
 * structural intel: derived from a stateful LSP server (not a deterministic
 * one-shot SCIP artifact), so it is re-sorted + server-version-pinned + kept
 * in a packHash-EXCLUDED sidecar.
 *
 * This set is deliberately DISJOINT from both {@link SCIP_PROVENANCE_PREFIXES}
 * (Tier 1, first-party oracle) and {@link SCIP_UNOFFICIAL_PROVENANCE_PREFIXES}
 * (Tier 1.5, pre-alpha SCIP). A reader MUST rank these three tiers distinctly:
 * a `lsp:` edge MUST NOT be treated as an oracle confirmer, MUST NOT be merged
 * into either SCIP bucket, and ranks below a `scip-unofficial:` edge. Keeping
 * the three arrays separate is what enforces that split at every reader.
 *
 * The match is `reason.startsWith("lsp:")`; the tail is
 * `<binary>@<pinned-version>` (e.g. `lsp:sourcekit-lsp@6.0.3`) so the exact
 * wrapped server + version is recoverable from the reason alone — load-bearing
 * for determinism (a server bump is a deliberate index-version bump).
 */
export const LSP_PROVENANCE_PREFIXES: readonly string[] = ["lsp:"];

export const PROVENANCE_PREFIXES: readonly string[] = SCIP_PROVENANCE_PREFIXES;
