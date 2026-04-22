#!/usr/bin/env bash
# check-banned-strings.sh — clean-room guardrail.
#
# Rejects any tracked file (plus untracked, non-ignored files) that mentions a
# banned identifier from a prior-art project we deliberately do NOT copy from.
# A short allowlist of files may legitimately REFERENCE the banned names
# (provenance record, license allowlist analysis, this script itself, etc.).

set -euo pipefail

BANNED_PATTERNS=(
  'gitnexus'
  'STEP_IN_PROCESS'
  'heuristicLabel'
  'codeprobe'
  'STEP_IN_FLOW'
  'kuzu'
  'ladybug'
  'duckpgq'
)

# Pathspec exclusions — files allowed to legitimately mention banned identifiers.
EXCLUDES=(
  ':(exclude)scripts/check-banned-strings.sh'
  ':(exclude)vendor'
  ':(exclude)pnpm-lock.yaml'
)

fail=0
for pat in "${BANNED_PATTERNS[@]}"; do
  # `git grep -I` skips binaries, `-n` shows line numbers, `-i` is case-insensitive,
  # `-l` keeps output terse. `--untracked` catches files not yet `git add`-ed.
  # Exit status: 0 = match found (bad), 1 = no match (good), >1 = error.
  if matches=$(git grep -I -n -i -e "$pat" --untracked -- "${EXCLUDES[@]}" 2>/dev/null); then
    echo "FAIL: banned pattern '$pat' found:" >&2
    printf '%s\n' "$matches" >&2
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "Banned-strings check failed." >&2
  exit 1
fi

echo "banned-strings check: PASS"
