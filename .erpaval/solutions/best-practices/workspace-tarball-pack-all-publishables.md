---
title: "Smoke-testing a workspace cli requires packing every publishable workspace dep"
tags:
  - npm
  - pnpm
  - publish
  - install-graph
  - workspace
  - global-install
  - tarball
  - smoke-test
  - tree-sitter-cli
modules:
  - scripts/verify-global-install.sh
  - packages/cli
  - packages/ingestion
  - packages/pack
severity: medium
created: 2026-05-15
session: session-569b82
track: bug
category: best-practices
---

# Smoke-testing a workspace cli requires packing every publishable workspace dep

## Symptom

`scripts/verify-global-install.sh local` failed gates 2, 3, 4 even after the
parser refactor moved native tree-sitter out of every workspace `dependencies`
block. The install log showed:

```
npm warn   tree-sitter-cpp@"0.23.4" from @opencodehub/ingestion@0.3.2
npm warn     node_modules/@opencodehub/cli/node_modules/@opencodehub/pack/node_modules/@opencodehub/ingestion
...
> tree-sitter-cli@0.23.2 install
Downloading https://github.com/tree-sitter/tree-sitter/releases/...
```

The freshly-packed cli@0.4.0 tarball pinned `@opencodehub/ingestion@0.4.0`
correctly. But it *also* pinned `@opencodehub/pack@0.2.0`, and only ingestion +
cli were `pnpm pack`'d locally. npm fell back to **registry** for `pack` —
fetched the previously-published `@opencodehub/pack@0.1.3` — which pinned
`@opencodehub/ingestion@0.3.2` (the version live at pack@0.1.3's publish time).
The install graph ended up with BOTH ingestion@0.4.0 and ingestion@0.3.2, and
the 0.3.2 copy still had every native tree-sitter package as runtime deps.

## Root cause

`pnpm pack` resolves `workspace:*` at pack time. So the cli tarball's
`package.json` lists concrete versions for every workspace dep. But when
`npm install -g <cli.tgz>` runs, npm tries to satisfy each of those concrete
versions from somewhere. If the local tarball directory only has cli + ingestion,
every other workspace dep (`@opencodehub/pack`, `@opencodehub/mcp`,
`@opencodehub/analysis`, …) gets fetched from the public registry. Those
registry versions were published earlier, with whatever ingestion version was
current at THEIR publish time.

This is a published-graph-vs-local-graph divergence problem unique to npm
workspaces that publish per-package and to release-please's
multi-package-versioning model.

## Fix

`scripts/verify-global-install.sh` packs **every** publishable workspace
package and supplies them all to `npm install -g`:

```bash
while IFS= read -r pj; do
  is_private=$(node -e "process.stdout.write(String(JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8')).private||false))" "$pj")
  if [ "$is_private" = "true" ]; then continue; fi
  pkg_dir=$(dirname "$pj")
  pnpm pack -C "$pkg_dir" --pack-destination "$TARBALL_DIR" >/dev/null
done < <(find "$ROOT/packages" -maxdepth 2 -name package.json)
```

Then pass the entire glob to `npm install -g --foreground-scripts <all-tgz>`.

## How to apply

When running a global-install smoke test for any workspace cli that ships
multiple packages to the same registry:

1. Pack every non-private workspace package via `pnpm pack` into a single
   tarball directory.
2. Pass them ALL to `npm install -g` in one command. Order doesn't matter
   inside the single call — npm resolves the graph internally.
3. Trust the smoke test only when the resolved graph matches what
   release-please will publish in production. If `release-please` will only
   bump some packages, the smoke test should drop the un-bumped ones from
   the local tarball set so npm pulls the registry copy (matches reality).
4. Bump ALL workspace packages whose `dependencies` block references the
   bumped package. If you bump `@opencodehub/ingestion@0.4.0` (breaking),
   bump `@opencodehub/pack` and `@opencodehub/cobol-proleap` and
   `@opencodehub/cli` too — otherwise consumers of those packages get an
   install graph with TWO ingestion versions, only one of which is breaking.

## Why this matters

This bug masked the entire bulletproof-npm-install fix for one verify pass.
The actual published-cli install would have hit the same failure: the cli
tarball pulled `pack@0.1.3` from registry → `ingestion@0.3.2` → native
`tree-sitter-cli@0.23.2` → GitHub-release postinstall download.

The lesson: every published workspace package that depends on a
breaking-changed peer must bump in the SAME release. release-please's
default conventional-commits configuration may need explicit
`linked-versions` or per-package config to catch this — verify before
publishing.

## Related

- [[parallel-act-subagents-with-shared-git-tree]] — same flavor of "stale
  state masquerading as fresh" but for dist artifacts.
- [[squash-merge-masks-pre-existing-debt]] — same flavor: the working
  state and the published state can disagree silently.
