---
title: Verify npm package canonicality via the upstream repo README install command
tags: [npm, supply-chain, dependency-pinning, squatters]
session: session-e1d819
---

## Context

M5 Wave 1 wired `chonkie@^0.3.0` into `packages/pack/package.json` after
a 2026-05-05 research yaml. Reality: the npm namespace is split across
three plausible names — `chonkie-ts` (PolyerAI squatter, v0.0.1, 2.6 kB,
abandoned), the bare `chonkie` (chonkie-inc-owned but undocumented for
TS callers), and the canonical TS port `@chonkiejs/core@^0.0.9`. Only
the upstream `chonkie-inc/chonkiejs` README install command disambiguates.
T-W2-5 retracted to `@chonkiejs/core` after grounding (commit 77f37c3:
`chore(pack): switch chonkie dep to @chonkiejs/core@^0.0.9`).

## Lesson

Before pinning any npm dep — especially for an emergent library — open
the upstream repository's README and copy the literal `npm install` /
`pnpm add` line. The npm registry has stale squatters and unsuffixed
namesakes that look canonical but aren't. The upstream README is the
only authoritative source for "which package name does the maintainer
actually ship to". Apply this rule when:

- The package shows up in research yaml without a verified install command.
- A `-ts` / `-js` suffixed variant exists alongside the bare name.
- npm-side metadata (last publish, weekly downloads, deps) looks thin.

Concrete checks for a candidate dep:

1. Pull the repo README and grep for `npm install` / `pnpm add` / `yarn add`.
2. Cross-check the package.json `name` in the upstream repo against the
   pinned name.
3. If the bare name and a scoped `@org/pkg` name both exist, prefer the
   scoped name unless the README install line says otherwise.

## Why

npm name-squatting is undefended; the registry has no concept of
"canonical port". The upstream maintainer's README is the only source
of truth that survives organization renames, scope migrations, and
abandoned forks. This is cheap to check (one README fetch) and stops
shipping a 2.6 kB stub or an undocumented unsuffixed namesake to
production.
