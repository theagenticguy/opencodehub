# Spec 009 — task list (Plan → Act)

Single sequential stream. Every task mutates the `packHash` preimage chain
(`types.ts` → `context-bom.ts` → `manifest.ts` → `index.ts`), so they CANNOT
run as parallel Act waves on a shared tree (per `parallel-act-subagents`
lesson). Implement in order; build+test after each logical unit.

| Task | Files | Depends on | Parallel-safe |
|---|---|---|---|
| T1 — types: `BomItem.kind += "context-bom"`, `PackManifest.contextBomHash`, `schemaVersion: 2`, new `ContextBomComponent`/opts types | `pack/src/types.ts` | — | no |
| T2 — builder: `buildContextBom` + canonical serializer + own-hash | `pack/src/context-bom.ts` (new) | T1 | no |
| T3 — manifest: thread `contextBomHash` into preimage + snake_case wire | `pack/src/manifest.ts` | T1 | no |
| T4 — wire into generatePack: build, write `context-bom.json`, append BomItem, pass hash to manifest | `pack/src/index.ts` | T2,T3 | no |
| T5 — tests: `context-bom.test.ts` (R2/R3/R4/R6/R7) + manifest schema-2 + determinism re-pin | `pack/src/*.test.ts` | T4 | no |
| T6 — CLI read path: `--explain-context [--json]` | `cli/src/commands/code-pack.ts` + test; bump `bomItemCount` assertions 8→9 | T4 | no |

## Gate 1 (pre-Act) checklist
- [x] Spec corrected for F1 (chunker empty in prod) / F3 (no per-file license).
- [x] Anchor = File nodes (prod-populated), byte-ranges best-effort.
- [x] Transitive packHash binding via manifest preimage (R3 free).
- [x] No golden-hash literal to refresh (F5 — cross-run equality harness).
- [x] No MCP tool added (no roster contract bump beyond bomItemCount).
- [x] No spec-coordinate tokens in source (F6).
- [x] Clean baseline established: typecheck exit 0, pack+cli tests 0 fail.

## Done = acceptance gate (spec §6)
build + typecheck + test green (direct pnpm, install precheck is sandbox-flaky);
banned-strings + licenses + sarif:validate pass; pack:determinism stays byte-identical;
`code-pack --explain-context --json` emits valid CycloneDX 1.6.
