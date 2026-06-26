# SPECS.md — OpenCodeHub Baseline Requirements (EARS)

## What this system is

OpenCodeHub is an Apache-2.0, local-first code-intelligence toolchain for AI
coding agents. It ingests a source tree into a hybrid knowledge graph
(structural relations + semantic vectors) stored as a two-tier split — an
lbug graph (`@ladybugdb/core`, `graph.lbug`) plus a DuckDB temporal sibling
(`temporal.duckdb`), both under `<repo>/.codehub/` (ADR 0016) — and exposes
that graph over the Model Context Protocol and a `codehub` CLI. Agents use
it to answer "what breaks if I change this, what depends on it, where does
this data flow" *before* they produce a diff.

At ingestion time the system parses 15 GA languages via `web-tree-sitter`
(WASM) — the only parse runtime, with no native opt-in (ADR 0015) — for the
first 14 plus a regex provider for fixed-format COBOL, runs SCIP indexers
for TypeScript/JavaScript, Python, Go, Rust, and Java to upgrade tree-sitter
heuristic edges to compiler-grade edges, clusters the graph into
Communities and Processes, and optionally populates embeddings from a
pinned F2LLM-v2-80M ONNX model (320-dim; fp32 ~321 MB or int8 ~81 MB) or
an OpenAI-compatible HTTP endpoint.

At query time it exposes an MCP server with 28 tools (`query`, `context`,
`impact`, `signature`, `detect_changes`, `sql`, scanner /
finding / dependency / verdict / route tools, and cross-repo `group_*`
tools), along with a CLI that mirrors the main tools plus administrative
commands (`analyze`, `setup`, `doctor`, `ci-init`, `wiki`, etc.). The MCP
surface is read-only with respect to user source: no tool edits the
working tree.

## What this system is not

- Not a language server. It runs SCIP indexers as one-shot artifact
  producers and does not speak LSP to editors directly.
- Not a SaaS. There is no server to operate; the graph lives as two
  embedded files under `<repo>/.codehub/` (the lbug `graph.lbug` plus the
  DuckDB `temporal.duckdb`).
- Not a hosted vector DB. Embeddings are optional and local; there is no
  network dependency for analyze or query.
- Not a ranking / recommendation product. The graph is precomputed at index
  time; MCP tool responses are deterministic given the same graph.

---

## 1. Ingestion pipeline

1.1 The ingestion pipeline shall execute the default phase DAG
(`scan → profile → structure → markdown → parse → incremental-scope →
complexity → routes → openapi → tools → orm → cross-file → accesses →
mro → communities → dead-code → ownership → processes → fetches →
temporal → cochange → dependencies → sbom → annotate → risk-snapshot →
scip-index → confidence-demote → summarize → embeddings`) in
topological order.

1.2 When two analyze runs execute against identical input, the system shall
produce a byte-identical `graphHash` across runs.

1.3 When `codehub analyze --offline` is invoked, the system shall open zero
network sockets for the entire run.

1.4 The ingestion pipeline shall emit a single `ProjectProfile` node per
repo carrying detected `languages`, `iacTypes`, and `apiContracts`.

1.5 Where `--sbom` is included, the system shall write
`.codehub/sbom.cyclonedx.json` and `.codehub/sbom.spdx.json` derived from
`Dependency` nodes.

1.6 Where `--summaries` is included and `options.maxSummariesPerRun > 0`,
the summarize phase shall call the configured Bedrock model (default
`global.anthropic.claude-haiku-4-5-20251001-v1:0`) with structured tool
output validated by `SymbolSummary.safeParse`.

1.7 If `--offline` is set, then the summarize and embedder-HTTP phases
shall be hard no-ops regardless of other flags.

1.8 When the SCIP indexer for a language is not on PATH or fails, the
system shall continue ingestion with tree-sitter-only edges and attach
provenance indicating the oracle was unavailable.

1.9 While the `confidence-demote` phase runs, the system shall demote
confidence-0.5 heuristic CALLS/REFERENCES/EXTENDS edges whose
`(from, type, to)` triple is also present as a confidence-1.0 SCIP edge
to confidence 0.2 with a `+scip-unconfirmed` reason suffix.

1.10 Where `--skills` is included, the system shall emit one
`SKILL.md` per `Community` with `symbolCount >= 5` under
`.codehub/skills/`.

1.11 The ingestion pipeline shall support an incremental / carry-forward
mode triggered by the content cache when `--force` is not set; unchanged
files reuse prior extraction output.

---

## 2. Language coverage

