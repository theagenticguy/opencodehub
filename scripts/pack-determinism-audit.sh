#!/usr/bin/env bash
# scripts/pack-determinism-audit.sh — shell-level pack determinism gate.
#
# Runs `codehub code-pack` twice against the same repo with identical args,
# then `diff -r`'s the two output directories. PASS = byte-identical;
# any diff is a FAIL.
#
# This is the shell-level companion to `packages/pack/src/pack-determinism.test.ts`.
# The TS test pins the in-memory generatePack contract; this script pins the
# real CLI binary against a real DuckStore — together they cover both layers
# of the byte-identity invariant.
#
# Usage:
#   bash scripts/pack-determinism-audit.sh              # uses repo root
#   bash scripts/pack-determinism-audit.sh /path/repo   # explicit repo
#
# SKIP behavior:
#   The script exits 0 with a SKIP message when:
#     - The CLI binary at packages/cli/dist/index.js is absent (build first).
#     - The repo lacks a `<repo>/.codehub/store.sqlite` index (run `codehub
#       analyze` first). This lets the script run safely as part of
#       `scripts/acceptance.sh` on developer laptops without a populated index.

set -euo pipefail

REPO="${1:-$(git rev-parse --show-toplevel)}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/packages/cli/dist/index.js"

if [ ! -f "$CLI" ]; then
  echo "SKIP: pack-determinism — CLI not built at $CLI (run 'pnpm -r build' first)"
  exit 0
fi

if [ ! -f "$REPO/.codehub/store.sqlite" ]; then
  echo "SKIP: pack-determinism — no index at $REPO/.codehub/store.sqlite (run 'codehub analyze' first)"
  exit 0
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

OUT_A="$TMP/pack-a"
OUT_B="$TMP/pack-b"

# Run the CLI twice with identical args. The two output dirs MUST match
# byte-for-byte.
node "$CLI" code-pack "$REPO" \
  --budget 50000 \
  --tokenizer "openai:o200k_base@tiktoken-0.8.0" \
  --out-dir "$OUT_A" >/dev/null

node "$CLI" code-pack "$REPO" \
  --budget 50000 \
  --tokenizer "openai:o200k_base@tiktoken-0.8.0" \
  --out-dir "$OUT_B" >/dev/null

# Diff every file. `diff -r` exits 0 on byte-identical trees, non-zero
# otherwise. Suppress the matching-output noise; surface the divergence
# loudly when it happens.
if ! diff -r "$OUT_A" "$OUT_B" >/dev/null; then
  echo "FAIL: pack-determinism — outputs differ between runs" >&2
  diff -r "$OUT_A" "$OUT_B" >&2 || true
  exit 1
fi

echo "PASS: pack-determinism — outputs byte-identical across two runs"
