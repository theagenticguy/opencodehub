#!/usr/bin/env bash
# Rebuild the 3 vendored tree-sitter WASM grammars (kotlin, swift, dart)
# from the currently-installed grammar packages under node_modules.
#
# Requires one of: docker, podman, finch (symlinked or aliased as `docker`),
# or a local emcc install, plus tree-sitter-cli (installed by `pnpm install`).
#
# Outputs to packages/ingestion/vendor/wasms/tree-sitter-<lang>.wasm.
#
# Usage: bash scripts/build-vendor-wasms.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$REPO_ROOT/packages/ingestion/vendor/wasms"
TREE_SITTER_BIN="$REPO_ROOT/node_modules/.pnpm/node_modules/.bin/tree-sitter"

if [[ ! -x "$TREE_SITTER_BIN" ]]; then
  echo "error: tree-sitter CLI not found at $TREE_SITTER_BIN — run 'pnpm install' first" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

build_one() {
  local lang="$1"
  local pkg="$2"
  local grammar_dir
  grammar_dir=$(find "$REPO_ROOT/node_modules/.pnpm" -maxdepth 4 -path "*${pkg}*/node_modules/${pkg}" -type d | head -1)
  if [[ -z "$grammar_dir" ]]; then
    echo "error: could not locate installed grammar for $pkg" >&2
    exit 1
  fi

  local work_dir
  work_dir=$(mktemp -d)
  trap "rm -rf $work_dir" EXIT
  cp -r "$grammar_dir"/* "$work_dir/"

  echo "==> building $lang from $grammar_dir"
  ( cd "$work_dir" && "$TREE_SITTER_BIN" build --wasm -d -o "$OUT_DIR/tree-sitter-${lang}.wasm" . )
  echo "    -> $OUT_DIR/tree-sitter-${lang}.wasm"
}

build_one kotlin tree-sitter-kotlin
build_one swift  tree-sitter-swift
build_one dart   tree-sitter-dart

echo
echo "Done. git diff to see updated vendor/wasms/*.wasm"
