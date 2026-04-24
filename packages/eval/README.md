# @opencodehub/eval

Parity + regression eval harness for the OpenCodeHub MCP server.

- **49 parametrized cases** (7 MVP languages × 7 MCP tools) spawn the real
  `codehub mcp` stdio server via the official Python `mcp` SDK.
- **7 clean-room OSS-style fixtures** under
  `src/opencodehub_eval/fixtures/{ts,js,py,go,rust,java,csharp}/` — each is
  a tiny auth-service module (class + HTTP-ish entry + cross-file call).
- **Dashboard**: `uv run python -m opencodehub_eval.bench` prints the 9
  MVP acceptance criteria with pass/fail/skip status.

## Usage

```bash
# 1. Build the TS monorepo first so the CLI entrypoint exists.
pnpm -r build

# 2. Install Python deps and run the parametrized cases.
cd packages/eval
uv sync
uv run pytest src/opencodehub_eval/tests/test_parametrized.py -q

# 3. Optional: dashboard view of all 9 MVP acceptance criteria.
uv run python -m opencodehub_eval.bench
```

See `scripts/acceptance.sh` at the repo root for the authoritative
MVP Definition-of-Done verifier.
