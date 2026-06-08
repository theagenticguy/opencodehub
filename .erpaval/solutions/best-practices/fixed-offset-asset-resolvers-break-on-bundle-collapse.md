---
name: fixed-offset-asset-resolvers-break-on-bundle-collapse
description: When a publish-many monorepo is collapsed into one tsup bundle, EVERY runtime asset resolver that computes its path with a fixed count of `..` segments from `import.meta.url` breaks silently — the emitted module layout flattens (dist/commands/x.js → dist/x-<hash>.js) and inlined workspace code lands at a different depth than its source. The fix-one-resolver collapse PR left six others on fixed offsets; symptoms ranged from a hard "plugin source not found" throw to a silent zero-symbol `analyze`. Convert every such resolver to a depth-agnostic walk-up probe, and verify against a real packed-tarball global install, not the hot dev node_modules.
metadata:
  type: bug
  category: best-practices
tags: [tsup, esbuild, bundle-collapse, import-meta-url, asset-resolver, walk-up, npx, global-install, wasm, vendor-wasms, plugin-assets, ci-templates, betterleaks]
discovered: 2026-06-08
session: session-asset-resolver
related:
  - tsup-collapse-monorepo-to-single-cli
  - doctor-probe-drift-after-rip-and-replace
  - workspace-tarball-pack-all-publishables
  - parallel-remediation-gate-failures-are-build-artifacts
---

# Fixed-offset `import.meta.url` asset resolvers break on bundle collapse

## What bit us

User ran `npx @opencodehub/cli@latest init` and got:

```
codehub init: plugin source not found at /Users/…/.npm/_npx/<hash>/plugins/opencodehub.
```

Root cause: PR #189 (the 17→1 tsup collapse, `dd1b9b6`) flattened the emitted
module layout from `dist/commands/init.js` to a flat `dist/init-<hash>.js`. Every
runtime asset resolver that computed its path with a **fixed count of `..`
segments** from `import.meta.url` was calibrated for the old nested layout and
silently shifted by one level. `init.ts`'s `defaultPluginSourceDir()` fell
through its primary + walk-up candidates to a 4-level `../../../../plugins/
opencodehub` last resort → the `_npx/<hash>/plugins/opencodehub` path in the
error.

This is the SAME hazard the prior collapse lesson
([[tsup-collapse-monorepo-to-single-cli]], gotcha 3) explicitly warned about —
"make the resolvers walk up … rather than a fixed `../../` offset — the offset
shifts when code is inlined." The collapse PR applied that fix to **only**
`doctor.ts`, leaving six other resolvers on fixed offsets. The lesson existed;
it just wasn't applied exhaustively.

## The full blast radius (one root cause, six sites)

| Resolver | Asset | Pre-fix offset | Symptom in flat bundle |
|---|---|---|---|
| `cli init.ts` `defaultPluginSourceDir` | `plugin-assets/` | `join(dir,"..","plugin-assets")` + 4-up fallback | **hard throw** `plugin source not found` |
| `cli ci-init.ts` `resolveTemplatesDir` | `commands/ci-templates/` | sibling `<HERE>/ci-templates` | templates one level too high → throw |
| `cli setup.ts` `defaultPluginSourceDir` | `plugin-assets/` (whole tree) | 4-up `../../../../plugins/opencodehub` | `setup --plugin` source not found |
| `scanners betterleaks.ts` `defaultConfigPath` | `config/betterleaks.default.toml` | `resolve(here,"..","..","config")` | **silent** — default allowlist never applied |
| `ingestion wasm-runtime.ts` `VENDOR_WASMS_DIR` | `vendor/wasms/*.wasm` | `resolve(here,"..","..","vendor","wasms")` | **silent + worst** — `analyze` emits 0 code symbols, exits 0 |
| `ingestion grammar-registry.ts` `MANIFEST_PATH` | `vendor/wasms/manifest.json` | `new URL("../../vendor/wasms/manifest.json")` | parse-cache version pin lost |

