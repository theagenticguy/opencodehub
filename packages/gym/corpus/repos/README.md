# Gym corpus — fixture repositories

Fixture repos live here as **git submodules** pinned to specific commits. Pin discipline:

1. The commit SHA in each `packages/gym/corpus/<lang>/<name>.yaml` corpus file is the authoritative pin.
2. The submodule at `packages/gym/corpus/repos/<lang>/<name>/` MUST match that SHA.
3. Updating a fixture is a deliberate 3-step PR:
   - `git submodule update --remote packages/gym/corpus/repos/<lang>/<name>`
   - Re-run `mise run gym:baseline` to regenerate goldens against the new SHA.
   - Review the regenerated corpus diff in the same PR.

## Fixtures

| Language   | Repo                                                        | License         | Approx LOC | Why |
|------------|-------------------------------------------------------------|-----------------|------------|-----|
| Python     | `strands-agents/sdk-python`                                 | Apache-2.0      | ~500 files | Baseline regenerated against scip-python (2026-04-27) |
| TypeScript | `gvergnaud/ts-pattern` @ v5.5.0                             | MIT             | ~2k        | Single-package, tsconfig, no bundler plugins |
| Go         | `spf13/cobra`                                               | Apache-2.0      | ~7k        | Interface-rich, cross-file implementation lookup |
| Rust       | `dtolnay/thiserror` @ 2.0.17                                | MIT/Apache-2.0  | ~4k        | Trait-heavy, minimal proc-macro noise |
| Monorepo   | in-tree `monorepo/electron-ws-python`                       | Apache-2.0      | ~1k        | Cross-language (TS renderer + main + shared package, Python backend); exercises tsconfig project references and documents Electron `contextBridge` / WebSocket string-boundary waivers |

## Disk footprint note

Submodules increase `git clone` size. If you want a shallow clone, use `git clone --recurse-submodules --shallow-submodules ...`.
