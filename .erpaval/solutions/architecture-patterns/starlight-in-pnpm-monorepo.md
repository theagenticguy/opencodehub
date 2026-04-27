---
title: Starlight in a pnpm monorepo — minimal scaffold + GH Pages
tags: [astro, starlight, docs, pnpm, github-pages, monorepo]
first_applied: 2026-04-27
repos: [open-code-hub]
---

## The pattern

Add a Starlight docs site to a pnpm workspace as `packages/docs/`
without running the interactive `pnpm create astro` scaffolder. Nine
files give you a buildable site; one GitHub Actions workflow deploys
it to Pages. Total setup is ~5 minutes of file authoring plus one
`pnpm install` that adds astro + @astrojs/starlight to the root
lockfile.

## Required files

```
packages/docs/
├── package.json             # private, name @<scope>/docs, engines.node ">=22.12.0"
├── astro.config.mjs         # defineConfig + starlight integration with site+base
├── tsconfig.json            # extends "astro/tsconfigs/strict"
├── public/
│   ├── favicon.svg
│   └── .nojekyll            # empty — tells GH Pages "don't run Jekyll"
└── src/
    ├── content.config.ts    # defineCollection for 'docs' with docsLoader+docsSchema
    ├── assets/logo.svg
    ├── styles/custom.css    # optional; referenced via customCss in astro.config
    └── content/docs/
        ├── index.mdx        # landing page — template: splash + hero
        └── <sections>/*.md  # rest of content
```

## What you need in `astro.config.mjs`

```js
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://<owner>.github.io",
  base: "/<repo-slug>",             // leading slash, NO trailing slash
  integrations: [
    starlight({
      title: "...",
      social: [{ icon: "github", label: "GitHub", href: "https://..." }],
      editLink: { baseUrl: "https://github.com/<owner>/<repo>/edit/main/packages/docs/" },
      sidebar: [{ label: "...", autogenerate: { directory: "..." } }],
    }),
  ],
});
```

Critical: `site` has NO trailing slash, `base` starts with `/` and
has NO trailing slash. Pagefind, sitemaps, and canonical URLs all
derive from these.

## What you need in `src/content.config.ts`

Starlight 0.32+ uses `src/content.config.ts` — NOT the older
`src/content/config.ts` path that lots of tutorials still show.

```ts
import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
```

Without `docsLoader()` + `docsSchema()`, pages fail to build.

## GitHub Pages workflow

Two-job: build (upload pages artifact) then deploy (actions/deploy-pages).
Match the rest of your CI — if everything else uses `jdx/mise-action`,
don't switch to `withastro/action` just for this job.

```yaml
name: Pages
on:
  push:
    branches: [main]
    paths:
      - 'packages/docs/**'
      - '.github/workflows/pages.yml'
  workflow_dispatch:
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: false       # NOT true — canceling a mid-deploy leaves Pages in a weird state
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: jdx/mise-action@v4
      - run: pnpm install --frozen-lockfile --ignore-scripts
      - run: pnpm -F <scope>/docs build
      - uses: actions/upload-pages-artifact@v4
        with: { path: packages/docs/dist }
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v5
```

`--ignore-scripts` on install is safe here (docs don't need
tree-sitter native builds or other postinstall hooks).

## Gotchas

- **Node 22.12.0 minimum** for Astro 6. If your root `package.json`
  says `"node": ">=22.0.0"`, tighten `packages/docs/package.json`
  locally with its own `engines` block — don't force the whole repo
  up just for docs.
- **Biome does not parse `.astro` or `.mdx`.** Add to `biome.json`
  ignore list. Biome 2.2+ no longer wants a trailing `/**` on
  folder ignores — write `!packages/docs/src/content/docs`, not
  `!packages/docs/src/content/docs/**`.
- **Mark the docs package `private: true`.** This excludes it from
  the production license allowlist audit, which is useful because
  astro deps sometimes pull `caniuse-lite` (CC-BY-4.0) transitively.
- **`.nojekyll` is required** in `public/`. Without it, GitHub Pages
  strips `_astro/` and `_pagefind/` directories (underscore-prefixed
  paths are Jekyll-hidden by default).
- **Internal links need the base prefix.** Write
  `[text](/<repo-slug>/section/page/)` — plain `/section/page/`
  will 404 on Pages. Starlight's sidebar and `<LinkCard>` handle
  base automatically; only hand-written markdown links need care.
- **Enable Pages in repo settings once** (Settings → Pages → Build and
  deployment → Source: GitHub Actions) before the first push. The
  workflow silently succeeds-then-404s if Pages isn't enabled.

## When this pattern is wrong

- You need multi-version docs or i18n out of the box. Starlight
  supports both but the scaffold above is single-version English.
- You need an Algolia DocSearch index. Starlight ships Pagefind by
  default — good enough for most sites, no Algolia account needed.
- You need server-side rendering. Starlight is a static site; add
  `@astrojs/node` or similar only if you actually need SSR.
