#!/usr/bin/env bash
# check-banned-strings.sh — clean-room guardrail.
#
# Rejects any tracked file (plus untracked, non-ignored files) that mentions a
# banned identifier from a prior-art project we deliberately do NOT copy from,
# OR a planning artifact (wave/stream code) that should have been scrubbed
# before publishing.
#
# A short allowlist of files may legitimately REFERENCE the banned names
# (this script itself, license allowlist analysis, etc.).

set -euo pipefail

# Literal strings we reject outright. Case-insensitive.
#
# The prior-backend names (`ladybug`, `kuzu`, `duckdb`, `lbug`) are NOT in
# this global list: ADR 0019 removed both native storage backends, and the
# names remain legitimate REMOVAL PROSE in end-user docs, ADRs, CHANGELOGs,
# and the public site ("ADR 0019 removed @ladybugdb/core and @duckdb/node-api").
# Banning them globally would corrupt correct historical documentation. They
# are instead hard-banned ONLY in live source (`packages/**/src`, excluding
# tests) via the SOURCE_BANNED_REGEX sweep below, and their dead on-disk
# artifact filenames are banned in the docs surface via DOC_STALE_LITERALS.
BANNED_LITERALS=(
  'STEP_IN_PROCESS'
  'heuristicLabel'
  'codeprobe'
  'STEP_IN_FLOW'
  'duckpgq'
)

# Regex patterns we reject. Extended POSIX (`git grep -E`); word-boundary
# anchors use explicit character classes rather than `\b` because Apple's
# macOS `git grep -E` does not support `\b` in extended-regex mode. The
# `(^|[^A-Za-z0-9_])` prefix is an equivalent left boundary; the
# `([^A-Za-z0-9_]|$)` suffix is the right boundary.
BANNED_REGEX=(
  # Wave-plan codes: W1-CORE, W2-A.2, W2-C.1, W2-E.4, W3-F.1, W3.B7, W5-2, etc.
  '(^|[^A-Za-z0-9_])W[0-9]+[-.][A-Z][A-Z0-9]*'
  # "Wave N" / "wave N" vocabulary (Wave 5, Wave 8c, wave-5, etc.).
  '(^|[^A-Za-z0-9_])[Ww]ave[ -]?[0-9]+([^A-Za-z0-9_]|$)'
  # "Stream X" references (Stream E, Stream J, Stream L, Stream T, Stream U...).
  '(^|[^A-Za-z0-9_])Stream [A-Z]([^A-Za-z0-9_]|$)'
  # The "(to be created in W2-B.2)"-style smoking-gun placeholder.
  'to be (created|implemented|added|wired|stubbed|filled)( in )? *W[0-9]'
)

# Pathspec exclusions — files allowed to legitimately mention banned names.
#
# `docs/adr/` is excluded because ADRs document architectural history and must
# be able to name vendored libraries and their upstream provenance in prose
# (e.g. an ADR recording the graph-db backend swap needs to cite the product
# name and its pre-fork lineage for future maintainers). The per-literal
# allowlist below still covers source / config manifests; this exclusion is
# scoped to architectural-history prose under `docs/adr/` only.
EXCLUDES=(
  ':(exclude)scripts/check-banned-strings.sh'
  ':(exclude)vendor'
  ':(exclude)pnpm-lock.yaml'
  ':(exclude).erpaval'
  ':(exclude)docs/adr'
)

fail=0

# Per-literal allowlist of tolerated substrings. Currently empty after the
# v1 removal of the `ladybug` literal (LadybugDB is now the default backend
# and a first-class product name in docs); kept as a hook for future
# situational allowlists.
#
# Returns a regex of tolerated substrings for the given literal, or empty. A
# line is only forgiven if EVERY banned-literal match on it is covered. This
# is a `case` function rather than an associative array (`declare -A`) so the
# script runs on stock macOS bash 3.2; add `LITERAL) printf '<regex>' ;;`
# arms here as future allowlists arise.
literal_allowlist_regex() {
  case "$1" in
    *) printf '' ;;
  esac
}