2.1 The system shall provide `web-tree-sitter` (WASM) extractors for
TypeScript, JavaScript (incl. TSX/JSX), Python, Go, Rust, Java, C#, C, C++,
Ruby, Kotlin, Swift, PHP, and Dart, plus a regex provider for fixed-format
COBOL — 15 GA languages in total.

2.2 The system shall run `web-tree-sitter` (WASM) as the only parse runtime
on Node 20, 22, and 24; there is no native opt-in (ADR 0015). All 15
grammar `.wasm` blobs are vendored at `packages/ingestion/vendor/wasms/`.

2.3 Adding a new language shall require: registering a grammar dependency,
implementing the `LanguageProvider` interface, and registering the
provider in `packages/ingestion/src/providers/registry.ts`; a missing
registration shall fail the TypeScript build.

2.4 Where TypeScript, JavaScript, Python, Go, Rust, or Java is
detected, the system shall run the `scip-index` phase which invokes
the matching SCIP indexer (scip-typescript, scip-python, scip-go,
`rust-analyzer scip`, or scip-java), parses the resulting `.scip`
protobuf, and emits `CodeRelation` edges with confidence 1.0 and
`reason = "scip:<indexer>@<version>"`.

2.5 When a SCIP indexer that runs workspace build scripts
(`rust-analyzer scip`, `scip-java`) is invoked, the system shall
require the operator to opt in via
`CODEHUB_ALLOW_BUILD_SCRIPTS=1` unless already enabled in
`codehub.config`.

2.6 Cross-language references (e.g. JNI, wasm-bindgen) are
out of scope for `scip-index`; each language's `.scip` file is loaded
independently and joined on shared symbol strings only when the
indexers agree on `package{manager,name,version}`.

---

## 3. Storage & schema

3.1 The system shall persist the graph tier to an lbug graph file
(`graph.lbug`, `@ladybugdb/core`) and the temporal tier — cochanges and
structured symbol summaries — to a DuckDB file (`temporal.duckdb`), both
under `<repo>/.codehub/`. Both files are written on every analyze; there is
no `CODEHUB_STORE` env var, no backend probe, and no single-file DuckDB
graph layout (ADR 0016).

3.2 The storage layer shall segregate `IGraphStore` (graph workload: nodes,
edges, embeddings, multi-hop traversal) from `ITemporalStore` (cochanges,
summary cache). `IGraphStore` lives only on `GraphDbStore`; `DuckDbStore`
implements `ITemporalStore` only; `openStore()` composes them. The
segregated interfaces are the v1.0 contract for community-fork adapters
(AGE / Memgraph / Neo4j / Neptune target `IGraphStore`). If the lbug
binding fails to load, `open()` throws `GraphDbBindingError`.

