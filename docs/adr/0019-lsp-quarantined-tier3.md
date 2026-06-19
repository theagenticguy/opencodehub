# ADR 0019 — LSP returns as a quarantined Tier-3 fallback for SCIP-blind languages

- Status: accepted
- Date: 2026-06-19
- Authors: @theagenticguy + Claude
- Branch: `feat/v1-distribution-breadth`
- Amends: **ADR 0005** (SCIP replaces LSP) — narrows its scope; does NOT reverse it.

## Context

ADR 0005 (2026-04-26) deleted `@opencodehub/lsp-oracle` and replaced four
long-running language servers with one-shot SCIP indexers. That decision was,
and remains, correct for every language that HAS a SCIP indexer: SCIP is a
deterministic artifact producer (no daemon, no stateful JSON-RPC, no per-symbol
roundtrips), and its `confidence=1.0` + `reason="scip:<indexer>@<version>"`
oracle contract is load-bearing across `confidence-demote`, `summarize`,
`mcp/confidence`, and the analyze CLI auto-cap.

ADR 0005 rejected LSP for two reasons:

1. **Per-file / interactive**: the LSP oracle drove per-symbol JSON-RPC
   roundtrips with agent-supplied positions — an interactive shape, not a batch
   one.
2. **Stateful / running-server**: LSP servers are long-running daemons with
   warmup cost and stdio correlation.

Two facts have changed the calculus for the **SCIP-blind** languages — the ones
with NO SCIP indexer at all:

- **There is no `scip-swift`, no `scip-elixir`** (probed 2026-06-13 in both the
  `sourcegraph` and `scip-code` orgs — see `research-scip-lsp.yaml#gaps`). The
  SCIP-blind set is Swift, Zig, Elixir, Terraform/HCL, Clojure, Gleam, Nix, Lua,
  SQL. T-A-S added `scip-php`/`scip-dart` at Tier 1.5, but those languages DO
  have indexers; these nine do not. Today they get only Tree-sitter heuristic
  edges.
- **agent-lsp** (`blackwell-systems/agent-lsp@v0.15.0`, MIT) exposes a **batch**
  primitive that defeats objection #1: `workspace/symbol`(empty query)
  enumerates ALL project symbols headlessly, and `blast_radius` auto-enumerates
  exported symbols across a file set and resolves cross-file references
  **without agent-supplied positions**. This is the batch primitive ADR 0005
  assumed LSP lacked.

Objection #2 (stateful server) still stands for LSP — but **OpenCodeHub already
pays exactly that cost** for its SCIP subprocesses (rust-analyzer, scip-java,
the dotnet toolchain). Running a subprocess is not a new architectural cost.

## Decision

**Amend ADR 0005's scope: LSP returns ONLY as a labeled, batch-only,
packHash-quarantined Tier-3 FALLBACK for SCIP-blind languages.** SCIP and
Tree-sitter tiers are unchanged. LSP is NOT reinstated as the oracle ADR 0005
rejected — the oracle remains SCIP, and for SCIP-blind languages the fallback
is strictly below the SCIP and `scip-unofficial` tiers in confidence.

A new workspace package `@opencodehub/lsp-tier` (Apache-2.0, vendoring
agent-lsp's MIT `pkg/lsp` + `blast_radius` logic — NOT a runtime npm dep on
agent-lsp) owns:

- the SCIP-blind language → LSP-server pin registry (`servers.ts`),
- the warmup-block → `workspace/symbol`(empty) → `blast_radius` driver
  (`runner.ts`),
- the `source=lsp` / `server=<binary>@<pinned-version>` tagging + canonical
  re-sort (`provenance.ts`),
- the packHash-EXCLUDED sidecar writer (`sidecar.ts`).

The ingestion wiring is a new `lsp-tier` phase
(`packages/ingestion/src/pipeline/phases/lsp-tier-index.ts`), opt-in only.

### Tier model (three disjoint provenance classes)

| Tier | Provenance prefix | Source | Confidence | packHash |
|------|-------------------|--------|------------|----------|
| 1 | `scip:<indexer>@<v>` | First-party SCIP oracle | 1.0 | IN (via SCIP edges in the graph hash) |
| 1.5 | `scip-unofficial:<indexer>@<v>` | Pre-alpha SCIP (php, dart) | 0.7 | IN |
| **3** | **`lsp:<binary>@<v>`** | **agent-lsp fallback (SCIP-blind langs)** | **lowest** | **EXCLUDED (sidecar)** |

`LSP_PROVENANCE_PREFIXES = ["lsp:"]` in `@opencodehub/core-types` is deliberately
disjoint from both SCIP prefix sets so a reader ranks the three tiers distinctly
and never treats an LSP edge as an oracle confirmer.

### The non-negotiable: packHash quarantine (U2)

**Tier-3 LSP facts MUST NOT enter the packHash preimage.** The preimage is the
fixed 9-key field set in `@opencodehub/pack`'s `manifest.ts`
(`buildManifest` → `toSnakeCaseManifest`): `budget_tokens, commit,
determinism_class, files, pack_hash, pins, repo_origin_url, schema_version,
tokenizer_id`. There is no LSP field there, and `manifest.ts` is NOT modified by
this ADR.

LSP facts live in a SEPARATE file, `<repo>/.codehub/lsp-tier.sidecar.json`,
that `buildManifest` never reads. Adding or removing the sidecar therefore
cannot move the packHash. **Proven**: a pack of a repo with SCIP-blind sources
produces a `packHash` byte-identical to the same pack with Tier-3 disabled
(`packages/lsp-tier/src/quarantine.test.ts`, asserted against the real
`buildManifest`). A server-version bump is a deliberate index-version bump
(update the pin in `servers.ts`), never a silent packHash change. If a future
fold-in into the index is ever wanted, it enters ONLY via a
server-version-pinned, sorted `pins`-style entry treated as a deliberate
bump — never silently.

