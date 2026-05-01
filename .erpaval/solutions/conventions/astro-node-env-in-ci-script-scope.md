---
name: Astro NODE_ENV in CI — set it at script scope, not step scope
description: When building an Astro site in GitHub Actions with mise-action and pnpm, hard-code NODE_ENV=production in the package.json build script; CI-level step env and $GITHUB_ENV overrides get lost before reaching Vite's import.meta.env.DEV resolution.
type: project
---

Building an Astro + Starlight site via `pnpm -F @opencodehub/docs build`
in a GitHub Actions job that uses `jdx/mise-action@v4` appears to
resolve `import.meta.env.DEV` as `true` at Vite bundle time regardless
of step-level NODE_ENV overrides, causing production builds to ship
the Starlight Search dev stub ("Search is only available in production
builds.") instead of wiring Pagefind.

**What DID NOT work (tried in order):**

1. Job-level `env: { NODE_ENV: production }` — `mise-action` writes
   `NODE_ENV=development` to `$GITHUB_ENV` at setup time, which beats
   job env for subsequent steps.
2. Step-level `env: { NODE_ENV: production }` on the build step — should
   beat $GITHUB_ENV per GitHub docs, and the step's process env IS
   `NODE_ENV=production` as logged. Deployed HTML still had the stub.
3. Inline `env NODE_ENV=production pnpm -F @opencodehub/docs build` —
   pnpm → tsx → astro → Vite chain loses the env somewhere.
4. Writing `echo "NODE_ENV=production" >> "$GITHUB_ENV"` in a step
   preceding the build. Confirmed by log that build step sees
   `NODE_ENV: production`. Deployed HTML still had the stub.

**What DID work:**

Hard-coding NODE_ENV at the package.json script level:

```json
{
  "scripts": {
    "build": "NODE_ENV=production astro build && node scripts/inject-llm-nav.mjs"
  }
}
```

This puts the env assignment in the shell command that directly spawns
the `astro` binary — inside pnpm's child-process launch but outside of
any wrapping the pnpm/tsx/node chain does. Vite reads `process.env.NODE_ENV`
at that point and correctly resolves `import.meta.env.DEV=false`.

**Why:** Presumably something in mise's Node shim or in pnpm 10's
script-runner launders the env; whatever the mechanism, setting it
in the script command itself is the minimum distance from the spawned
process.

**How to apply:**

- For any Astro site in a pnpm monorepo in CI: set NODE_ENV in the
  package.json build script, not at CI env scope.
- Generally for any build tool that relies on `process.env.NODE_ENV`
  to decide production-vs-development compilation: treat script-scope
  as the authoritative place to set it, not CI-level plumbing.
- Side effect: the script works the same in CI and locally. A
  developer running `pnpm -F docs build` without NODE_ENV gets a
  production build too, which is the right default.

Seen 2026-05-01 on opencodehub. Pages deploy diagnostics in commits
`7cce473` → `0710235` → `b9dd853` → `144c678` → `f4152f8`. The winning
commit is `f4152f8`.
