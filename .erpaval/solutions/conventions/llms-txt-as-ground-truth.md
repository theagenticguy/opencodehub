---
name: llms-txt config strings quietly anchor doc accuracy
description: When a docs site emits /llms.txt, the project description and tool-count claims in astro.config.mjs become the quietly canonical values — audit them first in doc-sync sweeps.
type: project
---

During a deep docs-sync sweep (2026-05-01), five separate docs drifted to
`27 MCP tools` while the MCP server registered `28`. The one place that
was correct was `packages/docs/astro.config.mjs`'s
`starlightLlmsTxt.details` string, because that string is emitted into
`/llms.txt`, `/llms-full.txt`, `/llms-small.txt` at build time and gets
crawled by agents. Once someone types a specific count there, it tends
to get kept in sync with reality (the author is actively thinking about
what agents will see).

The README, OBJECTIVES.md, CLAUDE.md, AGENTS.md, and several Starlight
pages drifted; the llms-txt config did not.

**Why:** LLM-crawlable bundles make the number load-bearing. A wrong
number in `/llms.txt` directly teaches agents wrong facts, so the author
treats the config as a high-stakes statement. Prose docs feel lower-stakes
and drift.

**How to apply:** In any doc-sync sweep on a repo with
`starlight-llms-txt` (or similar llms.txt generators), read
`astro.config.mjs` first. The numbers in `starlightLlmsTxt.description`
and `.details` are a quiet ground-truth. Reconcile prose docs to match
those, not the other way around. If you change a cardinal fact (tool
count, supported languages, model IDs), grep the whole repo for the
old number — you will find 3-5 prose sites that lagged.
