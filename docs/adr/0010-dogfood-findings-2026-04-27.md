# ADR 0010 — Three dogfood findings from the 2026-04-27 multi-repo pass

- Status: accepted
- Date: 2026-04-27
- Authors: Laith Al-Saadoon + Claude
- Branch: `feat/artifact-factory`

## Context

After ADRs 0007 / 0008 / 0009 locked the artifact-factory scope and the
`codehub init` command shipped, we dogfooded the flow against a real
two-repo workspace — `AWSQuickWork` (98k nodes, 1.2 GB working tree) and
`AWSQuickWorkStrandsAIFunctions` (97 nodes, nearly empty scaffold). Three
issues surfaced that needed fixes on the same branch before the PR merges.

## Finding 1 — `--embeddings` with `--embeddings-workers 1` is a silent foot-gun

**Observation.** `codehub analyze --embeddings --embeddings-int8` on the
98k-node repo ran at 100% CPU for 56 minutes before we killed it. A
`sample` trace showed the process fully inside
`onnxruntime::ExecuteKernel` — one ONNX inference at a time, no
parallelism. Without `--embeddings`, the same repo indexed in 10 minutes.

**Root cause.** The flag defaulted to `1` worker (the legacy in-process
path). With ~100k nodes and per-node ONNX inference, that path scales
linearly; on an M-series Mac with 10 perf cores, the 10× parallelism
is a 10× wall-clock win. Users who don't know the flag exists pay the
full cost.

**Decision.** When `--embeddings` is passed and
`--embeddings-workers` is unset, the CLI now defaults workers to
`"auto"` (`os.cpus().length - 1`, min 1). Power users can still pass
`--embeddings-workers 1` for the legacy path.

**Scope.** CLI layer only. Programmatic `runAnalyze({embeddings: true})`
calls keep the original `undefined → pipeline picks its default` semantic
so library callers (tests, the eval harness) are unchanged.

**Evidence.** `packages/cli/src/index.ts` — the `--embeddings-workers`
option description and the parse path for the analyze command.

## Finding 2 — Dangling registry entries were invisible in `codehub list`

**Observation.** `AWSQuickWorkStrandsAIFunctions` was registered at
`/Users/lalsaado/workspaces/...` (note `workspaces` — a typo for the
real path `/Users/lalsaado/workplace/...`). `codehub list` happily
printed the row; any subsequent `group sync` / MCP lookup would silently
half-work.

**Decision.** `codehub list` now includes a `HEALTH` column per row,
with two failure cases:

- `⚠ missing path` — registry `path` does not exist on disk.
- `⚠ no graph.duckdb` — path exists but `<path>/.codehub/graph.duckdb`
  is missing (repo cleaned without `codehub clean`).

When any row is unhealthy, the command prints a trailing advisory:
`N of M entries need attention. Run 'codehub clean <path>' to remove a
dangling entry, or re-analyze a missing graph.`

Dogfood validation: on the real registry this surfaced `och-e3-smoke`
(path existed, graph was cleared) as `⚠ no graph.duckdb`.

**Evidence.** `packages/cli/src/commands/list.ts`.

## Finding 3 — Subagent prompts referenced a `path` column that doesn't exist on `nodes`

**Observation.** During Phase 0 precompute, a hand-written SQL of the
form `SELECT path FROM nodes WHERE kind='Route'` failed with
`Binder Error: Referenced column "path" not found`. The real shape: the
route endpoint is concatenated into `name` (as `"METHOD /path"`), the
file is `file_path`, and the method is `method`.

**Root cause.** The subagent prompts in 003–005 were drafted against the
mental model of a cypher-over-nodes schema that doesn't match the
actual DuckDB layout. Every one of the six `doc-*` subagents could
theoretically hit this; the tight SQL pattern in the scaffold makes it
easy to guess wrong column names.

**Decision.** Add a **schema preflight** step to Phase 0, documented in
`plugins/opencodehub/skills/codehub-document/references/data-source-map.md`:

> Before composing any SQL query over `nodes`, `relations`, or any other
> graph table, Phase 0 MUST probe the schema once and cache the result
> in `.prefetch.md`. Subagents consult the cached schema instead of
> guessing column names, which would fail with `Binder Error`.

The probe is one SQL call against `information_schema.columns`. The
Phase 0 algorithm in the reference doc is updated to reflect the new
step 2.

This is the minimum correct fix — an alternative (rewriting each
subagent's inline SQL to use the observed column names) would have
needed individual audit of six prompts against three graph states
(fresh, stale, partial). The preflight instead makes the schema a
first-class input to every subagent via the shared-context file, which
is the pattern the artifact factory already uses for every other
dependency.

**Evidence.** `plugins/opencodehub/skills/codehub-document/references/data-source-map.md`
§ Schema preflight + § Phase 0 algorithm (step 2 added).

## Consequences

**Positive.**

- `--embeddings` is no longer a wall-clock surprise for users who enable
  it without reading flag defaults. One decision, one line in the CLI.
- Every dangling registry entry becomes visible the next time the user
  runs `codehub list`. The health check uses zero extra state — it
  `stat()`s the entries already in the registry.
- The schema preflight stops a class of bug before it starts. Every
  subagent reads `.prefetch.md` first, so the schema is known once per
  run and reused.

**Negative.**

- The health check adds one `stat` syscall per registry entry. On a
  machine with < 100 registered repos, the cost is imperceptible; at
  much larger registries we'd batch or cache.
- The schema preflight adds one more Phase 0 tool call. It's a single
  `sql()` against `information_schema.columns` with a bounded response
  size, so the overhead vs the rest of Phase 0 is negligible.

**Neutral.**

- The `--embeddings-workers` help text now documents the default flip
  and dates the change. When a user reads `--help` and sees "auto" as
  the default, the reason is there.

## References

- `docs/adr/0007-artifact-factory.md` — parent decision
- `docs/adr/0008-codeprobe-pattern-port.md` — orchestration the preflight extends
- `docs/adr/0009-artifact-output-conventions.md` — Phase 0 contract
- `packages/cli/src/index.ts` — worker default flip
- `packages/cli/src/commands/list.ts` — registry health check
- `plugins/opencodehub/skills/codehub-document/references/data-source-map.md` — schema preflight

## Dogfood artifacts (for reviewers)

- `/Users/lalsaado/workplace/QuickWork/src/AWSQuickWork/.codehub/.context.md` — Phase 0 precompute that surfaced finding 3.
- `/Users/lalsaado/workplace/QuickWork/src/AWSQuickWork/.codehub/docs/architecture/system-overview.md` — simulated `doc-architecture` output.
- `/Users/lalsaado/workplace/QuickWork/src/AWSQuickWork/.codehub/groups/quickwork/contracts.md` — empty-case `codehub-contract-map` artifact (AC-5-5 path exercised).
- `~/.codehub/groups/quickwork/contracts.json` — 165 contracts from `codehub group sync`, all tagged `AWSQuickWork`.
