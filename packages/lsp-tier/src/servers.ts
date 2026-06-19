/**
 * SCIP-blind language → LSP-server pin registry.
 *
 * These are the languages for which **no SCIP indexer exists** (probed
 * 2026-06-13: no `scip-swift`, no `scip-elixir`, etc. in either the
 * `sourcegraph` or `scip-code` orgs — see `research-scip-lsp.yaml#gaps`).
 * They are driven through the vendored **agent-lsp** wrapper (Tier-3
 * fallback) instead of SCIP.
 *
 * This is a **record registry** keyed by language, NOT a parallel switch
 * (lesson: `collapse-parallel-switches-into-record-registry`). One entry per
 * SCIP-blind language; adding a language is a one-line append.
 *
 * ## Why the version pin is load-bearing
 *
 * agent-lsp's SQLite cache is keyed by `sha256(file content) + symbol
 * identity` and is reproducible **GIVEN identical contents AND identical
 * server versions** (`research-scip-lsp.yaml`). The server version is
 * therefore part of the determinism contract: two runs with the same
 * `(contents, pinnedVersion)` produce byte-identical facts. A server-version
 * bump is a **deliberate index-version bump**, never a silent change — the
 * same discipline ADR 0006 applies to SCIP indexer pins.
 *
 * ## License (AC-A5)
 *
 * Each wrapped server carries its OWN license. agent-lsp's MIT covers only
 * the vendored wrapper code; the wrapped-server license governs the
 * subprocess. These servers are **detect-on-PATH-and-subprocess** — NEVER
 * bundled into this repo or the Docker image — which is exactly why an
 * EPL/Apache/MPL server is permissible here under OCH's existing
 * "GPL/MPL/EPL are subprocess-only" rule. The `license` field below feeds
 * the per-server license audit (see `auditWrappedServerLicenses`).
 *
 * ## Pin verification (BLOCKED-ON-ENV)
 *
 * Per the SCIP tool-pin lesson (`feedback_scip_tool_pin_verification`),
 * server-binary pins MUST be ground-truth verified (hit the upstream
 * release/registry, confirm the binary name + invocation). agent-lsp and
 * these servers are NOT installed in the build environment, so live
 * verification is **BLOCKED-ON-ENV**. The pins below are the researched
 * values; the live `--version` probe in `runner.ts` is what enforces them at
 * extraction time, and a mismatch against `pinnedVersion` is a hard failure.
 */

/** SPDX-ish license tokens for the wrapped LSP servers (AC-A5). */
export type WrappedServerLicense =
  | "Apache-2.0"
  | "MIT"
  | "EPL-2.0"
  | "MPL-2.0"
  | "BSD-3-Clause"
  | "ISC";

/** A SCIP-blind language driven through the agent-lsp Tier-3 fallback. */
export type ScipBlindLanguage =
  | "swift"
  | "zig"
  | "elixir"
  | "terraform"
  | "clojure"
  | "gleam"
  | "nix"
  | "lua"
  | "sql";

/**
 * A pinned LSP server for one SCIP-blind language. The `binary` is the
 * on-PATH executable agent-lsp wraps; `pinnedVersion` is the determinism
 * anchor; `license` is the wrapped-server SPDX for the per-server audit.
 */
export interface LspServerPin {
  readonly language: ScipBlindLanguage;
  /** On-PATH executable agent-lsp spawns (e.g. "sourcekit-lsp", "zls"). */
  readonly binary: string;
  /** The pinned server version. A bump is a deliberate index-version bump. */
  readonly pinnedVersion: string;
  /** Per-server license (AC-A5). Governs the subprocess, not the wrapper. */
  readonly license: WrappedServerLicense;
}

/**
 * The SCIP-blind language → server pin registry. Versions are the researched
 * pins (live verification BLOCKED-ON-ENV — servers absent in this build env).
 *
 * `Record<ScipBlindLanguage, LspServerPin>` keeps compile-time exhaustiveness:
 * tsc errors if a language is missing or unknown (same guarantee the SCIP
 * `LANG_REGISTRY` gets).
 */
export const LSP_SERVER_REGISTRY: Record<ScipBlindLanguage, LspServerPin> = {
  swift: {
    language: "swift",
    binary: "sourcekit-lsp",
    pinnedVersion: "6.0.3",
    license: "Apache-2.0",
  },
  zig: {
    language: "zig",
    binary: "zls",
    pinnedVersion: "0.13.0",
    license: "MIT",
  },
  elixir: {
    language: "elixir",
    binary: "elixir-ls",
    pinnedVersion: "0.22.1",
    license: "Apache-2.0",
  },
  terraform: {
    language: "terraform",
    binary: "terraform-ls",
    pinnedVersion: "0.36.2",
    // HashiCorp moved terraform-ls to BUSL-1.1 in later releases; 0.36.2 is the
    // last MPL-2.0 tag. MPL is subprocess-only under OCH's rule, so MPL is the
    // ceiling we pin to here. A BUSL bump would be a deliberate, audited change.
    license: "MPL-2.0",
  },
  clojure: {
    language: "clojure",
    binary: "clojure-lsp",
    pinnedVersion: "2024.11.08",
    license: "MIT",
  },
  gleam: {
    language: "gleam",
    binary: "gleam",
    pinnedVersion: "1.6.3",
    license: "Apache-2.0",
  },
  nix: {
    language: "nix",
    binary: "nil",
    pinnedVersion: "2023-08-25",
    license: "MIT",
  },
  lua: {
    language: "lua",
    binary: "lua-language-server",
    pinnedVersion: "3.13.5",
    license: "MIT",
  },
  sql: {
    language: "sql",
    binary: "sql-language-server",
    pinnedVersion: "1.4.0",
    license: "MIT",
  },
};

