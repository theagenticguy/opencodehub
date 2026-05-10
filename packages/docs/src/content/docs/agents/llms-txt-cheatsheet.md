---
title: llms.txt cheatsheet
description: Which of /llms.txt, /llms-full.txt, /llms-small.txt to feed an agent.
sidebar:
  order: 6
---

import { LinkCard } from "@astrojs/starlight/components";

This site emits three crawlable text bundles at build time, plus three
narrow-set bundles. They are produced by the
[`starlight-llms-txt`](https://github.com/delucis/starlight-llms-txt)
plugin, configured in
[`packages/docs/astro.config.mjs`](https://github.com/theagenticguy/opencodehub/blob/main/packages/docs/astro.config.mjs).

## The three core bundles

| Bundle | Path | What it contains | When to feed it |
| --- | --- | --- | --- |
| Index | `/llms.txt` | A flat link list of every page on the site, with one-line descriptions. | When the agent has a small context window or you only want to point it at the index and let it follow links. |
| Full | `/llms-full.txt` | Every page concatenated as plain markdown — the whole corpus in one file. | When the agent has plenty of context budget and you want it to answer without crawling. |
| Small | `/llms-small.txt` | Same as `full`, with notes/tips/details and whitespace stripped. | When you want full coverage on a tighter context budget. Strips ~20 percent of bytes. |

## Three narrow sets

`astro.config.mjs` defines three custom sets that bundle a slice of
the site instead of the whole thing:

| Set | Path | Contains |
| --- | --- | --- |
| `user-guide` | `/llms-user-guide.txt` | `start-here/**` and `guides/**`. Install, quick-start, per-editor wiring. |
| `mcp` | `/llms-mcp.txt` | `mcp/**` and `reference/**`. Tool catalog, resources, prompts, CLI, error codes, language matrix. |
| `contributing` | `/llms-contributing.txt` | `contributing/**` and `architecture/**`. Dev loop, release flow, ADRs, determinism, supply-chain. |

The `agents/` section (this section) is bundled into the core three
files. If you want only the agent-onboarding pages in a single file,
fetch `/llms.txt`, grep for `/agents/`, and feed those URLs.

## Picking guidance

- Wiring an agent for the first time → `/llms-user-guide.txt`.
- Asking the agent to call OpenCodeHub tools well → `/llms-mcp.txt`
  plus the [tool decision matrix](/opencodehub/agents/tool-decision-matrix/)
  page.
- Asking the agent to contribute back → `/llms-contributing.txt`.
- One-shot "explain this whole project to me" → `/llms-small.txt` or
  `/llms-full.txt` depending on context.

## How to feed them

Most agent runtimes support a "context URL" or "knowledge file"
mechanism. Examples:

- Claude Code: drop the URL into a project memory file or paste the
  contents into a session.
- Cursor: add the URL under "Docs" in the settings panel; Cursor will
  fetch and chunk it.
- Codex CLI: use `--context-url`.
- Windsurf: paste in a Cascade workspace context.
- OpenCode: configure the URL in `opencode.json` under `docs`.

If the agent has a web fetch tool, just give it the URL and the
question.

## Verifying a bundle

After a docs build, the bundles are at
`packages/docs/dist/llms*.txt` locally and at the site root once
deployed. The build log prints a line like:

```text
[inject-llm-nav] patched 59 .md files, skipped 0 already-patched
```

That confirms the plugin ran and the bundles regenerated.

<LinkCard
  title="Discovery and resources"
  href="/opencodehub/agents/discovery-and-resources/"
  description="The full list of artifacts an agent can pull from."
/>
