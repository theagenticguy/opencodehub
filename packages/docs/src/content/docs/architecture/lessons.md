---
title: Durable lessons
description: Where prior-session architecture lessons live, why they are kept out of the published docs, and how to read them.
sidebar:
  order: 80
---

OpenCodeHub keeps a separate file tree of **durable lessons** —
post-mortems, gotchas, and patterns that future contributors should
read before touching the same code path. They live at
`.erpaval/solutions/` in the repo root and are committed.

## Why a separate tree

Three reasons the lessons live next to the code rather than on this
documentation site:

- **Granularity.** A lesson is one anchor (one bug, one pattern, one
  invariant) — too small to live as a published page, too important
  to lose. The directory layout (`api-patterns/`, `conventions/`,
  `architecture-patterns/`, `best-practices/`, `build-errors/`,
  `deploy-errors/`, `test-failures/`) keeps related anchors together.
- **Audience.** The audience is contributors who already know they
  are editing a specific file. The lesson is loaded in-context (read
  by an agent, or grep'd by a contributor) at edit time, not browsed
  in a docs site.
- **Format.** Each lesson has YAML frontmatter
  (`name`, `description`, `type`, `tags`, `modules`) that the agent
  toolchain reads programmatically. The published docs site uses a
  different schema and a different render.

## How to read them

```bash title="list every lesson"
ls -R .erpaval/solutions/
```

```bash title="read one"
cat .erpaval/solutions/architecture-patterns/igraphstore-itemporalstore-segregation.md
```

The lessons that shape this codebase the most include:

- `architecture-patterns/scip-replaces-lsp.md` — why we replaced the
  per-LSP phases with a single SCIP ingestion phase.
- `architecture-patterns/scip-callee-definition-site.md` — the SCIP
  callee-resolution invariant that prevents same-named methods from
  collapsing onto the wrong target.
- `architecture-patterns/scip-monorepo-dist-src-alias.md` — the
  TypeScript monorepo `dist/` ↔ `src/` alias pattern.
- `architecture-patterns/igraphstore-itemporalstore-segregation.md`
  — why M7 split the storage interface in two.
- `architecture-patterns/typed-finders-replace-raw-sql-in-consumers.md`
  — the call-site refactor that lets the graph backend swap
  underneath consumer packages.
- `api-patterns/sagemaker-embedder-backend.md` — the embedder backend
  pattern (dynamic import, credential soft-fail, structural-typing
  seam, modelId stamping, 413 split-retry).
- `conventions/scip-0-indexed-vs-graph-1-indexed.md` — the SCIP
  zero-indexed vs graph one-indexed boundary conversion.
- `conventions/scip-protobuf-hand-rolled-reader.md` — why the SCIP
  protobuf reader is hand-rolled.
- `conventions/llms-txt-as-ground-truth.md` — why the
  `astro.config.mjs` `details` string is the load-bearing text on
  the docs site.
- `conventions/release-published-event-needs-pat-or-inline.md` — why
  `release.yml` listens on both `release: published` and
  `workflow_call`.
- `conventions/bm25-over-node-id-favors-stubs.md` — why BM25 over
  node IDs needs to be gated against unresolved-property stubs.

Get the complete list with:

```bash
git log --diff-filter=A --name-only --format= -- '.erpaval/solutions/**' | sort -u
```

## Why they are not auto-imported

We considered importing the directory as a `lessons` Starlight
content collection. Two friction points kept the v1 docs scoped to
in-tree pages instead:

1. **Lesson titles can include literal patterns** the docs build
   intentionally rejects (project planning coordinates, strings the
   banned-strings sweep covers). Ingesting them as published pages
   would couple the public docs build to the lesson tree's looser
   conventions.
2. **The audience is not a docs reader.** Lessons load best from the
   filesystem at edit time — by an agent during a coding session, or
   by a contributor who just got a stack trace. A published page
   does not improve discoverability for that workflow.

The published docs site cites individual lessons by relative path
(e.g. `Durable lesson: api-patterns/sagemaker-embedder-backend.md`)
where they are load-bearing for an architecture page. That is the
narrow integration v1 ships.
