# Run Biome standalone — the `mise run lint` precheck SIGTERMs in-sandbox

**Category:** test-failures · **Track:** bug
**Discovered:** session-3b8ca0 (CI `lint` failed on a PR that passed local typecheck+test)

## What happened

Local validation ran `tsc --noEmit` + the test suites directly and called the
PR green. CI's `lint` job failed in 22s. Cause: every `mise run <task>` depends
on an `install` task that runs `pnpm install`, which gets **SIGTERM'd under the
sandbox** — so `mise run lint` (and `check`, which includes lint) never
actually executes Biome locally. typecheck and test were run via direct `pnpm`
invocations, but Biome was simply never run.

Two classes of failure shipped to CI:
- `lint/suspicious/noConsole`: `console.log` is **off** in
  `packages/cli/src/commands/**` (biome.json override) but **warns** in
  `packages/cli/src/index.ts` (allows only `warn`/`error`). A `console.log`
  added to `index.ts` fails lint; the fix is to emit stdout from a
  command-module helper, not the CLI entrypoint.
- formatter line-wrapping nits Biome would rewrap.

## The rule

Before pushing, run Biome **standalone**, never via `mise`:

```bash
pnpm exec biome check .            # repo-wide, mirrors the CI lint job
pnpm exec biome check --write <files>   # auto-fix format + safe lint
```

The mise tasks (`lint`, `check`, `check:full`) all gate on the `install`
precheck that dies in-sandbox, so they are NOT a reliable local signal — invoke
the underlying tool directly (same lesson as running `tsc`/`node --test` via
`pnpm` instead of `mise run`). Generalizes: any mise task with
`depends = ["install"]` is unrunnable in-sandbox; reach for the underlying CLI.

## stdout/console map (cli)

`console.log` → only in `packages/cli/src/commands/**`. In `index.ts` and
elsewhere, only `console.warn` / `console.error` are allowed. Machine `--json`
output therefore belongs in a command module helper.
