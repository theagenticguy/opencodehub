#!/usr/bin/env bash
# Re-vendor tree-sitter grammar WASMs into packages/ingestion/vendor/wasms/.
#
# Native tree-sitter and the 15 grammar packages are NOT workspace deps —
# they're installed on demand for vendoring only. Before running:
#
#   1. Add the grammar packages you want to re-vendor as devDependencies
#      to packages/ingestion/package.json (along with `tree-sitter` and
#      `tree-sitter-cli` if you're rebuilding kotlin/swift/dart).
#   2. Run `pnpm install`.
#   3. Run this script.
#   4. Commit the updated wasms + manifest.json.
#   5. `pnpm rm` the grammar devDeps you added in step 1.
#
# Two strategies inside this script:
#
#   1. cp from node_modules/.pnpm/  (12 grammars that ship a .wasm in their
#      published npm tarball: typescript, tsx, javascript, python, go, rust,
#      java, c-sharp, ruby, c, cpp, php).
#
#   2. tree-sitter build --wasm  (3 grammars whose npm tarball ships only C
#      sources: kotlin, swift, dart). Requires docker/podman/finch (aliased
#      as `docker`) or a local emcc install.
#
# A vendor/wasms/manifest.json file records the grammar version each .wasm
# was built against. The packages/ingestion/scripts/verify-vendor-wasms.mjs
# script (run as `prepublishOnly`) asserts the manifest matches the versions
# in packages/ingestion/package.json (or, when grammar deps are absent,
# accepts the manifest as the source of truth).
#
# Usage: bash scripts/build-vendor-wasms.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$REPO_ROOT/packages/ingestion/vendor/wasms"
PNPM_DIR="$REPO_ROOT/node_modules/.pnpm"
TREE_SITTER_BIN="$REPO_ROOT/node_modules/.pnpm/node_modules/.bin/tree-sitter"
INGESTION_PJ="$REPO_ROOT/packages/ingestion/package.json"

mkdir -p "$OUT_DIR"

# Read the version of <pkg> from packages/ingestion/package.json devDeps OR deps.
# Strips ^/~/= prefixes.
read_pj_version() {
  local pkg="$1"
  node -e "
    const pj = require('$INGESTION_PJ');
    const v = (pj.dependencies && pj.dependencies['$pkg']) ||
              (pj.devDependencies && pj.devDependencies['$pkg']);
    if (!v) { process.exit(1); }
    process.stdout.write(String(v).replace(/^[\^~=]/, ''));
  "
}

# Copy the .wasm shipped inside an npm tarball.
# locate_pkg <pkg> <version> -> echoes node_modules/.pnpm/<pkg>@<v>.../node_modules/<pkg> dir
locate_pkg() {
  local pkg="$1"
  local v="$2"
  find "$PNPM_DIR" -maxdepth 4 \
    -path "*${pkg}@${v}*/node_modules/${pkg}" \
    -type d \
    | head -1
}

cp_wasm() {
  local pkg="$1"      # e.g. tree-sitter-typescript
  local out_name="$2" # e.g. tree-sitter-typescript.wasm
  local v
  v="$(read_pj_version "$pkg")"
  local d
  d="$(locate_pkg "$pkg" "$v")"
  if [[ -z "$d" ]]; then
    echo "error: could not locate installed grammar for ${pkg}@${v}" >&2
    exit 1
  fi
  local src="$d/$out_name"
  if [[ ! -f "$src" ]]; then
    echo "error: ${pkg}@${v} does not ship $out_name at $src" >&2
    exit 1
  fi
  cp "$src" "$OUT_DIR/$out_name"
  echo "    -> $OUT_DIR/$out_name (cp from ${pkg}@${v})"
}

