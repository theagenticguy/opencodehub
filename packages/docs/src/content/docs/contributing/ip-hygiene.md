---
title: IP hygiene
description: The clean-room rule, the license allowlist, banned-strings sweep, and supply-chain gates.
sidebar:
  order: 50
---

OpenCodeHub is a clean-room implementation distributed under Apache-2.0.
That promise has to hold end to end — in the source we write, in the
dependencies we pull, and in the binaries we ship. This page documents
the rules and the CI gates that enforce them.

## The clean-room rule

Do not copy code, comments, or test data from any source licensed under
PolyForm, BSL, Commons Clause, GPL, or AGPL. If a prior-art project
solves a problem we also want to solve, you may read its docs and
papers, but you may not look at its source while writing ours. When in
doubt, ask.

The rule is boring. Our enforcement is not: every file on `main` goes
through a banned-strings sweep that rejects identifiers lifted verbatim
from projects we deliberately do not copy from. If one of those names
appears in your diff, CI turns red.

## License allowlist

Every production (transitive) dependency must be on this list:

```
Apache-2.0
MIT
BSD-2-Clause
BSD-3-Clause
ISC
CC0-1.0
BlueOak-1.0.0
0BSD
```

The check runs via
[`license-checker-rseidelsohn`](https://www.npmjs.com/package/license-checker-rseidelsohn):

```bash title="mise.toml — licenses task"
pnpm exec license-checker-rseidelsohn \
  --onlyAllow 'Apache-2.0;MIT;BSD-2-Clause;BSD-3-Clause;ISC;CC0-1.0;BlueOak-1.0.0;0BSD' \
  --excludePrivatePackages \
  --production
```

`--excludePrivatePackages` skips our own workspace packages; `--production`
skips `devDependencies` (which may legitimately include non-redistributable
tooling like scanners invoked as subprocesses — see below).

Run it locally with `mise run licenses`, or let `mise run check:full` run
it as part of the extended gate.

:::note[Known inconsistency]
`scripts/acceptance.sh` gate 5 currently uses a shorter allowlist that
omits `BlueOak-1.0.0` and `0BSD`. The authoritative list — the one we
enforce before publishing — is the `mise.toml` / CI version above. We
plan to reconcile the acceptance script to match. If you find a
BlueOak- or 0BSD-licensed transitive dep and acceptance fails but
`mise run licenses` passes, that is why.
:::

## Banned-strings sweep

`scripts/check-banned-strings.sh` is a `git grep` sweep over every
tracked file (and every untracked, non-ignored file) for identifiers we
have agreed never to use. It runs on `pre-commit` via lefthook, on
every CI job, and as acceptance gate 4.

The banned literals are the names of prior-art projects and internal
planning artifacts we scrubbed before going public. The exact list
lives in `scripts/check-banned-strings.sh` — read it there, do not
memorize it here. If you need to reference one of these names in
documentation (this rarely happens), add the file to the pathspec
allowlist at the bottom of that script.

The sweep also rejects planning-code regex patterns that belong to an
older internal planning model we do not ship. The patterns themselves
live in `scripts/check-banned-strings.sh` — reference the script if
you need to know what is being rejected.

## Vulnerability scanning

Every CI run and `mise run check:full` pass runs
[osv-scanner](https://github.com/google/osv-scanner) against
`pnpm-lock.yaml`:

```bash
osv-scanner scan source --lockfile pnpm-lock.yaml .
```

Results are uploaded as SARIF to the GitHub Security tab. Release gate
policy: zero open CVEs on the lockfile at release time.

## CodeQL

`.github/workflows/codeql.yml` runs GitHub's CodeQL on the TypeScript
surface. Findings surface in the Security tab and block release PRs at
`high` severity.

## OpenSSF Scorecard

`.github/workflows/scorecard.yml` runs the
[OpenSSF Scorecard](https://scorecard.dev/) weekly and on every push to
`main`. It checks branch-protection posture, signed releases, pinned
dependencies, CI test runs, and a dozen other supply-chain signals. The
score is visible on the repo homepage via the badge.

## Software Bill of Materials

`SBOM.cdx.json` at the repo root is a CycloneDX v1.5 SBOM covering the
full runtime dependency graph. It is regenerated on every release by
`.github/workflows/sbom.yml` and attached to the GitHub Release.

The human-readable companion is `THIRD_PARTY_LICENSES.md`, also at the
repo root, which enumerates every third-party package with its license
text.

## Scanners that are not permissively licensed

Some tools we expose via `codehub scan` and `codehub ingest-sarif`
(hadolint GPL-3.0, tflint MPL-2.0/BUSL) are not on the allowlist. We
resolve this by invoking them as subprocesses only — we never `import`
them, never statically link them, and never redistribute them. The
scanners are a user-provided runtime dependency, not a OpenCodeHub
dependency. See `packages/scanners/src/` for the thin wrapper that
shells out.

This is the same pattern GitHub CodeQL uses with third-party SARIF
producers, and the same that OBJECTIVES.md commits to explicitly.

## If a gate fails

Every failure is a blocker:

- Banned literal found → rename the identifier or remove the borrowed
  text. Do not add it to the allowlist unless you have a genuine
  documentation reason.
- License allowlist violation → pick a different dep, wait for the dep
  to relicense, or open an ADR explaining why this one is required.
- CVE on lockfile → bump the dep, patch-pin to a fixed version, or open
  an advisory waiver in the PR description. Waivers must cite the CVE,
  the reason the bump is not yet possible, and a due date.

## Related files

- `scripts/check-banned-strings.sh` — the sweep.
- `mise.toml` — `licenses` and `osv` tasks.
- `.github/workflows/{ci,codeql,scorecard,sbom}.yml` — CI gates.
- `SBOM.cdx.json`, `THIRD_PARTY_LICENSES.md`, `NOTICE`, `LICENSE` — what
  ships in every release.
