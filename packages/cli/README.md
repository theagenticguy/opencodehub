# @opencodehub/cli

```bash
# global install
npm install -g @opencodehub/cli

# or run without installing
npx @opencodehub/cli --help
```

Then bootstrap any repo:

```bash
cd /path/to/your/repo
codehub init      # writes .mcp.json, Claude Code plugin, .gitignore entry
codehub analyze   # index the repo
codehub mcp       # start the stdio MCP server (your agent calls this)
```

The `codehub` command-line front end. Every subcommand lazy-loads its
implementation so `codehub --help` stays fast — no DuckDB binding, no
pipeline, no MCP SDK is initialised until the matching action runs
(`packages/cli/src/index.ts:1-13`).

## Surface

```bash
codehub <command> [options]
```

- The CLI binary is the only OpenCodeHub-distributed UX. There is no
  daemon, no hosted service, and no second transport — agents talk to
  OpenCodeHub through the stdio MCP server launched by `codehub mcp`.
- Errors print as `codehub: <message>` and set exit code 1
  (`packages/cli/src/index.ts:860-864`).

## Commands

Registered in `packages/cli/src/index.ts:14-737`. The table groups the 25
top-level subcommands by phase of the workflow.

| Command            | Purpose                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| `init`             | Bootstrap a repo: `.claude/`, `.mcp.json`, `.gitignore`, policy seed       |
| `setup`            | Write MCP config for editors, fetch embedder weights, install SCIP tools  |
| `analyze`          | Run the 31-phase ingestion pipeline against a repo                         |
| `index`            | Register an existing `.codehub/` folder without re-analysing               |
| `status`           | Show registry metadata + index freshness for a repo                        |
| `list`             | Enumerate every repo registered on this machine                            |
| `clean`            | Delete one or all registered indexes                                       |
| `mcp`              | Launch the stdio MCP server                                                |
| `query`            | Hybrid BM25 + vector search against a repo's graph                         |
| `context`          | 360-degree view of a symbol — callers, callees, flows                      |
| `impact`           | Blast-radius traversal up/down/both with risk tier                         |
| `detect-changes`   | Map an uncommitted or committed diff onto affected symbols + processes     |
| `verdict`          | 5-tier PR decision (`auto_merge`/`single_review`/.../`block`)              |
| `scan`             | Run Priority-1 scanners and ingest findings into the graph                 |
| `ingest-sarif`     | Ingest an external SARIF 2.1.0 log into the graph                          |
| `pack`             | Single-file LLM snapshot via repomix (AST-compressed)                      |
| `code-pack`        | Deterministic 9-item BOM under `.codehub/packs/<packHash>/`                |
| `wiki`             | Emit a Markdown wiki tree (deterministic, optionally LLM-narrated)         |
| `bench`            | Run the acceptance gate suite and render a pass/fail dashboard             |
| `doctor`           | Probe the local environment and print actionable hints                     |
| `ci-init`          | Emit GitHub Actions / GitLab CI workflow scaffolds                         |
| `augment`          | Fast-path BM25 enrichment for editor PreToolUse hooks                      |
| `sql`              | Read-only SQL against the temporal store (cochanges + symbol_summaries)    |
| `group <sub>`      | Cross-repo groups: `create`, `list`, `delete`, `status`, `query`, `sync`   |

## Design

- **Lazy loading** — each `.action()` does `await import(...)` so cold
  startup is bounded by Commander, not the store or the parse pool
  (`packages/cli/src/index.ts:78-81`).
- **No stateful daemon** — `analyze` runs to completion and exits;
  `mcp` is the only long-running process.
- **Registry on disk** — `~/.codehub/registry.json` enumerates indexed
  repos; per-repo state lives under `<repo>/.codehub/`
  (`packages/cli/src/registry.ts`).
- **Env-toggle defaults** — env vars such as `CODEHUB_BEDROCK_DISABLED`
  flip behaviour without touching flags.
- **`mcp` is launched, never embedded** — agents that need the MCP
  surface spawn `codehub mcp` over stdio (`packages/cli/src/commands/mcp.ts`).

See ADR 0019 for the single-file `store.sqlite` storage layout and the
root README's "MCP tool surface" section for the agent-facing tool
inventory.

Storage is one `store.sqlite` file (WAL) via Node's built-in `node:sqlite`,
with zero native bindings (ADR 0019). Empty `keywords: []` round-trips as a
typed empty array distinct from an absent field — stored in the node's JSON
`payload` column — so `graphHash` byte-identity is preserved. Embeddings live
in the `embeddings` table (no Parquet sidecar).
