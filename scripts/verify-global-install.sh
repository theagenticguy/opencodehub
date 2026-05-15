#!/usr/bin/env bash
# scripts/verify-global-install.sh — single-cell verifier for the
# bulletproof-npm-install matrix (planning/bulletproof-npm-install/plan.md
# §Verification Criteria).
#
# Runs ONE matrix cell — `npm install -g <tarball>` (or `@opencodehub/cli@rc`)
# in the current shell, applies the 5 hard gates, and runs the 4 smoke
# commands. The 9-cell fan-out is the responsibility of the caller —
# `.github/workflows/verify-global-install.yml` supplies one cell per
# matrix entry; a developer running this directly verifies their current
# environment.
#
# Usage:
#   bash scripts/verify-global-install.sh [local|rc]
#
# Modes:
#   local (default)  pack packages/ingestion + packages/cli with
#                    `pnpm pack`, install both tarballs globally with npm.
#   rc               install `@opencodehub/cli@rc` from the public registry.
#                    Used by post-publish smoke jobs; no packing happens.
#
# Environment:
#   INSTALLER     informational label printed in the summary
#                 (mise|nvm|homebrew|volta — the workflow sets this).
#   TARBALL_DIR   where to drop packed tarballs in local mode
#                 (default: /tmp/opencodehub-tarballs).
#   FIXTURE_DIR   path passed to `codehub analyze` (default:
#                 tests/fixtures/multi-lang).
#   MAX_INSTALL_SECS   hard upper bound on install wall time
#                      (default: 60).
#
# Exit codes:
#   0  every gate passed
#   1  one or more gates failed (details in the per-gate PASS/FAIL log)
#
# Idempotent: cleans the global install on entry and on EXIT.
#
# This script does NOT publish anything. RC mode assumes the tag already
# exists. Publishing remains release-please's job.

set -euo pipefail

MODE="${1:-local}"
INSTALLER="${INSTALLER:-unknown}"
TARBALL_DIR="${TARBALL_DIR:-/tmp/opencodehub-tarballs}"
FIXTURE_DIR="${FIXTURE_DIR:-tests/fixtures/multi-lang}"
MAX_INSTALL_SECS="${MAX_INSTALL_SECS:-60}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PASS_COUNT=0
FAIL_COUNT=0
SUMMARY=()

# -------------------------------------------------------------------- log helpers
log()  { printf '[verify-global-install] %s\n' "$*"; }
pass() { PASS_COUNT=$((PASS_COUNT + 1)); SUMMARY+=("[PASS] $1"); printf '  [PASS] %s\n' "$1"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); SUMMARY+=("[FAIL] $1"); printf '  [FAIL] %s\n' "$1" >&2; }
note() { printf '  ...... %s\n' "$1"; }

# -------------------------------------------------------------------- cleanup
# shellcheck disable=SC2329  # invoked indirectly via the EXIT trap below.
cleanup() {
  # Drop the global install we created so re-runs are idempotent. Errors
  # are tolerated — the install may have failed before the binary landed.
  npm uninstall -g @opencodehub/cli @opencodehub/ingestion >/dev/null 2>&1 || true
  if [ "$MODE" = "local" ] && [ -d "$TARBALL_DIR" ]; then
    rm -rf "$TARBALL_DIR"
  fi
}
trap cleanup EXIT

# -------------------------------------------------------------------- preflight
log "mode=$MODE installer=$INSTALLER node=$(node --version 2>/dev/null || echo missing) npm=$(npm --version 2>/dev/null || echo missing)"
log "fixture=$FIXTURE_DIR root=$ROOT"

if ! command -v npm >/dev/null 2>&1; then
  fail "npm is not on PATH"
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  fail "node is not on PATH"
  exit 1
fi

# Fresh slate before install — strip any residual global package.
npm uninstall -g @opencodehub/cli @opencodehub/ingestion >/dev/null 2>&1 || true

# -------------------------------------------------------------------- pack (local mode)
INSTALL_ARGS=()
if [ "$MODE" = "local" ]; then
  if ! command -v pnpm >/dev/null 2>&1; then
    fail "pnpm required for local mode (mise / pnpm/action-setup should provide it)"
    exit 1
  fi
  mkdir -p "$TARBALL_DIR"
  log "packing all publishable @opencodehub/* workspace packages into $TARBALL_DIR"
  # Pack every non-private workspace package so npm doesn't fall back to
  # registry versions for transitive workspace deps. The CLI depends on
  # @opencodehub/pack which depends on @opencodehub/ingestion etc — if
  # only cli + ingestion ship locally, npm pulls older pack@<published>
  # which pins an older ingestion@<published>, which still drags native
  # tree-sitter and breaks the install. Local-mode must mirror what
  # release-please publishes simultaneously.
  WORKSPACE_TARBALLS=()
  while IFS= read -r pj; do
    is_private=$(node -e "process.stdout.write(String(JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8')).private||false))" "$pj")
    if [ "$is_private" = "true" ]; then continue; fi
    pkg_dir=$(dirname "$pj")
    pnpm pack -C "$pkg_dir" --pack-destination "$TARBALL_DIR" >/dev/null
  done < <(find "$ROOT/packages" -maxdepth 2 -name package.json)

  # Order matters: install ingestion + every package that depends on it
  # before cli, so the cli's workspace deps resolve to the local tarballs.
  while IFS= read -r tgz; do WORKSPACE_TARBALLS+=("$tgz"); done < <(find "$TARBALL_DIR" -maxdepth 1 -name 'opencodehub-*.tgz' -print | sort)

  if [ "${#WORKSPACE_TARBALLS[@]}" -eq 0 ]; then
    fail "expected packed tarballs in $TARBALL_DIR"
    exit 1
  fi
  log "packed ${#WORKSPACE_TARBALLS[@]} workspace tarballs"
  INSTALL_ARGS=(--foreground-scripts "${WORKSPACE_TARBALLS[@]}")
