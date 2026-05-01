# @opencodehub/eval

Parity + regression eval harness for the OpenCodeHub MCP server.

- **98 core parametrized cases** (14 language fixtures × 7 core MCP tools:
  `list_repos`, `query`, `context`, `impact`, `detect_changes`, `rename`,
  `sql`) spawn the real `codehub mcp` stdio server via the official Python
  `mcp` SDK. `test_new_tool_case` layers coverage for the nine additional
  v1.0 tools (`owners`, `risk_trends`, `verdict`, `scan`, `list_findings`,
  `dependencies`, `license_audit`, `project_profile`, `group_query`) per
  `src/opencodehub_eval/tests/test_parametrized.py`.
- **14 clean-room OSS-style fixtures** under
  `src/opencodehub_eval/fixtures/{c,cpp,csharp,dart,go,java,js,kotlin,php,py,ruby,rust,swift,ts}/`
  — each is a tiny auth-service module (class + HTTP-ish entry + cross-file call).
- **Dashboard**: `uv run python -m opencodehub_eval.bench` prints the 15
  v1.0 acceptance gates with pass/fail/skip status. `bench.py` hard-codes
  a target of `98` core cases.
- **Pinned baseline**: `baselines/opencodehub-v1.json`.

## Usage

```bash
# 1. Build the TS monorepo first so the CLI entrypoint exists.
pnpm -r build

# 2. Install Python deps and run the parametrized cases.
cd packages/eval
uv sync
uv run pytest src/opencodehub_eval/tests/test_parametrized.py -q

# 3. Optional: dashboard view of the v1.0 acceptance gates.
uv run python -m opencodehub_eval.bench
```

See `scripts/acceptance.sh` at the repo root for the authoritative
v1.0 Definition-of-Done verifier (15 gates).
