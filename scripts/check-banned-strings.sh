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
  'gitnexus'
  'STEP_IN_PROCESS'
  'heuristicLabel'
  'codeprobe'
  'STEP_IN_FLOW'
  'kuzu'
  'ladybug'
  'duckpgq'
)

# Regex patterns we reject. POSIX-extended syntax (`git grep -E`).
# Using basic char-class forms to stay portable across git-grep builds that
# don't link PCRE2 (macOS default does not).
BANNED_REGEX=(
  # Wave-plan codes: W1-CORE, W2-A.2, W2-C.1, W2-E.4, W3-F.1, W5-2, etc.
  '\bW[0-9]+-[A-Z0-9]+'
  # "Stream X" references (Stream E, Stream J, Stream L, Stream T, Stream U...).
  '\bStream [A-Z]\b'
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