3.3 While executing the `sql` MCP tool or `codehub sql` CLI, the system
shall reject non-read-only statements and apply a 5-second default timeout.
The `sql` path targets the DuckDB temporal store (`cochanges` +
`symbol_summaries`); the node/edge graph is queried via the typed tools or
via Cypher (the `sql` tool's `cypher` argument), not this SQL path.

3.4 The vector search path shall use the lbug graph's filter-aware
nearest-neighbour traversal when embeddings are populated.

3.5 The full-text search path shall use BM25 scoring over the indexed
symbols.

3.6 Multi-hop graph traversal shall be expressed in the lbug graph's Cypher
dialect rather than recursive SQL CTEs.

3.7 The storage layer shall write metadata (schema version, graph hash,
last-analyzed commit) atomically and expose it via `getMeta`.

---

## 4. Search & retrieval

4.1 When a `query` request arrives, the system shall execute a hybrid
BM25 + ANN search, fuse results with reciprocal rank fusion (`DEFAULT_RRF_K`),
and return symbols grouped by their participating `Process`.

4.2 Where F2LLM-v2-80M weights are absent and no HTTP embedder is
configured, the system shall fall back to BM25-only search and log a
one-shot `[mcp] hybrid:` warning to stderr.

4.3 The `query` handler shall accept an optional `--context` and `--goal`
pair that the ranker prepends to the query text.

4.4 When `--content` is set, the CLI `query` shall attach each hit's
source text capped at 2000 characters.

4.5 The `group_query` MCP tool shall fan out BM25 across every repo in
the named group, fuse with RRF, and never abort the whole call if a
single repo errors — per-repo errors must surface in
`per_repo[].error` and `warnings[]`.

---

## 5. Impact, diff, verdict

5.1 When `impact` is invoked, the system shall traverse CALLS / REFERENCES
/ EXTENDS / METHOD_* / IMPLEMENTS / ACCESSES edges from the target up to
`depth` (default 3) in the requested direction (`up`, `down`, `both`) and
return depth buckets, affected modules, affected processes, a confidence
breakdown, and a risk tier (`LOW` / `MEDIUM` / `HIGH` / `CRITICAL`).

5.2 When `detect_changes` is invoked with a git diff, the system shall map
changed hunks to `AffectedSymbol`, `AffectedModule`, and
`AffectedProcess` records with line-range precision.

5.3 When `verdict` is invoked, the system shall classify a diff into one
of five tiers (`auto_merge`, `single_review`, `dual_review`,
`expert_review`, `block`) with structured reasoning signals and
recommended reviewers.

5.4 The CLI `verdict` command shall set `process.exitCode` to 0 for
merge-safe tiers, 1 for review-required tiers, and 2 for `block`.

---

## 6. MCP server surface

6.1 The MCP server shall advertise itself as `opencodehub` over stdio with
an `instructions` block steering clients to call `list_repos` first.

6.2 The server shall register 28 tools: `list_repos`, `query`, `context`,
`impact`, `signature`, `detect_changes`, `sql`, `group_list`,
`group_query`, `group_status`, `group_contracts`, `group_cross_repo_links`,
`group_sync`, `project_profile`, `dependencies`, `license_audit`, `owners`,
`list_findings`, `list_findings_delta`, `list_dead_code`,
`scan`, `verdict`, `risk_trends`, `route_map`,
`api_impact`, `shape_check`, `tool_map`, and `pack_codebase`. No registered
tool mutates user source files; the MCP surface is read-only with respect
to the working tree.

6.3 Every per-repo tool shall accept an optional `repo` argument; when
exactly one repo is registered, `repo` shall default to that repo; when
two or more are registered and `repo` is omitted, the tool shall return
`AMBIGUOUS_REPO`.

6.4 Every tool response shall include a `next_steps` array under
`structuredContent`.

6.5 When the index lags HEAD, every tool response shall include a
`_meta["codehub/staleness"]` envelope.

6.6 The server shall register resources `codehub://repos`,
`codehub://repo-context`, `codehub://repo-schema`,
`codehub://repo-clusters`, `codehub://repo-cluster`,
`codehub://repo-processes`, and `codehub://repo-process`.

6.7 On SIGINT, SIGTERM, or stdin close, the server shall drain the
connection pool before exiting.

6.8 If the `sql` tool receives a write-class statement, then the server
shall reject it with `SqlGuardError`.

---

## 7. CLI surface

7.1 The `codehub` CLI shall expose the subcommands: `analyze`, `index`,
`setup`, `mcp`, `list`, `status`, `clean`, `query`, `context`, `impact`,
`verdict`, `group (create|list|delete|status|query|sync)`,
`ingest-sarif`, `scan`, `doctor`, `bench`, `wiki`, `ci-init`, `augment`,
and `sql`.

7.2 The CLI shall lazy-load every subcommand via `await import(...)` so
`codehub --help` does not transitively load DuckDB or tree-sitter.

7.3 The `setup` command shall write MCP configuration stanzas for
claude-code, cursor, codex, windsurf, and opencode; pass `--undo` to
restore the most recent `.bak`.

7.4 The `setup --embeddings` command shall download the F2LLM-v2-80M
ONNX export (fp32 or int8) — a custom-exported artifact hosted as a
GitHub release asset — with SHA256 pins validated against
`model-pins.ts`.

7.5 The `setup --plugin` command shall copy the bundled plugin into
`~/.claude/plugins/opencodehub/`.

7.6 The `doctor` command shall probe node, pnpm, native bindings,
scanners, and the registry, and shall print actionable hints.

7.7 When run from a git repository without a prior index, `codehub
status` shall report staleness rather than error.

7.8 The `augment` command shall return a compact BM25 enrichment block on
stderr for editor PreToolUse hook integration.

---

## 8. Scanners & findings

8.1 The `scan` command shall invoke external scanners as subprocesses and
never link or vendor GPL / MPL / BUSL scanner source.

8.2 Where `hadolint`, `tflint`, or `clamav` binaries are missing, the
corresponding wrapper shall emit an empty SARIF log and a warning — never
crash.

8.3 The scanner catalog shall gate Priority-2 scanners by the
`ProjectProfile` (`iacTypes`, `apiContracts`, `languages`) unless the
user forces inclusion via `--with`.

8.4 The `scan` command shall exit 0 for a clean run, 1 for findings at or
above the severity threshold (default `HIGH,CRITICAL`), and 2 for
scanner-runtime failure.

8.5 The `ingest-sarif` command shall validate input against
`SarifLogSchema` and ingest findings as `Finding` nodes connected by
`FOUND_IN` edges.

8.6 The `list_findings_delta` MCP tool shall diff the latest scan against
a frozen baseline into `new` / `fixed` / `unchanged` / `updated`
buckets.

---

## 9. Cross-repo groups

9.1 The system shall persist named cross-repo groups under
`~/.codehub/groups/<name>/`.

9.2 When `group sync` is invoked, the system shall extract HTTP, gRPC,
and topic contracts for every repo in the group and write
`contracts.json` matching the `ContractRegistry` shape.

9.3 The `group_contracts` MCP tool shall return graph-backed
FETCHES↔Route cross-links together with the registry's signature-matched
contracts.

9.4 While `group_query` is executing, the system shall never abort the
fan-out on a single-repo failure.

---

## 10. Evaluation & quality gates

10.1 The retrieval / graph-quality evaluation harness and the per-language
F1 regression gym shall live in the sibling `opencodehub-testbed`
repository, not in this core repo's package set. The on-disk
`packages/eval/` directory carries no git-tracked files; any local
`.venv/`, `.pytest_cache/`, `.ruff_cache/`, or `src/` is untracked and
gitignored.

10.2 The evaluation harness in `opencodehub-testbed` shall run its case
matrix against the real `codehub mcp` stdio server, and the gym shall
replay SCIP indexer golden manifests gating on three layers: absolute F1
floor, relative F1 delta, and per-case non-regression. The full freeze /
replay manifest contract lives with the testbed.

10.3 `scripts/acceptance.sh` shall execute 15 named gates and exit
non-zero if any mandatory gate fails; soft gates (incremental p95,
scanner smoke without semgrep, embeddings determinism without weights)
may `SKIP` without changing the exit code.

10.4 `pnpm run check` shall run lint, typecheck, test, and banned-strings
in that order and shall fail on the first non-zero exit.

---

## 11. Supply chain & IP hygiene

11.1 The CI license job shall enforce the allowlist `Apache-2.0 / MIT /
BSD-2-Clause / BSD-3-Clause / ISC / CC0-1.0 / BlueOak-1.0.0 / 0BSD` on
every production transitive dependency.

11.2 The `check-banned-strings.sh` script shall reject tracked files that
mention banned prior-art identifiers or wave/stream planning codes
(`W<n>-...`, `Wave <n>`, `Stream <letter>`), with an explicit allowlist
for the script itself, `vendor/`, the lockfile, and `.erpaval/`.

11.3 CI shall run CodeQL on JavaScript/TypeScript and Python on every PR
and on a weekly schedule.

11.4 CI shall run OSV-Scanner on `pnpm-lock.yaml` on every PR and upload
SARIF.

11.5 Releases shall regenerate `SBOM.cdx.json` and `THIRD_PARTY_LICENSES.md`.

11.6 OpenSSF Scorecard shall run on branch-protection changes and
weekly.

11.7 If a dependency would introduce a copyleft or source-available
license, then the license CI job shall fail the PR.

---

## 12. Determinism & reproducibility

12.1 The `graphHash` emitted by analyze shall be a canonical-JSON SHA256
of the sorted node and edge sets.

12.2 A full analyze and an incremental analyze against the same commit
shall produce byte-identical `graphHash`.

12.3 All file writes that touch user-visible state (editor MCP configs,
SBOM, SARIF) shall use `write-file-atomic`.

12.4 The summarizer's Bedrock prompt shall contain a ≥ 4,096-token
cacheable prefix (Haiku 4.5 requirement) engaged via two `cachePoint`
blocks.

---

## 13. Environment & distribution

13.1 The repo shall declare Node `>= 22` and pnpm `>= 11` in
`package.json.engines` (with `packageManager` pinned to `pnpm@11.1.0`).

13.2 `mise.toml` shall pin `node = "22"`, `pnpm = "11.1.0"`, `python =
"3.12"`, and `uv = "latest"`; `mise install` shall be sufficient
bootstrap.

13.3 Lefthook shall wire `pre-commit` (biome + banned-strings),
`commit-msg` (commitlint), and `pre-push` (typecheck + test).

13.4 Commits on `main` shall follow Conventional Commits; a malformed
message shall be rejected locally by `commit-msg` and in CI by
`commitlint.yml`.

13.5 Release-please shall open a versioned release PR from the `main`
commit log; merging it cuts the tag, generates `CHANGELOG.md`, and
publishes the release.

---

## 14. Observability & error envelopes

14.1 Every MCP tool shall return a typed error envelope with an error code
(for example `AMBIGUOUS_REPO`, `NOT_FOUND`, `SqlGuardError`) and a
human-readable message.

14.2 The server shall never write non-protocol output to stdout — all
diagnostic text shall go to stderr so it does not corrupt the stdio
transport.

14.3 When the embedder weights probe fails, the server shall log a single
structured warning and continue with BM25-only search.
