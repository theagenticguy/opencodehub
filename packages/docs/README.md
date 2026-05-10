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

## Site IA

Top-level sections under `src/content/docs/`:

- `start-here/` — install, quick-start, first query.
- `guides/` — editor integrations and task-oriented walkthroughs.
- `mcp/` — server overview, tool catalog, resources, prompts.
- `reference/` — CLI, error codes, language matrix, configuration.
- `architecture/` — monorepo map, determinism, supply chain, ADR index.
- `skills/` — Claude Code skill references.
- `contributing/` — dev loop, testing, release process.

## ADRs

Architecture decision records live at `/docs/adr/` at the repo root — 10
files, numbered `0001-*.md` through `0010-*.md`. The Starlight site
surfaces them through an index page at
`src/content/docs/architecture/adrs.md`, so readers get both the canonical
source and a browsable index.

## Starlight plugins

Configured in `astro.config.mjs`:

- `starlight-llms-txt` — emits `/llms.txt`, `/llms-full.txt`, and
  `/llms-small.txt` at build time for LLM-crawlable bundles.
- `starlight-page-actions` — per-page "Copy as Markdown", "Open in ChatGPT",
  "Open in Claude", and Share actions.
- `starlight-links-validator` — build-time broken-link check so shipped
  bundles never carry dead links.

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