The two **silent** ones are the dangerous tail: `codehub analyze` exited 0 while
the WASM parser threw `ENOENT` internally and produced only a file/dir skeleton
(5 nodes, `query` → 0 results) instead of a real graph (10 nodes, Function/Class
symbols). A broken parser that exits clean reads as "working" in any smoke that
only checks the exit code.

## Survivors — what the correct pattern looks like

`doctor.ts` (vendor-wasms probe), `cobol-proleap-setup.ts`, and `index.ts`
(pkg-json) were immune. The first two walk UP probing for a sentinel; the third
is safe for a different reason worth knowing: **the bin entry `dist/index.js`
never moves** — tsup pins `index` at the dist root in every layout — so its
single `..` is depth-stable even though it's a hardcoded offset. The test:
a fixed offset is safe ONLY if the module's own emitted location is invariant.

## The fix

One shared walk-up probe per package (the CLI can't be imported by `scanners`/
`ingestion`, so each bundled-into-CLI package gets its own copy):

```ts
// walk UP from import.meta.url, probe each candidate subpath at every level,
// first existing hit wins — never assumes a depth.
export function resolveAsset(candidates, { fromFileUrl, kind = "dir", maxLevels = 10 }) {
  let dir = dirname(fileURLToPath(fromFileUrl));
  for (let level = 0; level <= maxLevels; level++) {
    for (const segs of candidates) {
      const c = join(dir, ...segs);
      if ((kind === "file" ? isFileSync : isDirSync)(c)) return c;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null; // caller falls back to a conventional path for a clean error
}
```

Order candidates **bundle-first** (`["plugin-assets"]` before
`["plugins","opencodehub"]`) so the shipped path wins over a coincidental
source-tree match.

## Two traps that hid the silent failures

1. **The CLI bundles workspace deps from their built `dist/`, not `src/`**
   (`noExternal: [/^@opencodehub\//]` inlines from each lib's compiled output).
   Editing `scanners/src/betterleaks.ts` and rebuilding ONLY the CLI bundles the
   STALE `scanners/dist`. You must rebuild changed deps **in dependency order**
   (ingestion + scanners → then cli) or the fix never reaches the bundle. An
   adversarial verifier caught exactly this: source fixed, emitted chunk still
   broken. Generalizes [[parallel-remediation-gate-failures-are-build-artifacts]].

2. **Tests injected the asset path, so the default resolver was never exercised.**
   `init.test.ts`/`setup.test.ts` all passed `sourceDir: BUNDLED_ASSETS` and the
   WASM disk checks were gated behind `CODEHUB_PLATFORM=1`. The broken
   `defaultPluginSourceDir()` had zero direct coverage — the canonical
   [[doctor-probe-drift-after-rip-and-replace]] gap. Fix: a regression test that
   runs the resolver against the **real emitted `dist/`** (skip-loud if unbuilt),
   plus synthetic-tree tests pinning flat-bundle / nested / source layouts.

## How to verify (don't trust the hot dev tree)

`npm install -g <packed.tgz>` into a hermetic prefix, then run the user's exact
failing commands AND `codehub analyze` on a real fixture + `query` for a known
symbol — exit code alone hides the silent-parser failure. `scripts/
verify-global-install.sh local` is the canonical 9-gate cell (it packs, installs,
and smokes `analyze` + `query`). For the literal npx path, an already-cached
`_npx/<hash>` entry serves the OLD published build — clear it
(`rm -rf ~/.npm/_npx/<hash>`) or use `npm exec --package=<tgz>` with an isolated
`npm_config_cache`, or the rebuild is masked.

## If you only remember one thing

After ANY bundler collapse / rip / inline that changes the emitted module
layout, `grep -rn "import.meta.url" packages/*/src` and audit **every** resolver
for a fixed `..` offset — not just the one that threw. They share a root cause;
the loud one is found first, the silent ones ship.
