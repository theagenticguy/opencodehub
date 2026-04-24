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
BANNED_LITERALS=(
  'STEP_IN_PROCESS'
  'heuristicLabel'
  'codeprobe'
  'STEP_IN_FLOW'
  'kuzu'
  'ladybug'
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
EXCLUDES=(
  ':(exclude)scripts/check-banned-strings.sh'
  ':(exclude)vendor'
  ':(exclude)pnpm-lock.yaml'
  ':(exclude).erpaval'
)

fail=0

# Literal-string sweep (case-insensitive).
for pat in "${BANNED_LITERALS[@]}"; do
  if matches=$(git grep -I -n -i -e "$pat" --untracked -- "${EXCLUDES[@]}" 2>/dev/null); then
    echo "FAIL: banned literal '$pat' found:" >&2
    printf '%s\n' "$matches" >&2
    fail=1
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

if [ "$fail" -ne 0 ]; then
  echo "Banned-strings check failed." >&2
  exit 1
fi

echo "banned-strings check: PASS"