elif [ "$MODE" = "rc" ]; then
  INSTALL_ARGS=(--foreground-scripts "@opencodehub/cli@rc")
else
  fail "unknown mode '$MODE' (expected: local | rc)"
  exit 1
fi

# -------------------------------------------------------------------- install + capture
INSTALL_LOG=$(mktemp -t verify-global-install-log.XXXXXX)
log "running: npm install -g ${INSTALL_ARGS[*]}"

INSTALL_START=$(date +%s)
INSTALL_RC=0
# Capture both stdout + stderr (`2>&1`) so the gate greps see everything
# npm prints; the install itself runs unbuffered.
npm install -g "${INSTALL_ARGS[@]}" >"$INSTALL_LOG" 2>&1 || INSTALL_RC=$?
INSTALL_END=$(date +%s)
INSTALL_SECS=$((INSTALL_END - INSTALL_START))
note "install exit=$INSTALL_RC duration=${INSTALL_SECS}s"

# -------------------------------------------------------------------- gate 1: exit 0 + no npm ERR!
if [ "$INSTALL_RC" -eq 0 ]; then
  if grep -qE 'npm (ERR|error)!' "$INSTALL_LOG"; then
    fail "gate 1: install exited 0 but npm ERR! present in log"
    note "first 20 ERR lines:"
    grep -nE 'npm (ERR|error)!' "$INSTALL_LOG" | head -20 | sed 's/^/      /' >&2 || true
  else
    pass "gate 1: install exited 0, no npm ERR! lines"
  fi
else
  fail "gate 1: install exited $INSTALL_RC"
  note "tail of install log:"
  tail -30 "$INSTALL_LOG" | sed 's/^/      /' >&2 || true
fi

# -------------------------------------------------------------------- gate 2: zero GHCR / tree-sitter-cli postinstall fetches
if grep -iE 'github\.com.*releases|tree-sitter-cli' "$INSTALL_LOG" >/dev/null; then
  fail "gate 2: GHCR or tree-sitter-cli postinstall fetch detected"
  note "matching lines:"
  grep -niE 'github\.com.*releases|tree-sitter-cli' "$INSTALL_LOG" | head -10 | sed 's/^/      /' >&2 || true
else
  pass "gate 2: zero GHCR / tree-sitter-cli postinstall fetches"
fi

# -------------------------------------------------------------------- gate 3: zero ERESOLVE / peer-dep warnings
if grep -E 'ERESOLVE|peer dep' "$INSTALL_LOG" >/dev/null; then
  fail "gate 3: ERESOLVE / peer-dep warning present"
  note "matching lines:"
  grep -nE 'ERESOLVE|peer dep' "$INSTALL_LOG" | head -10 | sed 's/^/      /' >&2 || true
else
  pass "gate 3: zero ERESOLVE / peer-dep warnings"
fi

# -------------------------------------------------------------------- gate 4: install under MAX_INSTALL_SECS
if [ "$INSTALL_SECS" -le "$MAX_INSTALL_SECS" ]; then
  pass "gate 4: install completed in ${INSTALL_SECS}s (<= ${MAX_INSTALL_SECS}s)"
else
  fail "gate 4: install took ${INSTALL_SECS}s (> ${MAX_INSTALL_SECS}s budget)"
fi

# -------------------------------------------------------------------- gate 5: no banned lifecycle scripts in resolved graph
# The install graph lives under the global prefix. Walk every package.json
# under the @opencodehub/* trees and assert none ships wget/curl/download/
# node-gyp rebuild/prebuild-install in any lifecycle script.
GLOBAL_PREFIX=$(npm root -g 2>/dev/null || true)
if [ -z "$GLOBAL_PREFIX" ] || [ ! -d "$GLOBAL_PREFIX" ]; then
  fail "gate 5: could not resolve npm global prefix (got '$GLOBAL_PREFIX')"
