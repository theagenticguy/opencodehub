---
name: vendored-artifact-bump-must-revendor-in-same-pr
description: A Dependabot/manual bump of a dependency that has a committed vendored artifact (a copied .wasm, a generated lockfile-derived blob, a snapshotted schema) must re-run the vendoring script IN THE SAME PR. The prepublishOnly guard that checks artifact-vs-pin drift does NOT run in CI — it only fires at `npm publish`, so the bump passes every gate and detonates at release time, aborting a dependency-ordered multi-package publish mid-stream.
metadata:
  type: convention
  category: conventions
tags: [release, dependabot, vendored-wasm, prepublish, web-tree-sitter, monorepo-publish]
discovered: 2026-05-28
session: session-88b46e
related:
  - doctor-probe-drift-after-rip-and-replace
  - release-published-event-needs-pat-or-inline
---

# A vendored-artifact dependency bump must re-vendor in the same PR

## What bit us

PR #137 (consolidated Dependabot bumps) moved `web-tree-sitter` 0.26.8 → 0.26.9 in `packages/ingestion/package.json`. It did NOT re-run `scripts/build-vendor-wasms.sh`, so:

- `packages/ingestion/vendor/wasms/web-tree-sitter.wasm` stayed the 0.26.8 blob (sha `082795b…`, not the 0.26.9 `1ed02fe…`)
- `vendor/wasms/manifest.json` still recorded `"web-tree-sitter": "0.26.8"`

PR #137 passed **every CI gate** — lint, typecheck, all 1959 tests, banned-strings, CodeQL — and merged clean. The drift only surfaced 4 PRs later at `npm publish` time, where ingestion's `prepublishOnly` guard (`verify-vendor-wasms.mjs`) compares the manifest version string against the package.json pin and `process.exit(1)` on mismatch.

Because `pnpm -r publish` runs in **dependency order** and ingestion is upstream of cli/mcp/pack, that one guard failure **aborted the entire publish mid-stream** — the v0.6.2 release published 11 leaf packages then died, leaving cli/ingestion/mcp/pack/cobol-proleap unpublished. Recovery took a fix PR (#147) + a second release (0.6.3).

## Why CI doesn't catch it

The guard runs as `prepublishOnly`, NOT as a test or a CI step. By design: it's a release-time integrity check, and re-vendoring needs a toolchain (docker/emcc for build-from-source grammars) that CI deliberately doesn't provision. So the guard is invisible until `npm publish` — exactly the same failure-shape as [[doctor-probe-drift-after-rip-and-replace]] (a check that only fires in an environment CI doesn't exercise).

## The rule

When bumping a dependency that has a committed vendored artifact, the SAME PR must regenerate the artifact:

1. Identify vendored-artifact deps before merging a bump. In this repo: `web-tree-sitter` (and the `tree-sitter-*` grammars) → `packages/ingestion/vendor/wasms/`. Any dep whose version is mirrored into a committed blob + a manifest is in this class.
2. After the bump, run the vendor script (`bash scripts/build-vendor-wasms.sh`) — or, if only the runtime blob changed and the build-from-source grammars are unmoved, do the targeted copy the script's tail does: `cp node_modules/.pnpm/<dep>@<ver>/node_modules/<dep>/<artifact>.wasm vendor/wasms/` + bump the manifest string.
3. Run the guard directly as the gate: `node packages/ingestion/scripts/verify-vendor-wasms.mjs` must exit 0.
4. Commit the regenerated artifact + manifest alongside the package.json bump.

### Make Dependabot bumps of these deps fail loud in CI
The real fix is to stop relying on the publish-time guard. Add the guard (or a content-hash check) to the normal CI test job for `@opencodehub/ingestion`, so a stale vendored artifact turns a PR red instead of a release. A bump that touches a vendored-artifact dep should never be green in CI while the artifact is stale. Until that's wired, treat every `web-tree-sitter` / `tree-sitter-*` Dependabot PR as "must re-vendor before merge" and check the manifest in review.

## How to apply during a Dependabot consolidation

When squashing Dependabot bumps (the recurring task in this repo — see the history-rewrite + consolidation playbook), scan the bump list for vendored-artifact deps FIRST. For each one, re-vendor in the consolidation branch before running `pnpm run check`. The 0.26.8→0.26.9 bump shipped in a consolidation PR precisely because the consolidation step didn't have this check.

## Linked

- [[doctor-probe-drift-after-rip-and-replace]] — same family: a check that only runs outside CI drifts silently.
- PR #137 (the bump that drifted), #147 (the re-vendor fix), v0.6.3 (the recovery release).
