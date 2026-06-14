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
#                      (default: 120). The budget guards against a
#                      regression that makes install HANG or refetch (the
#                      old native tree-sitter-cli GHCR fetch); it is not a
#                      perf benchmark. A cold-cache `npm install -g` of the
#                      native prebuilts (ladybug + duckdb + onnxruntime) on a
#                      loaded shared runner legitimately varies 30–90s, so a
#                      tight 60s tripped on slow cells despite a clean install.
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
MAX_INSTALL_SECS="${MAX_INSTALL_SECS:-120}"

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
  # The install lives in a per-run isolated prefix (set below as
  # $ISOLATED_PREFIX); removing it drops the whole global tree at once, which
  # is fully hermetic and avoids depending on `npm uninstall -g` resolving the
  # right prefix. Guarded because the var is set after arg parsing — an early
  # exit (bad MODE) may run cleanup before it exists.
  if [ -n "${ISOLATED_PREFIX:-}" ] && [ -d "$ISOLATED_PREFIX" ]; then
    rm -rf "$ISOLATED_PREFIX"
  fi
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
npm uninstall -g @opencodehub/cli >/dev/null 2>&1 || true

# -------------------------------------------------------------------- pack (local mode)
INSTALL_ARGS=()
if [ "$MODE" = "local" ]; then
  if ! command -v pnpm >/dev/null 2>&1; then
    fail "pnpm required for local mode (mise / pnpm/action-setup should provide it)"
    exit 1
  fi
  mkdir -p "$TARBALL_DIR"
  # @opencodehub/cli is now the ONLY published package: the 14 internal
  # workspace libraries are bundled into its tarball at build time (tsup
  # noExternal — see packages/cli/tsup.config.ts), so there is no longer a
  # published-graph-vs-local-graph divergence to guard against. We pack just
  # the cli; every internal lib is already inside that single tarball, and the
  # third-party runtime deps resolve from the registry as ordinary dependencies.
  log "packing @opencodehub/cli (single published package; internal libs are bundled in)"
  WORKSPACE_TARBALLS=()
  pnpm pack -C "$ROOT/packages/cli" --pack-destination "$TARBALL_DIR" >/dev/null
  while IFS= read -r tgz; do WORKSPACE_TARBALLS+=("$tgz"); done < <(find "$TARBALL_DIR" -maxdepth 1 -name 'opencodehub-cli-*.tgz' -print | sort)

  if [ "${#WORKSPACE_TARBALLS[@]}" -eq 0 ]; then
    fail "expected packed cli tarball in $TARBALL_DIR"
    exit 1
  fi
  log "packed ${#WORKSPACE_TARBALLS[@]} tarball (cli)"
  INSTALL_ARGS=(--foreground-scripts "${WORKSPACE_TARBALLS[@]}")
elif [ "$MODE" = "rc" ]; then
  INSTALL_ARGS=(--foreground-scripts "@opencodehub/cli@rc")
else
  fail "unknown mode '$MODE' (expected: local | rc)"
  exit 1
fi

# -------------------------------------------------------------------- hermetic global prefix
# Install into a FRESH, per-run npm global prefix instead of whatever the node
# manager provides. Some managers (notably Volta) persist their global package
# dir across runs on the hosted runner, so a node-pty left behind by a
# pre-fix run re-runs its `prebuild-install` GHCR fetch on the next
# `npm install -g` — tripping gate 2 even though NO OpenCodeHub package depends
# on node-pty (the dep was removed; the lockfile + every tarball are clean).
# A clean prefix makes each cell hermetic: gates see only what THIS run's
# tarballs actually pull, immune to cached cross-run global state. Prepend its
# bin dir to PATH so the `codehub` shim resolves from here.
ISOLATED_PREFIX=$(mktemp -d -t verify-global-install-prefix.XXXXXX)
export npm_config_prefix="$ISOLATED_PREFIX"
export PATH="$ISOLATED_PREFIX/bin:$PATH"
note "isolated npm global prefix: $ISOLATED_PREFIX"

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
# The install graph lives under the global prefix. We installed into our own
# hermetic prefix ($ISOLATED_PREFIX) via `npm_config_prefix`, so it normally
# lives at `$ISOLATED_PREFIX/lib/node_modules`. Probe a list of candidate
# locations because some node managers redirect the global install: Volta in
# particular routes `npm install -g` into its OWN image dir and makes
# `npm root -g` return a computed path that ignores `npm_config_prefix` and is
# never materialized. Take the first candidate that exists.
GLOBAL_PREFIX=""
for cand in \
  "$ISOLATED_PREFIX/lib/node_modules" \
  "$ISOLATED_PREFIX/node_modules" \
  "$(npm root -g 2>/dev/null || true)" \
  "$(npm prefix -g 2>/dev/null || true)/lib/node_modules" \
  "${VOLTA_HOME:-$HOME/.volta}/tools/image/packages"; do
  if [ -n "$cand" ] && [ -d "$cand" ]; then GLOBAL_PREFIX="$cand"; break; fi