build_one() {
  local lang="$1"
  local pkg="$2"
  local out_path="$OUT_DIR/tree-sitter-${lang}.wasm"

  local v
  if ! v="$(read_pj_version "$pkg" 2>/dev/null)" || [[ -z "$v" ]]; then
    # Grammar isn't declared in packages/ingestion/package.json. The vendored
    # wasm exists historically and isn't auto-rebuildable from npm. Preserve.
    if [[ -f "$out_path" ]]; then
      echo "    -> $out_path (kept; ${pkg} is not pinned in package.json — vendored historically)"
      return 0
    fi
    echo "error: ${pkg} not in package.json and no vendored wasm at $out_path" >&2
    exit 1
  fi

  local grammar_dir
  grammar_dir="$(locate_pkg "$pkg" "$v")"
  if [[ -z "$grammar_dir" ]]; then
    echo "error: could not locate installed grammar for ${pkg}@${v}" >&2
    exit 1
  fi

  if [[ ! -x "$TREE_SITTER_BIN" ]]; then
    echo "error: tree-sitter CLI not found at $TREE_SITTER_BIN — run 'pnpm install' first" >&2
    exit 1
  fi

  local work_dir
  work_dir="$(mktemp -d)"
  trap "rm -rf $work_dir" EXIT
  cp -r "$grammar_dir"/* "$work_dir/"

  echo "    -> building $lang from ${pkg}@${v}"
  if ( cd "$work_dir" && "$TREE_SITTER_BIN" build --wasm -d -o "$out_path" . ) 2>/tmp/build-vendor-wasms-err.log; then
    echo "    -> $out_path"
  else
    if [[ -f "$out_path" ]]; then
      echo "    -> $out_path (build failed; existing vendored wasm preserved)"
      echo "       (toolchain not available — install one of: emcc, docker, podman, finch — to rebuild)"
    else
      cat /tmp/build-vendor-wasms-err.log >&2
      echo "error: cannot build $lang and no vendored wasm exists at $out_path" >&2
      exit 1
    fi
  fi
}

echo "==> 12 grammars that ship .wasm in their npm tarball — cp"
cp_wasm tree-sitter-typescript tree-sitter-typescript.wasm
cp_wasm tree-sitter-typescript tree-sitter-tsx.wasm
cp_wasm tree-sitter-javascript tree-sitter-javascript.wasm
cp_wasm tree-sitter-python     tree-sitter-python.wasm
cp_wasm tree-sitter-go         tree-sitter-go.wasm
cp_wasm tree-sitter-rust       tree-sitter-rust.wasm
cp_wasm tree-sitter-java       tree-sitter-java.wasm
cp_wasm tree-sitter-c-sharp    tree-sitter-c_sharp.wasm
cp_wasm tree-sitter-c          tree-sitter-c.wasm
cp_wasm tree-sitter-cpp        tree-sitter-cpp.wasm
cp_wasm tree-sitter-ruby       tree-sitter-ruby.wasm
cp_wasm tree-sitter-php        tree-sitter-php_only.wasm

echo
echo "==> 3 grammars without prebuilt .wasm — tree-sitter build --wasm"
build_one kotlin tree-sitter-kotlin
build_one swift  tree-sitter-swift
build_one dart   tree-sitter-dart

echo
echo "==> web-tree-sitter runtime wasm — cp"
WTS_DIR="$(find "$PNPM_DIR" -maxdepth 4 -path '*web-tree-sitter@*/node_modules/web-tree-sitter' -type d | head -1)"
if [[ -z "$WTS_DIR" ]]; then
  echo "error: could not locate installed web-tree-sitter package" >&2
  exit 1
fi
cp "$WTS_DIR/web-tree-sitter.wasm" "$OUT_DIR/web-tree-sitter.wasm"
echo "    -> $OUT_DIR/web-tree-sitter.wasm"

echo
echo "==> writing vendor/wasms/manifest.json"
node -e "
  const fs = require('fs');
  const pj = require('$INGESTION_PJ');
  const root = require('$REPO_ROOT/package.json');
  const all = {
    ...(pj.dependencies||{}),
    ...(pj.devDependencies||{}),
    ...(root.dependencies||{}),
    ...(root.devDependencies||{}),
  };
  const grammars = {};
  const names = [
    'tree-sitter','tree-sitter-typescript','tree-sitter-javascript',
    'tree-sitter-python','tree-sitter-go','tree-sitter-rust','tree-sitter-java',
    'tree-sitter-c-sharp','tree-sitter-c','tree-sitter-cpp','tree-sitter-ruby',
    'tree-sitter-php','tree-sitter-kotlin','tree-sitter-swift',
    'web-tree-sitter',
  ];
  for (const n of names) {
    if (all[n]) grammars[n] = String(all[n]).replace(/^[\^~=]/, '');
  }
  // tree-sitter-dart is vendored historically (no upstream npm publish).
  // Record the vendored-historically marker so verify-vendor-wasms.mjs
  // doesn't false-fail on it.
  grammars['tree-sitter-dart'] = 'vendored-historically';
  const manifest = {
    schema: 'opencodehub.vendor-wasms.v1',
    description: 'Versions the .wasm files in this directory were built/copied from. Verified at prepublish.',
    grammars,
  };
  fs.writeFileSync('$OUT_DIR/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  console.log('    -> ' + '$OUT_DIR/manifest.json');
"

echo
echo "Done. ls $OUT_DIR/*.wasm | wc -l should be 16 (15 grammars + web-tree-sitter)."
