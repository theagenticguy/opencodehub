#!/usr/bin/env bash
# smoke-mcp.sh — boot the codehub MCP stdio server, send `initialize` +
# `tools/list`, and assert the server advertises the expected tool count.
#
# Uses only node (for the server) and python3 (for JSON parsing) — no extra
# dependencies. Safe to run in CI.
#
# Tool-count history:
#   MVP:    7 tools (list_repos, query, context, impact, detect_changes,
#                    rename, sql)
#   +W2-D.2:  group_list, group_query, group_status
#   +W2-H7:   project_profile
#   +W2-D.3:  group_contracts
#   +W2-I5:   dependencies
#   +W2-I7:   license_audit
#   +W2-H3:   owners
#   +W2-I2:   list_findings
#   +W2-I3:   scan
#   +W3-F.1:  verdict
#   +W3-F.2:  risk_trends
#   = 19 tools registered at v1.0.
#
# CI / acceptance.sh can override the assertion via the EXPECTED_TOOLS env var
# when the wire is mid-migration.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

CLI="$ROOT/packages/cli/dist/index.js"
if [ ! -f "$CLI" ]; then
  echo "smoke-mcp: CLI not built at $CLI; run \`pnpm -r build\` first." >&2
  exit 2
fi

REQ_INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.0"}}}'
REQ_INIT_NOTIF='{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
REQ_LIST='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# Perl provides `alarm()` on macOS where BSD `timeout(1)` is not in PATH.
run_with_timeout() {
  local secs="$1"; shift
  perl -e 'alarm shift; exec @ARGV' "$secs" "$@"
}

OUTPUT=$(printf '%s\n%s\n%s\n' "$REQ_INIT" "$REQ_INIT_NOTIF" "$REQ_LIST" \
  | run_with_timeout 15 node "$CLI" mcp 2>/dev/null || true)

COUNT=$(printf '%s' "$OUTPUT" | python3 -c '
import sys, json
tools = 0
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        obj = json.loads(line)
    except json.JSONDecodeError:
        continue
    if obj.get("id") == 2 and "result" in obj:
        tools = len(obj["result"].get("tools", []))
        break
print(tools)
')

EXPECTED_TOOLS="${EXPECTED_TOOLS:-19}"
if [ "$COUNT" = "$EXPECTED_TOOLS" ]; then
  echo "smoke-mcp: PASS ($COUNT tools listed)"
  exit 0
fi

echo "smoke-mcp: FAIL — expected $EXPECTED_TOOLS tools, got $COUNT" >&2
echo "--- raw server output ---" >&2
printf '%s\n' "$OUTPUT" >&2
echo "-------------------------" >&2
exit 1
