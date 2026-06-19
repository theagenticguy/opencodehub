# Tasks 008 — Docker distribution + SCIP/LSP breadth + determinism receipts

**Spec**: `.erpaval/specs/008-distribution-determinism-breadth/spec.md` · **Branch**: `feat/v1-distribution-breadth`

Sequenced by dependency, not calendar (ROADMAP convention). Docker (Track B) is the hinge: Track A's heavy indexers ride the image, so B lands before A-S, which lands before A-L. Track C runs in parallel from day one. Each task is an Act-phase packet — the owning subagent edits its own section per the write-protocol and flips `status: COMPLETE` when `mise run check` (scoped) is green.

```
Wave 1 (parallel):  T-B1 ─┐                         C1 ─ C2  (independent)
                    T-C9 ─┤ (MCP _meta — hard clock) C4 ─ C7  (testbed)
Wave 2:             T-B1 ─► T-B2 ─► T-B3 (full image w/ indexers)
Wave 3:             T-B3 ─► T-A-S (php/dart Tier-1.5)
Wave 4 (gated Q1):  T-A-S ─► T-A-L (LSP Tier-3, quarantined)
```

---

## Wave 1 — foundations + hard-clock items (parallel)

### T-B1 — Docker multistage skeleton (lite variant) + scope-enum

- **Spec AC**: E-D1, E-D4, S-D5, AC-D0, AC-D8, U5, U8, U9
- **Type/scope**: `build(docker)` — **add `docker` to `commitlint.config.mjs` scope-enum in this same commit** (it is absent; first-use rule).
- **Files**: `Dockerfile`, `.dockerignore`, `mise.toml` (`docker-build` task), `commitlint.config.mjs` (scope-enum += `docker`), `README.md` (`docker run -i` + `.mcp.json` snippet), `.erpaval/ROADMAP.md` (§Explicitly rejected += single-binary line per AC-D0).
- **Scope of this task**: stage-1 `node:24` builder (`corepack prepare pnpm@11.1.0`, `pnpm install --frozen-lockfile`, build, `pnpm deploy --prod --filter @opencodehub/cli`) → stage-2 `node:24-slim` runtime copying pruned app + native `.node` + `.wasm` grammars. **Lite variant only** (no embedder, no JVM). Entry: `och-mcp` over stdio.
- **Verify**: `docker build -t och:lite .` then `docker run -i --rm och:lite och-mcp` answers an `initialize`/`server/discover` round-trip; image ≤ ~350 MB; `verify-global-install.yml` npm path untouched (U8).
- **blocked_by**: []  · **parallel_safe**: true

### T-C9 — MCP stateless `_meta` migration (hard clock: July 28)

- **Spec AC**: E-C9, AC-C14, U7
- **Type/scope**: `feat(mcp)`
- **Files**: `packages/mcp/src/server.ts`, `tool-handlers.*`, every tool in `packages/mcp/src/tools/*`, `error-envelope.ts` (add `UnsupportedProtocolVersionError`).
- **Scope**: read protocolVersion/clientInfo/clientCapabilities from `_meta` per-request; drop dependence on `initialize`-handshake state; pin `protocolVersion=2026-07-28` **gated on the upstream MCP SDK** shipping support — if the SDK is not ready, land the per-request `_meta` read behind a version-detect shim and leave the pin as a follow-up. Do NOT hand-roll the transport.
- **Verify**: server answers requests carrying `_meta` version data; mismatch → `UnsupportedProtocolVersionError`; existing `server.test.ts` green.
- **blocked_by**: [] · **parallel_safe**: true · **risk**: HIGH (touches every handler; SDK timing)

### T-C1 — `pack --prove` + `replay`

