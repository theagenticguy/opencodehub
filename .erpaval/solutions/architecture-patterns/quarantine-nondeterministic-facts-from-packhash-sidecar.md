---
title: Quarantine nondeterministic extraction facts in a packHash-excluded sidecar
track: knowledge
category: architecture-patterns
severity: info
tags: [determinism, packHash, lsp, tier, sidecar, provenance, quarantine, adr-0019, adr-0005, erpaval]
modules: [packages/lsp-tier, packages/pack, packages/core-types]
discovered: session-893add (2026-06-19)
---

# Pattern

When you must add a lower-trust, inherently nondeterministic extraction source (here: LSP-server output for SCIP-blind languages — Swift/Zig/Elixir/Terraform/Clojure — via the vendored agent-lsp `workspace/symbol` + `blast_radius` logic) to a system whose value rests on a byte-identical reproducibility contract (`packHash`), DO NOT fold the new facts into the hashed manifest. Quarantine them:

1. **Separate sidecar, outside the hash preimage.** LSP facts live in `lsp-tier.sidecar.json`, NOT in `manifest.files[]`. `manifest.ts` (the hash input) is left 0-diff untouched. Result: `packHash` is byte-identical with vs without Tier-3 present — proven by a test that runs the real `buildManifest` both ways and asserts equality (`quarantine.test.ts` → "U2 QUARANTINE: packHash is byte-identical with vs without Tier-3 facts").
2. **Distinct, disjoint provenance tier.** A new `LSP_PROVENANCE_PREFIXES = ["lsp:"]` in core-types, pairwise-disjoint from `SCIP_PROVENANCE_PREFIXES` (first-party) and `SCIP_UNOFFICIAL_PROVENANCE_PREFIXES` (Tier 1.5). Every fact tagged `source=lsp`, `server=<binary>@<pinned-version>`. A consumer can always tell a compiler-grade edge from a heuristic one.
3. **Canonical re-sort at the boundary.** LSP output is unordered and server-version-sensitive; re-sort every collection to a stable key before any consumer reads it (the sidecar has its OWN byte-stability contract, separate from packHash).
4. **Opt-in + hard-fail.** Spawning the lower-trust source is opt-in (no opt-in → zero spawns, silent degrade to the existing tier). A partial/timeout result is a HARD failure, never cached.
5. **License the wrapped subprocess separately.** When vendoring a wrapper (agent-lsp MIT) that shells out to third-party servers (jdtls EPL, clangd/elixir-ls Apache), the WRAPPED server's license governs the subprocess — audit each one; the wrapper's permissive license does not launder them.

# Why

It lets you EXTEND breadth (a recurring product pull) without eroding the one uncontested moat (deterministic, reproducible packing). The determinism contract stays provably intact; the new capability rides alongside at a clearly-labeled lower confidence tier. Formalized in ADR 0019, which AMENDS rather than reverses ADR 0005 (0005 rejected LSP as the primary ORACLE; 0019 admits it as a labeled, batch-only, packHash-quarantined FALLBACK).

# Reusable test shape

The load-bearing assertion is cheap and must exist: build the real hashed artifact WITH and WITHOUT the quarantined facts on disk and assert the hash is byte-identical, plus a volume variant (N facts vs 0 facts → same hash). If that test can't be made to pass, the quarantine is leaking — stop and redesign, don't ship. Mirrors the broader OCH rule: [[determinism-is-the-only-uncontested-moat]] — protect the hash above all new features.