else
  BANNED_RE='wget|curl|download|node-gyp rebuild|prebuild-install'
  BANNED_HITS=$(mktemp -t verify-global-install-banned.XXXXXX)
  # Look at the @opencodehub trees' package.json + every transitive dep
  # they pulled in. `npm ls -g --json` enumerates the resolved graph; we
  # walk those directories' package.json files for lifecycle scripts.
  RESOLVED_DIRS=$(node -e '
    const { execSync } = require("node:child_process");
    const out = execSync("npm ls -g --all --json", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const tree = JSON.parse(out);
    const dirs = new Set();
    function walk(n) {
      if (!n) return;
      if (n.path) dirs.add(n.path);
      const deps = n.dependencies || {};
      for (const k of Object.keys(deps)) walk(deps[k]);
    }
    walk(tree);
    process.stdout.write([...dirs].join("\n"));
  ' 2>/dev/null || true)

  if [ -z "$RESOLVED_DIRS" ]; then
    note "gate 5: npm ls -g produced no package list — falling back to filesystem walk"
    # Portable across GNU + BSD find. `dirname` runs once per match thanks
    # to `-exec ... \;`; the global tree is small (~1k pkgs at most), so
    # the fork cost is negligible.
    RESOLVED_DIRS=$(find "$GLOBAL_PREFIX" -maxdepth 4 -name package.json -exec dirname {} \; 2>/dev/null || true)
  fi

  while IFS= read -r dir; do
    [ -z "$dir" ] && continue
    pkg="$dir/package.json"
    [ -f "$pkg" ] || continue
    # Extract lifecycle scripts as JSON, scan with a single regex.
    # shellcheck disable=SC2016  # backticks/${...} inside JS template
    # literals are not shell interpolations — they're JS string parts.
    HIT=$(node -e '
      const fs = require("node:fs");
      const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const s = p.scripts || {};
      const hooks = ["preinstall", "install", "postinstall", "preuninstall", "uninstall", "postuninstall"];
      const out = [];
      for (const h of hooks) {
        if (typeof s[h] === "string" && /(wget|curl|download|node-gyp rebuild|prebuild-install)/.test(s[h])) {
          out.push(`${p.name}@${p.version}: ${h}=${s[h]}`);
        }
      }
      if (out.length) process.stdout.write(out.join("\n"));
    ' "$pkg" 2>/dev/null || true)
    if [ -n "$HIT" ]; then
      printf '%s\n' "$HIT" >> "$BANNED_HITS"
    fi
  done <<< "$RESOLVED_DIRS"

  if [ -s "$BANNED_HITS" ]; then
    fail "gate 5: banned lifecycle script(s) found in resolved graph"
    note "matches (regex: $BANNED_RE):"
    head -20 "$BANNED_HITS" | sed 's/^/      /' >&2 || true
  else
    pass "gate 5: no banned lifecycle scripts in resolved graph"
  fi
  rm -f "$BANNED_HITS"
fi

# -------------------------------------------------------------------- early exit if install itself failed
# Smoke commands depend on a working binary; when install failed the
# `codehub` shim is missing and every smoke check would just compound the
# original failure. Skip them with a clear note instead.
if [ "$INSTALL_RC" -ne 0 ]; then
  note "skipping smoke commands — install failed"
else
  # ------------------------------------------------------------------ smoke: codehub --version
  if codehub --version >/dev/null 2>&1; then
    pass "smoke: codehub --version exits 0"
  else
    fail "smoke: codehub --version exited non-zero"
  fi

  # ------------------------------------------------------------------ smoke: codehub --help
  if codehub --help >/dev/null 2>&1; then
    pass "smoke: codehub --help exits 0"
  else
    fail "smoke: codehub --help exited non-zero"
  fi

  # ------------------------------------------------------------------ smoke: codehub analyze <fixture>
  if [ ! -d "$FIXTURE_DIR" ]; then
    fail "smoke: fixture directory '$FIXTURE_DIR' missing"
  else
    if codehub analyze "$FIXTURE_DIR" >/dev/null 2>&1; then
      pass "smoke: codehub analyze $FIXTURE_DIR exits 0"
    else
      fail "smoke: codehub analyze $FIXTURE_DIR exited non-zero"
    fi
  fi

  # ------------------------------------------------------------------ smoke: codehub query 'export default'
  # The query phase exits 0 even on zero hits, so the gate is "1+ hits".
  if [ -d "$FIXTURE_DIR" ]; then
    QUERY_OUT=$(cd "$FIXTURE_DIR" && codehub query 'export default' 2>&1 || true)
    if printf '%s' "$QUERY_OUT" | grep -qiE 'no results|0 results|0 hits|no matches'; then
      fail "smoke: codehub query 'export default' returned no hits"
    elif [ -n "$QUERY_OUT" ]; then
      pass "smoke: codehub query 'export default' returned at least one hit"
    else
      fail "smoke: codehub query 'export default' returned empty output"
    fi
  fi
fi

# -------------------------------------------------------------------- summary
echo
echo "=== verify-global-install summary (mode=$MODE installer=$INSTALLER) ==="
for line in "${SUMMARY[@]}"; do
  printf '  %s\n' "$line"
done
echo "  passed=$PASS_COUNT failed=$FAIL_COUNT"
echo "  install_log=$INSTALL_LOG"
echo

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