- **Spec AC**: E-C1, E-C2, AC-C3, U2
- **Type/scope**: `feat(pack)` + `feat(cli)`
- **Files**: `packages/pack/src/prove.ts` (new), `packages/cli/src/commands/pack.ts` (`--prove` flag), `packages/cli/src/commands/replay.ts` (new), `.github/workflows/release.yml` (reuse `attest-build-provenance` for pack subject), docs.
- **Scope**: emit in-toto SLSA v1 statement, subject digest == existing `manifest.ts` packHash, predicate = `(commit, tokenizer, budget, pins)` + BOM inputs by URI+digest; sign via `attest-build-provenance` (CI) and `cosign sign-blob --bundle` (local). `replay <hash>`: checkout commit → re-pack → recompute → byte-compare → exit 0/non-zero+diff. Offline verify path documented.
- **Verify**: `pack --prove` then `replay <hash>` on the same `(commit,tokenizer,budget)` exits 0; tamper a BOM byte → non-zero with the drifted item named; `cosign verify-blob-attestation` works offline against a vendored root.
- **blocked_by**: [] · **parallel_safe**: true

### T-C2 — cache-prefix reframe (docs + pack ordering)

- **Spec AC**: AC-C4, E-C5
- **Type/scope**: `docs(pack)` + `refactor(pack)`
- **Files**: `packages/pack/src/index.ts` (stable-first BOM ordering), `packages/pack/README.md`, ROADMAP framing note.
- **Scope**: order skeleton/file-tree/deps first for the longest cache-eligible prefix; rewrite docs to lead with cache-prefix stability (0.1× read, Opus-4.8 1,024-tok min, ≤4 breakpoints, tools→system→messages invalidation), retire "fewer tokens". Honest caveat: first call pays 1.25×/2.0× write.
- **Verify**: pack output order is deterministic + stable-first; docs reviewed; no packHash change for unchanged inputs (U2 — ordering is part of the canonical form, so this is a one-time hash rebaseline, gate it explicitly).
- **blocked_by**: [] · **parallel_safe**: true · **note**: reordering BOM items changes packHash once — rebaseline the determinism fixtures in the same commit.

---

## Wave 2 — full Docker image (carries the indexer toolchains)

### T-B2 — jlink JRE + curated SCIP set in the full image

- **Spec AC**: E-D2, E-D3, AC-D6, AC-D7
- **Type/scope**: `build(docker)`
- **Files**: `Dockerfile` (full-variant stage / target), `mise.toml` (`docker-build-full`), `.github/workflows/docker.yml` (new — buildx amd64+arm64, smoke test).
- **Scope**: buildx multi-arch; add jlink-trimmed JRE + scip-java (pinned), scip-go static binary (`scip-code/scip-go@v0.2.7`), `COPY --from=ghcr.io/astral-sh/uv:latest` for Python indexers; scip-typescript already an npm dep. NO GPL/MPL binaries (AC-D6).
- **Verify**: full image builds for both arches; `license_audit` over the image stays on-allowlist; smoke test runs scip-go + scip-java on a fixture inside the container.
- **blocked_by**: [T-B1] · **parallel_safe**: false

---

## Wave 3 — finish "all SCIP" (Tier 1.5)

### T-A-S — scip-php + scip-dart runners at Tier-1.5 + ADR 0006 refresh

- **Spec AC**: E-A1, E-A2, AC-A3, AC-A3b, U3, U7
- **Type/scope**: `feat(scip-ingest)` + `feat(core-types)` + `docs(repo)` (ADR)
- **Files**: `packages/scip-ingest/src/runners/index.ts` (`IndexerKind` += `php`,`dart`; `ALLOWED_COMMANDS` += `scip-php`,`scip-dart`; `detectLanguages` composer.json/pubspec.yaml), `packages/scip-ingest/src/runners/php.ts` + `dart.ts` (+ tests mirroring `ruby.test.ts`/`dotnet.test.ts`), `packages/core-types` (`SCIP_PROVENANCE_PREFIXES` += `scip-unofficial:`), `packages/analysis` confidence-demote + `packages/mcp` confidence-breakdown surfacing the tier, `docs/adr/0006-scip-indexer-pins.md` (scip-go path → `scip-code/scip-go@v0.2.7`, CLI `scip-code/scip@0.8.1`, php/dart rows).
- **Scope**: both runners gated behind `--allow-build-scripts`; edges ingested at the new `scip-unofficial` (Tier 1.5) label, distinct from first-party `scip:`. Full toolchains run inside the T-B2 image.
- **Verify**: php fixture (composer.json) and dart fixture (pubspec.yaml) emit `.scip`, ingest at Tier 1.5; spawn-allowlist test passes; graphHash byte-identity holds (U1); confidence breakdown shows the tier.
- **blocked_by**: [T-B2] · **parallel_safe**: false