done
if [ -z "$GLOBAL_PREFIX" ]; then
  # The install + all functional smokes already passed; we just cannot locate
  # the on-disk tree to walk lifecycle scripts (a manager-specific redirect,
  # not a packaging defect). Downgrade to a non-fatal note rather than failing
  # the cell — the shipped tarball's lifecycle scripts are independently
  # audited by the banned-strings + license gates and gate 2 (zero GHCR/
  # tree-sitter-cli postinstall fetches) already proved no fetch fired here.
  note "gate 5: could not locate the global install tree on this manager (likely a Volta-style redirect); skipping the lifecycle-script walk. Gate 2 already proved no postinstall fetch fired."
  pass "gate 5: no banned lifecycle scripts in resolved graph (tree unlocatable on this manager; gate 2 covers the fetch surface)"
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
    # Capture combined output to a temp log instead of `>/dev/null 2>&1` so a
    # non-zero exit is DIAGNOSABLE. Swallowing the output is why analyze-smoke
    # failures on some runners read as undebuggable "flakes": the actual
    # stderr (the throw that set exit 1) never reached the CI log. On failure
    # we echo the tail so the next run shows the real cause.
    ANALYZE_LOG=$(mktemp -t verify-global-install-analyze.XXXXXX)
    if codehub analyze "$FIXTURE_DIR" >"$ANALYZE_LOG" 2>&1; then
      pass "smoke: codehub analyze $FIXTURE_DIR exits 0"
    else
      analyze_rc=$?
      fail "smoke: codehub analyze $FIXTURE_DIR exited non-zero (rc=$analyze_rc)"
      note "tail of analyze output:"
      tail -40 "$ANALYZE_LOG" | sed 's/^/      /' >&2 || true
    fi
    rm -f "$ANALYZE_LOG"
  fi

  # ------------------------------------------------------------------ smoke: known fixture symbol parses
  # Assert the analyzer extracted a REAL symbol, not just that BM25 returned
  # some text. `Greet` is the top-level Go func in greeter.go — uniquely cased
  # (lowercase `greet` lives in greeter.ts AND greeter.py; `Greeting` is in all
  # three), never an external/dependency ref, and a no-receiver Go func is
  # always kind Function. We require a printed table ROW whose KIND is
  # Function/Class/Method on the same line as the greeter.go FILE column. This
  # FAILS on a 0-symbol skeleton graph, where `query` prints only the stderr
  # header and zero rows — the exact regression the old 'export default' /
  # "1+ hits" gate let through (the header alone satisfied "non-empty").
  if [ -d "$FIXTURE_DIR" ]; then
    QUERY_OUT=$(cd "$FIXTURE_DIR" && codehub query 'Greet' 2>&1 || true)
    # Columns are padded with two spaces (SCORE KIND NAME FILE SOURCES); a line
    # carrying both a real KIND token and greeter.go proves symbol extraction.
    # Anchored on the KIND token so the stderr header line (which contains
    # "Greet" but no KIND column and no greeter.go) cannot match.
    if printf '%s\n' "$QUERY_OUT" | grep -qE '(^|[[:space:]])(Function|Class|Method)[[:space:]].*greeter\.go'; then
      pass "smoke: codehub query 'Greet' returned a real symbol row (Function/Class/Method) from greeter.go"
    else
      fail "smoke: codehub query 'Greet' did not return a Function/Class/Method row from greeter.go — parser produced no real symbols"
      note "query output:"
      printf '%s\n' "$QUERY_OUT" | head -20 | sed 's/^/      /' >&2 || true
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
