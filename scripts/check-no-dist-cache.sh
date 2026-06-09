#!/usr/bin/env bash
# check-no-dist-cache.sh — CI guardrail: never cache build output.
#
# Caching a package's `dist/` (or its `*.tsbuildinfo`) across CI runs
# resurrects a class of false failures: a `.test.ts` deleted in source leaves
# its compiled `dist/**/*.test.js` behind, `tsc -b` won't prune it, and
# `node --test` then runs the orphan against an interface that no longer
# exports what it imports — the suite fails on a test that does not exist in
# `src/`. A fresh `actions/checkout` never has this problem because `dist/` is
# gitignored and absent; an `actions/cache` over `dist/` reintroduces it.
#
# This guard fails the build if any workflow caches build output. The pnpm
# *store* cache (`~/.local/share/pnpm/store`) is fine and explicitly allowed —
# it holds downloaded packages, not compiled output.
#
# Rationale + history: the stale `dist/parse/wasm-runtime.test.js` incident
# (PR #206). Pairs with the "Remove stale build artifacts" prune step in
# ci.yml's test lanes as belt-and-suspenders.

set -euo pipefail

workflows_dir=".github/workflows"
if [[ ! -d "$workflows_dir" ]]; then
  echo "no $workflows_dir — nothing to check"
  exit 0
fi

# Any cache `path:` line that points at compiled output. We match the tokens
# that only ever appear in build-output paths, NOT the pnpm store. Matches
# `dist`, `dist-test`, and `*.tsbuildinfo` as path segments / globs.
#   - `dist/`, `dist`, `**/dist`, `packages/*/dist`, `dist-test`
#   - `.tsbuildinfo`, `*.tsbuildinfo`, `tsconfig.tsbuildinfo`
offending_paths_re='(^|[^a-zA-Z0-9_.-])(dist(-test)?)([/[:space:]]|$)|tsbuildinfo'

violations=0

for wf in "$workflows_dir"/*.yml "$workflows_dir"/*.yaml; do
  [[ -e "$wf" ]] || continue

  # Walk the file. Track whether we are inside an `actions/cache` step's
  # `with:`/`path:` block; flag any path entry that looks like build output.
  # A line-oriented scan is sufficient: `path:` for actions/cache is always a
  # literal scalar or a `|`/`-` block of literal paths.
  awk -v re="$offending_paths_re" -v fname="$wf" '
    BEGIN { in_cache = 0; in_path = 0; rc = 0 }

    # Entering a new "- uses:" step resets cache tracking.
    /^[[:space:]]*-[[:space:]]*uses:/ {
      in_cache = (index($0, "actions/cache") > 0) ? 1 : 0
      in_path = 0
      next
    }

    {
      if (in_cache) {
        # `path:` opens a path block (inline value or multiline list/scalar).
        if ($0 ~ /^[[:space:]]*path:[[:space:]]*/) {
          in_path = 1
          # Inline value on the same line, e.g. `path: dist/`.
          inline = $0
          sub(/^[[:space:]]*path:[[:space:]]*/, "", inline)
          gsub(/^[[:space:]]*[|>-][+-]?[[:space:]]*/, "", inline)
          if (inline != "" && inline ~ re) {
            printf("%s:%d: caches build output via actions/cache path: %s\n", fname, NR, $0) > "/dev/stderr"
            rc = 1
          }
          next
        }
        if (in_path) {
          # Subsequent indented list/scalar lines belong to the path block
          # until a non-indented-deeper key appears. Heuristic: a line that
          # introduces another `with:` key (e.g. `key:`, `restore-keys:`) ends
          # the path block.
          if ($0 ~ /^[[:space:]]*(key|restore-keys|enableCrossOsArchive|fail-on-cache-miss|lookup-only|upload-chunk-size):/) {
            in_path = 0
          } else if ($0 ~ re) {
            printf("%s:%d: caches build output via actions/cache path: %s\n", fname, NR, $0) > "/dev/stderr"
            rc = 1
          }
        }
      }
    }

    END { exit rc }
  ' "$wf" || violations=1
done

if [[ "$violations" -ne 0 ]]; then
  cat >&2 <<'EOF'

✘ A workflow caches build output (dist/ or *.tsbuildinfo).

Do NOT cache compiled output across CI runs. A stale dist/**/*.test.js (from a
.test.ts deleted in source) survives the cache and fails the suite on a test
that no longer exists. Cache the pnpm STORE (~/.local/share/pnpm/store) for
install speed instead — never dist/.

See scripts/check-no-dist-cache.sh for the full rationale.
EOF
  exit 1
fi

echo "ok — no workflow caches dist/ or *.tsbuildinfo"
exit 0