---

## Wave 4 — LSP Tier-3 (GATED on Q1 = "amend ADR 0005")

### T-A-L — `@opencodehub/lsp-tier` for SCIP-blind languages, quarantined from packHash

- **Spec AC**: E-A4, S-A4b, AC-A5, AC-A6, O-A7, U2, U7
- **Type/scope**: `feat(lsp-tier)` — **add `lsp-tier` to scope-enum in the first commit**.
- **Files**: `packages/lsp-tier/*` (new pkg — vendor agent-lsp's MIT `pkg/lsp` LSPClient + `blast_radius` enumerate-resolve, OR shell its `--http` server version-pinned), `packages/ingestion` (wire Tier-3 for SCIP-blind langs), `packages/pack` (sidecar exclusion from packHash preimage), `packages/core-types` (tier tag), `docs/adr/0019-lsp-tier-3-for-scip-blind-languages.md` (new), `commitlint.config.mjs` (scope-enum += `lsp-tier`), license-audit entries for each wrapped server (AC-A5).
- **Scope**: drive `workspace/symbol`(empty) → `blast_radius` over the file list; tag every fact `source=lsp`/`server=<bin>@<pin>`; canonically re-sort; **exclude from packHash preimage** (sidecar). Block on full warmup; partial result = hard failure (S-A4b). Opt-in only; otherwise degrade to Tree-sitter silently (O-A7).
- **Verify**: Swift/Elixir/Terraform fixtures produce symbols + cross-file edges; packHash byte-identity unchanged with Tier-3 present (U2 — proves the quarantine holds); license_audit green for each wrapped server; ADR 0019 written.
- **blocked_by**: [T-A-S, **Q1 decision**] · **parallel_safe**: false · **status**: BLOCKED-ON-DECISION

---

## Track C tail (testbed repo — independent)

### T-C7 — CORE-Bench L3 harness (in `opencodehub-testbed`)

- **Spec AC**: AC-C6, E-C7, AC-C8
- **Repo**: `opencodehub-testbed` (NOT core — validation constraint #4).
- **Scope**: read the CORE-Bench PDF tables first (AC-C8) to fix the metric (nDCG@k vs Recall@k); embed L3 queries+corpus via OCH retrieval, rank, score against gold labels; report framed by CodeCompass +23.2-pt G3. ContextBench as the secondary recall/precision harness.
- **blocked_by**: [] (independent) · **parallel_safe**: true

### T-C10/C11/C12/C13 — MCP RC remainder (after T-C9)

- **Spec AC**: E-C10 (`server/discover`), E-C11 (remove ping/logging.setLevel/roots.list_changed), E-C12 (`ttlMs`+`cacheScope` fields), AC-C13 (README stdio-rail rationale).
- **Type/scope**: `feat(mcp)` / `docs(mcp)`
- **blocked_by**: [T-C9] · **parallel_safe**: true (each is localized/additive)

---

## Status board

| Task | Wave | Track | Status | Blocked by |
|------|------|-------|--------|-----------|
| T-B1 | 1 | B | PENDING | — |
| T-C9 | 1 | C | PENDING | — |
| T-C1 | 1 | C | PENDING | — |
| T-C2 | 1 | C | PENDING | — |
| T-C7 | 1 | C(testbed) | PENDING | — |
| T-B2 | 2 | B | PENDING | T-B1 |
| T-A-S | 3 | A | PENDING | T-B2 |
| T-C10–13 | 3 | C | PENDING | T-C9 |
| T-A-L | 4 | A | **BLOCKED-ON-DECISION (Q1)** | T-A-S + Q1 |
