#!/usr/bin/env bash
# scripts/m7-parity-audit.sh — graphHash byte-identity audit across backends (AC-A-10).
#
# Runs `codehub analyze --force` on the same corpus under BOTH:
#   - `CODEHUB_STORE=duck`  → DuckDB legacy graph store
#   - `CODEHUB_STORE=lbug`  → @ladybugdb/core graph store
#
# Then extracts the `graph <hash>` line from each invocation's stderr and
# asserts byte-identity. This is the whole-pipeline end-to-end companion to
# the in-memory `assertGraphParity` harness (AC-A-7) — together they pin the
# U1 (graphHash byte-identity) invariant from BOTH layers: in-memory
# fixtures AND a real `codehub analyze` against a real corpus on disk.
#
# Usage:
#   bash scripts/m7-parity-audit.sh
#
# Env:
#   OCH_TESTBED_DIR — override the corpus path. Default: scripts/fixtures/ts.
#
# SKIP behavior:
#   The script exits 0 with a `[skip]` log line when:
#     - The CLI binary at packages/cli/dist/index.js is absent (build first).
#     - The `@ladybugdb/core` Node binding is unavailable on this host (no
#       prebuilt for the platform / arch). On dev boxes without the binding
#       the lbug leg cannot run; CI / testbed environments with the binding
#       installed run the full audit.
#
# FAIL behavior:
#   When both legs run and produce different graphHash values, the script
#   exits 1 with a diff and retains the temp artifacts at $TMP for forensics.
#   That is a real U1 regression, not a script issue — see ADR 0013.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/packages/cli/dist/index.js"
CORPUS="${OCH_TESTBED_DIR:-$ROOT/scripts/fixtures/ts}"

if [ ! -f "$CLI" ]; then
  echo "[m7-parity-audit][skip] CLI not built at $CLI (run 'pnpm -r build' first)"
  exit 0
fi

if [ ! -d "$CORPUS" ]; then
  echo "[m7-parity-audit][skip] corpus not found at $CORPUS (set OCH_TESTBED_DIR)"
  exit 0
fi

# Probe @ladybugdb/core binding availability — skip cleanly if absent.
if ! node -e "import('@ladybugdb/core').then(() => process.exit(0)).catch(() => process.exit(1))" >/dev/null 2>&1; then
  echo "[m7-parity-audit][skip] @ladybugdb/core unavailable on this host; lbug leg skipped"
  exit 0
fi

TMP="$(mktemp -d -t och-m7-audit-XXXXXX)"
DUCK_DIR="$TMP/audit-duck"
LBUG_DIR="$TMP/audit-lbug"
HOME_DUCK="$TMP/home-duck"
HOME_LBUG="$TMP/home-lbug"
mkdir -p "$HOME_DUCK/.codehub" "$HOME_LBUG/.codehub"

# Mirror the corpus into two sibling repos. Each must be a git repo so analyze
# records `lastCommit` deterministically (mirrors gate 6's pattern in
# scripts/acceptance.sh).
cp -R "$CORPUS" "$DUCK_DIR"
cp -R "$CORPUS" "$LBUG_DIR"
for dir in "$DUCK_DIR" "$LBUG_DIR"; do
  (cd "$dir" && git init -q --initial-branch=main && \
    git -c user.email=e@e -c user.name=e add . && \
    git -c user.email=e@e -c user.name=e commit -q -m init) >/dev/null 2>&1
done

extract_hash() {
  # The CLI logs `graph <8-hex>` on the analyze summary line. We extract the
  # 8-char prefix exactly like gate 6 in acceptance.sh — keeps the two gates
  # consistent on what they compare.
  grep -oE 'graph [a-f0-9]{8}' "$1" | head -1 | awk '{print $2}'
}

# Run analyze under each backend. `--skip-agents-md` keeps stdout/stderr
# noise down; `--force` skips the registry fast-path. We pin HOME so the
# registry is isolated per run (same as acceptance.sh gate 6).
HOME="$HOME_DUCK" CODEHUB_STORE=duck node "$CLI" analyze "$DUCK_DIR" --force --skip-agents-md \
  > "$TMP/duck.log" 2>&1 || {
    echo "[m7-parity-audit][FAIL] analyze under duck exited non-zero"
    tail -40 "$TMP/duck.log"
    echo "  artifacts retained at: $TMP"
    exit 1
  }
HOME="$HOME_LBUG" CODEHUB_STORE=lbug node "$CLI" analyze "$LBUG_DIR" --force --skip-agents-md \
  > "$TMP/lbug.log" 2>&1 || {
    echo "[m7-parity-audit][FAIL] analyze under lbug exited non-zero"
    tail -40 "$TMP/lbug.log"
    echo "  artifacts retained at: $TMP"
    exit 1
  }

DUCK_HASH="$(extract_hash "$TMP/duck.log")"
LBUG_HASH="$(extract_hash "$TMP/lbug.log")"

if [ -z "${DUCK_HASH:-}" ] || [ -z "${LBUG_HASH:-}" ]; then
  echo "[m7-parity-audit][FAIL] could not extract graphHash from analyze output"
  echo "  duck=${DUCK_HASH:-<empty>}"
  echo "  lbug=${LBUG_HASH:-<empty>}"
  echo "  artifacts retained at: $TMP"
  exit 1
fi

if [ "$DUCK_HASH" = "$LBUG_HASH" ]; then
  echo "[m7-parity-audit][pass] graphHash byte-identical across duck + lbug: $DUCK_HASH"
  rm -rf "$TMP"
  exit 0
fi

echo "[m7-parity-audit][FAIL] graphHash divergence — U1 invariant breach:"
echo "  duck: $DUCK_HASH"
echo "  lbug: $LBUG_HASH"
echo "  artifacts retained at: $TMP"
exit 1
