---
name: doctor-probe-drift-after-rip-and-replace
description: After a rip-and-replace that removes a dependency from the published install graph, `doctor`-style health probes for that dependency keep returning "ok" against the dev workspace and "fail" against the shipped CLI for months. Dev `node_modules` masks the drift; clean-checkout CI doesn't catch it because the probe's test asserts the workspace shape.
metadata:
  type: best-practice
  category: best-practices
tags: [rip-and-replace, doctor, install-graph, drift-detection, ci]
discovered: 2026-05-28
session: session-88b46e
related:
  - squash-merge-masks-pre-existing-debt
  - dogfood-prepush-hook-caught-cli-spec-mismatch
---

# Doctor-style probes drift after rip-and-replace

## The pattern

A rip-and-replace lands (e.g. ADR 0015 native→WASM tree-sitter cutover in 0.4.0). The published CLI tarball stops shipping `tree-sitter` and `tree-sitter-typescript` as deps. **But the `doctor` command's `treeSitterNativeCheck` keeps probing for them**, and its test asserts the probe doesn't return `status: "fail"`.

Locally, dev `node_modules` is hot from prior installs — the probe finds the packages, returns `ok`, the test passes, CI is green. **A clean `pnpm install --frozen-lockfile` would have turned the test red, but no scheduled job runs that.** The bug ships, the published CLI returns `fail` on every user's machine with a misleading hint to "re-run pnpm install to rebuild native bindings (requires clang/g++)".

This survived for 4+ months between the 0.4.0 cutover and the 2026-05-28 audit that caught it.

## Why this is hard to catch

Three layers of false-negatives stacked:

1. **Probe under-tested** — the test asserted `notEqual(status, "fail")`, which permits `ok`, `warn`, and other shapes. It didn't assert the probe was registered for the right reason.
2. **Test runs against the dev workspace, not the published shape** — `pnpm` strict-isolation hides workspace deps from packages that don't directly declare them, except when running tests, which use the resolved-from-disk graph. So the probe finds packages a user wouldn't.
3. **No drift sweep on rip-and-replace** — ADRs deprecate code, but no checklist enforces sweeping every consumer (in this case `doctor.ts` and `doctor.test.ts`) at the same time.

## How to apply

1. **At rip time**, grep the codebase for the removed package name AND for the `resolveFromRoot` / `createRequire` patterns that probed it. Every hit must either be deleted or updated to probe whatever replaced it.
2. **Add a clean-checkout doctor smoke** to the `verify-global-install` matrix. This is what the published CLI does on a user box. If it diverges from dev `pnpm test`, that's the canary.
3. **Tighten doctor probe assertions** — `assertEqual(status, "ok")` is the right shape, not `assertNotEqual(status, "fail")`. The latter passes on `warn`, on `undefined`, and on a probe that was never registered.
4. **Maintain a "doctor invariants" audit** — when the install graph changes (deps added/removed, workspace topology changes), open a `doctor.ts` review. Same triage you'd run for a public API change.

## Detection signal at audit time

What surfaced this in the 2026-05-28 audit was reading **the test docstring** rather than the test body. The block at `doctor.test.ts:163-170` explicitly says "the `repoRoot` walk-four-dirs-up heuristic yields a path that doesn't contain the packages, but `createRequire(import.meta.url)` does" — that comment is a half-confession that the test depends on the CLI's own resolution context. Once you read it, the latent failure is obvious. Add a checklist item: "any test whose docstring describes a fragile resolution context is a drift candidate."

## Generalization beyond doctor

The same pattern applies to:

- **`postinstall` scripts** that probe for or rebuild native bindings.
- **`mise.toml` tool comments** ("required to build X" — when X is gone, the comment lies).
- **CI matrix branches** keyed on legacy capability flags (e.g. `OCH_NATIVE_PARSER` env in `.github/workflows/ci.yml` — also dead post-rip).
- **Help strings and `--skip-X` flags** that name removed capabilities.

Every rip-and-replace produces a small constellation of these. Treat the rip as incomplete until the constellation is gone.

## Linked

- [[squash-merge-masks-pre-existing-debt]] — same family (CI green doesn't mean code clean).
- [[dogfood-prepush-hook-caught-cli-spec-mismatch]] — example of a self-targeting check that catches drift.
- PR #138 — the four-site fix for the 0.4.0 native→WASM tree-sitter rip.
- ADR 0015 — the rip itself.