### Determinism (U7)

agent-lsp output is NOT globally sorted and server versions are NOT pinned by
default (`research-scip-lsp.yaml#determinism_risk`). The runner therefore:

- pins each server version (`LSP_SERVER_REGISTRY`); the version is load-bearing
  because agent-lsp's SQLite cache key folds it in, and a mismatch against the
  pin is a hard failure;
- tags every fact `source=lsp` / `server=<binary>@<pinned-version>`;
- canonically re-sorts every fact list (`canonicalizeFacts`) before any consumer
  reads it, so two runs over identical contents + identical server versions
  produce a byte-identical sidecar.

### Warmup is a hard failure boundary (S-A4b)

agent-lsp warmup is stateful (fsnotify watcher, 5-min cold-start ceiling). The
runner BLOCKS until full readiness. A query that returns before readiness, or a
result flagged partial/timed-out, is a **HARD failure** (`LspTierHardFailure`) —
NEVER written to the SQLite cache or the sidecar. A partial is not a degraded
cache entry; it is no entry. A server-version mismatch against the pin is the
same hard failure.

### Opt-in only (O-A7)

The `lsp-tier` phase is a silent no-op unless `options.tier3Lsp === true`
(CLI `--tier3-lsp`). When off, NO LSP server is spawned, NO daemon warms up, and
SCIP-blind languages degrade to Tree-sitter heuristics silently — no daemon, no
warmup cost. The `offline` flag always wins.

### Per-wrapped-server license audit (AC-A5)

agent-lsp does NOT bundle servers — it detects them on PATH and spawns them as
subprocesses. Each wrapped server carries its OWN license; agent-lsp's MIT
covers only the vendored wrapper code. **Each wrapped server is license-audited
individually** (`auditWrappedServerLicenses`):

| Language | Server | Pin (live verification BLOCKED-ON-ENV) | License | Audit |
|----------|--------|----------------------------------------|---------|-------|
| Swift | sourcekit-lsp | 6.0.3 | Apache-2.0 | OK |
| Zig | zls | 0.13.0 | MIT | OK |
| Elixir | elixir-ls | 0.22.1 | Apache-2.0 | OK |
| Terraform | terraform-ls | 0.36.2 | MPL-2.0 | SUBPROCESS-ONLY |
| Clojure | clojure-lsp | 2024.11.08 | MIT | OK |
| Gleam | gleam | 1.6.3 | Apache-2.0 | OK |
| Nix | nil | 2023-08-25 | MIT | OK |
| Lua | lua-language-server | 3.13.5 | MIT | OK |
| SQL | sql-language-server | 1.4.0 | MIT | OK |

The wrapped-server license governs the subprocess. An EPL/MPL server (e.g.
`terraform-ls` is MPL-2.0; `jdtls`, were it ever wrapped, is EPL) is permissible
ONLY because it is detect-on-PATH-and-subprocess, never bundled or linked — the
same rule OpenCodeHub already applies to GPL/MPL SCIP subprocesses. A server we
ever BUNDLED would fail the audit. The server pins above are the researched
values; **live ground-truth verification is BLOCKED-ON-ENV** because agent-lsp
and the servers are not installed in this build environment (per the SCIP
tool-pin lesson, the live `--version` probe in `runner.ts` enforces the pin at
extraction time and hard-fails on mismatch).

## Consequences

### Positive

- Swift, Zig, Elixir, Terraform, Clojure, Gleam, Nix, Lua, SQL gain symbol +
  cross-file-edge intel at a labeled lower-confidence tier, instead of
  Tree-sitter heuristics only.
- The packHash determinism contract (U2) is preserved byte-for-byte — the
  quarantine is structural (separate file), not a convention.
- No runtime npm dependency on agent-lsp; the wrapper logic is vendored and the
  servers are detect-on-PATH (no supply-chain or bundle-license exposure).

### Negative / follow-ups

- **Live extraction is BLOCKED-ON-ENV**: agent-lsp and the wrapped servers are
  not installed in this build/CI environment. The opt-in/quarantine/sidecar/
  hard-fail contract is fully unit-tested with fixtures; a live end-to-end run
  against real servers is a follow-up that requires provisioning the servers and
  wiring the production `LspBackend`.
- The server version pins need ground-truth verification (release/registry
  enumeration) before a deployment trusts them — the runner's version-pin
  hard-fail is the runtime guard until then.
- A future gym corpus for SCIP-blind languages would let us regression-test the
  Tier-3 edges; none exists today.

### Neutral

- Tree-sitter stays as the heuristic tier for SCIP-blind languages when Tier-3
  is off (the O-A7 default), exactly as before this ADR.

## References

- Amends: ADR 0005 (SCIP replaces LSP) — scope narrowed, not reversed.
- Related: ADR 0006 (SCIP indexer pins — the same deliberate-bump discipline
  applies to the LSP server pins here).
- Research: `.erpaval/sessions/session-893add/research-scip-lsp.yaml`
  (agent-lsp surface, determinism risk, license caveat, `adr_0005_verdict`).
- Lesson: `.erpaval/solutions/architecture-patterns/scip-replaces-lsp.md`
  (the ADR-0005 rationale this ADR scopes an exception to).
- Package: `packages/lsp-tier/` — `@opencodehub/lsp-tier`.
- Quarantine proof: `packages/lsp-tier/src/quarantine.test.ts`.
