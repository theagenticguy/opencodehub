# @opencodehub/docs

Astro + Starlight documentation site for OpenCodeHub. Deployed to
GitHub Pages at https://theagenticguy.github.io/opencodehub/.

## Local development

```bash
pnpm install
pnpm -F @opencodehub/docs dev       # http://localhost:4321/opencodehub
pnpm -F @opencodehub/docs build     # writes to packages/docs/dist
pnpm -F @opencodehub/docs preview   # serves dist/ locally
```

Prefer the mise tasks from the repo root:

```bash
mise run docs:dev
mise run docs:build
mise run docs:preview
```

## Authoring

Pages live under `src/content/docs/`. Starlight picks up any
`.md` or `.mdx` file automatically; the sidebar auto-generates
per top-level directory.

Frontmatter fields we use:

```yaml
---
title: Page title
description: One-sentence SEO/summary
sidebar:
  order: 1        # lower first; ties break alphabetically
  label: Short    # optional override
---
```

## Deploy

`.github/workflows/pages.yml` runs on pushes to `main` that touch
`packages/docs/**` or the workflow itself. It builds with
`withastro/action@v6` pinned to Node 22 and deploys with
`actions/deploy-pages@v5`.