# Literal-string sweep (case-insensitive).
for pat in "${BANNED_LITERALS[@]}"; do
  if matches=$(git grep -I -n -i -e "$pat" --untracked -- "${EXCLUDES[@]}" 2>/dev/null); then
    allow="$(literal_allowlist_regex "$pat")"
    if [ -n "$allow" ]; then
      # Strip every allow-listed occurrence from each hit; if the line still
      # contains the banned literal, it's a real fail.
      filtered=$(printf '%s\n' "$matches" | while IFS= read -r line; do
        stripped=$(printf '%s' "$line" | sed -E "s#${allow}##g")
        if printf '%s' "$stripped" | grep -i -q -- "$pat"; then
          printf '%s\n' "$line"
        fi
      done)
      if [ -n "$filtered" ]; then
        echo "FAIL: banned literal '$pat' found:" >&2
        printf '%s\n' "$filtered" >&2
        fail=1
      fi
    else
      echo "FAIL: banned literal '$pat' found:" >&2
      printf '%s\n' "$matches" >&2
      fail=1
    fi
  fi
done

# Regex sweep (case-sensitive — wave codes are uppercase by convention).
for pat in "${BANNED_REGEX[@]}"; do
  if matches=$(git grep -I -n -E -e "$pat" --untracked -- "${EXCLUDES[@]}" 2>/dev/null); then
    echo "FAIL: banned pattern '$pat' found:" >&2
    printf '%s\n' "$matches" >&2
    fail=1
  fi
done

# Published-docs staleness sweep — scoped to the user-facing docs surface
# (the Starlight site, README, and the two generated agent-facing files).
# ADR 0019 replaced the lbug + DuckDB two-file store with a single
# `store.sqlite`, and the MCP surface is 29 tools. These literals are the
# unambiguous drift signals: the dead on-disk filenames, and the stale tool
# counts. Removal/supersession PROSE ("ADR 0019 removed @ladybugdb/core") is
# NOT banned — only the concrete dead artifacts and wrong numbers are. Scoped
# so architectural-history ADRs and internal planning notes stay free to name
# the old backend.
DOC_STALE_LITERALS=(
  'graph.lbug'         # dead on-disk graph file (was LadybugDB)
  'temporal.duckdb'    # dead on-disk temporal file (was DuckDB)
  '28 tools'           # stale MCP tool count (now 29)
  '30 tools'           # stale MCP tool count (now 29)
  '28 MCP tool'        # stale MCP tool count (now 29)
  '30 MCP tool'        # stale MCP tool count (now 29)
)
DOC_PATHSPEC=(
  'packages/docs/src'
  'packages/docs/public/tool-catalog.json'
  'packages/docs/astro.config.mjs'
  'README.md'
)
for pat in "${DOC_STALE_LITERALS[@]}"; do
  if matches=$(git grep -I -n -i -e "$pat" --untracked -- "${DOC_PATHSPEC[@]}" 2>/dev/null); then
    echo "FAIL: stale docs literal '$pat' found (ADR 0019 storage / 29-tool drift):" >&2
    printf '%s\n' "$matches" >&2
    fail=1
  fi
done

# ── Prior-backend names hard-banned in LIVE SOURCE ────────────────────────────
# ADR 0019 removed the two native storage backends. Their names must never
# reappear in shipping source code (only in removal prose / ADRs / CHANGELOGs).
# Scoped to `packages/**/src`, EXCLUDING `*.test.ts` — one test deliberately
# keeps the tokens: `sqlite-adapter.test.ts` asserts NO `.lbug`/`.duckdb`
# sidecar file is ever created, which is the regression guard that the removal
# stays removed. That assertion IS the enforcement, so its source is exempt.
SOURCE_BANNED_REGEX='duckdb|ladybug|lbug|kuzu'
SOURCE_PATHSPEC=(
  ':(glob)packages/*/src/**/*.ts'
  ':(exclude,glob)packages/*/src/**/*.test.ts'
  ':(exclude)packages/storage/src/test-utils'
)
if matches=$(git grep -I -n -i -E -e "$SOURCE_BANNED_REGEX" -- "${SOURCE_PATHSPEC[@]}" 2>/dev/null); then
  echo "FAIL: prior-backend name (duckdb/ladybug/lbug/kuzu) found in live source (ADR 0019 removed both backends — use 'store.sqlite' / 'the store'):" >&2
  printf '%s\n' "$matches" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "Banned-strings check failed." >&2
  exit 1
fi

echo "banned-strings check: PASS"