/**
 * The agent-lsp wrapper pin. Single Go binary (MIT) that wraps the per-server
 * subprocesses above. **Vendored** (port/wrap of `pkg/lsp` + `blast_radius`),
 * NOT a runtime npm dependency. Does NOT bundle servers — detect-on-PATH.
 *
 * Source: `github.com/blackwell-systems/agent-lsp` (live verification
 * BLOCKED-ON-ENV).
 */
export const AGENT_LSP_PIN = {
  name: "agent-lsp",
  version: "v0.15.0",
  license: "MIT" as const,
  source: "blackwell-systems/agent-lsp",
} as const;

/** The `server=<binary>@<pinnedVersion>` tag E-A4 requires on every fact. */
export function serverTag(pin: LspServerPin): string {
  return `${pin.binary}@${pin.pinnedVersion}`;
}

/** Resolve the pin for a SCIP-blind language, or `undefined` if not covered. */
export function pinForLanguage(language: string): LspServerPin | undefined {
  return (LSP_SERVER_REGISTRY as Record<string, LspServerPin | undefined>)[language];
}

/** True iff `language` is a SCIP-blind language driven by the Tier-3 fallback. */
export function isScipBlindLanguage(language: string): language is ScipBlindLanguage {
  return Object.hasOwn(LSP_SERVER_REGISTRY, language);
}

/**
 * The closed spawn allowlist for the lsp-tier runner — the agent-lsp binary
 * plus every wrapped server binary. Mirrors `scip-ingest`'s `ALLOWED_COMMANDS`
 * discipline: the runner validates against this set BEFORE spawning and
 * recovers the canonical literal from the set, so the executable reaching the
 * OS exec call is provably one of a fixed set (`shell: false`).
 */
export const LSP_ALLOWED_COMMANDS: ReadonlySet<string> = new Set<string>([
  AGENT_LSP_PIN.name,
  ...Object.values(LSP_SERVER_REGISTRY).map((p) => p.binary),
]);

/** True iff `cmd` is on the {@link LSP_ALLOWED_COMMANDS} spawn allowlist. */
export function isAllowedLspCommand(cmd: string): boolean {
  return LSP_ALLOWED_COMMANDS.has(cmd);
}

// ---------------------------------------------------------------------------
// Per-wrapped-server license audit (AC-A5)
// ---------------------------------------------------------------------------

/**
 * Per-server license audit verdict. Each wrapped LSP server is audited
 * INDIVIDUALLY (AC-A5): the wrapped-server license governs the subprocess,
 * agent-lsp's MIT covers only the vendored wrapper code.
 *
 * `subprocessOnly` records WHY a copyleft/weak-copyleft server (EPL, MPL) is
 * permissible: it is detect-on-PATH-and-subprocess, never linked or
 * redistributed by OCH — the same rule OCH applies to GPL/MPL SCIP
 * subprocesses (e.g. rust-analyzer). A server we ever BUNDLE would fail this.
 */
export interface WrappedServerLicenseAudit {
  readonly language: ScipBlindLanguage;
  readonly binary: string;
  readonly pinnedVersion: string;
  readonly license: WrappedServerLicense;
  /** True iff this license is only acceptable because the server is subprocess-only. */
  readonly subprocessOnly: boolean;
  /** `OK` (permissive) | `SUBPROCESS-ONLY` (EPL/MPL, on-allowlist as subprocess). */
  readonly tier: "OK" | "SUBPROCESS-ONLY";
}

/**
 * Licenses that are ONLY acceptable as a subprocess (never bundled/linked).
 * EPL and MPL are weak-copyleft / file-level-copyleft licenses — fine for a
 * detect-on-PATH server we shell out to, never for code we vendor or ship.
 */
const SUBPROCESS_ONLY_LICENSES: ReadonlySet<WrappedServerLicense> = new Set(["EPL-2.0", "MPL-2.0"]);

/**
 * Audit each wrapped LSP server's license individually (AC-A5). Returns one
 * verdict per registered server. EPL/MPL servers are surfaced as
 * `SUBPROCESS-ONLY` (on-allowlist because they are never bundled); permissive
 * servers (Apache/MIT/BSD/ISC) are `OK`. None BLOCK, because none is
 * linked/redistributed — every server is detect-on-PATH-and-subprocess.
 */
export function auditWrappedServerLicenses(): readonly WrappedServerLicenseAudit[] {
  return Object.values(LSP_SERVER_REGISTRY)
    .map((pin): WrappedServerLicenseAudit => {
      const subprocessOnly = SUBPROCESS_ONLY_LICENSES.has(pin.license);
      return {
        language: pin.language,
        binary: pin.binary,
        pinnedVersion: pin.pinnedVersion,
        license: pin.license,
        subprocessOnly,
        tier: subprocessOnly ? "SUBPROCESS-ONLY" : "OK",
      };
    })
    .sort((a, b) => (a.binary < b.binary ? -1 : a.binary > b.binary ? 1 : 0));
}
