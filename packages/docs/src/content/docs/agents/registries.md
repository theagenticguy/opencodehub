---
title: MCP registries
description: Where OpenCodeHub is listed (or planned to be listed) for one-click MCP discovery.
sidebar:
  order: 5
---

import { LinkCard } from "@astrojs/starlight/components";

MCP registries let an operator search for a server, copy a config, and
paste it into an editor. OpenCodeHub is Apache-2.0 and open to listing
on every public registry. This page lists the targets and the
submission shape each one needs.

## Official MCP Registry

- Registry URL: <https://registry.modelcontextprotocol.io>
- Listing: not yet listed — submission planned.
- What an operator does: use any MCP-aware client that consumes the
  official registry feed (Glama, mcpservers.org, mcp-awesome.com all
  index it). Search for `io.github.theagenticguy/opencodehub`.

The official registry is the priority listing — it propagates to
several aggregators automatically. OpenCodeHub will publish a
`server.json` validated against the
`https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`
schema. The namespace will be `io.github.theagenticguy/opencodehub`,
which only requires GitHub OAuth as the user, not DNS verification.

The `server.json` declares the npm package and the stdio transport:

```json title="server.json — planned shape"
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "io.github.theagenticguy/opencodehub",
  "title": "OpenCodeHub",
  "description": "Code-intelligence graph indexer with 29 MCP tools for coding agents",
  "repository": {
    "url": "https://github.com/theagenticguy/opencodehub",
    "source": "github"
  },
  "packages": [
    {
      "registryType": "npm",
      "registryBaseUrl": "https://registry.npmjs.org",
      "identifier": "@opencodehub/cli",
      "transport": { "type": "stdio" },
      "packageArguments": [
        { "type": "positional", "value": "mcp" }
      ]
    }
  ]
}
```

A required validation rule: the published npm package's README must
contain an `mcp-name:` marker matching the `name` field, otherwise
publish fails. Same rule for PyPI README and Docker labels.

## Smithery

- Registry URL: <https://smithery.ai>
- Listing: not yet listed — submission planned.
- What an operator does: open the OpenCodeHub listing on Smithery,
  click "Install" for their editor, paste the generated config block.

Smithery reads `smithery.yaml` from the repo. For OpenCodeHub's
stdio path:

```yaml title="smithery.yaml — planned"
startCommand:
  type: stdio
  configSchema:
    type: object
    properties: {}
  commandFunction: |-
    (config) => ({ command: 'codehub', args: ['mcp'] })
  exampleConfig: {}
```

Submission flow: sign in at smithery.ai with GitHub, connect the
OpenCodeHub repo, Smithery indexes from `smithery.yaml`.

## Glama

- Registry URL: <https://glama.ai/mcp/servers>
- Listing: not yet listed — auto-indexes from the official MCP
  Registry, so the listing lands when registry publish lands.
- What an operator does: browse the Glama catalog, grab the JSON
  snippet, paste it into the editor's MCP config file. The server
  still runs locally on the operator's machine — Glama is read-only
  metadata.

## awesome-mcp-servers

- Registry URL: <https://github.com/punkpeye/awesome-mcp-servers> and
  <https://github.com/appcypher/awesome-mcp-servers>.
- Listing: not yet listed — PR planned, one entry per repo, in the
  "Code Analysis" or "Developer Tools" category.
- What an operator does: this is a curated GitHub README. They find
  the link, follow it to this repo, and use [Install](/opencodehub/agents/install/).

## Aggregator directories

- <https://mcpservers.org> and <https://mcp-awesome.com>.
- Listing: automatic — both scrape from the official MCP Registry
  plus popular awesome-lists. Inclusion lands when the official
  registry publish lands.

## Where _not_ to PR

- `modelcontextprotocol/servers` — restricted to reference
  implementations maintained by the steering group. Community
  servers are explicitly redirected to the official registry.

## Submission status

The five priority targets above (Official MCP Registry, Smithery,
Glama, awesome-mcp-servers x2) are the v1.0 submission set. If you
hit this page and any of them shows OpenCodeHub but this page still
says "not yet listed", the listing landed and the docs need an update
— open an issue or a PR.

## Why local-first beats hosted

OpenCodeHub indexes your code on your machine. The MCP server is a
stdio process that the editor launches. No daemon, no SaaS, no socket
opens by default (`codehub analyze --offline` enforces this). That
constraint is why every registry above lists it as an "install
locally" server — there is nothing to host.

<LinkCard
  title="Install"
  href="/opencodehub/agents/install/"
  description="The canonical install path. Five steps, any editor."
/>
