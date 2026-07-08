#!/usr/bin/env bash
# Clone + install + analyze each SWE-bench repo from a tasks dir's clones.json
# (Move 1, Phase 0). Idempotent: skips a clone/analyze that already exists.
#
# Usage: bash packages/eval/scripts/swebench-prep.sh <tasks-dir>
#
# Reads <tasks-dir>/clones.json (produced by swebench-to-tasks.mjs), clones each
# repo at its base_commit into the clone dest, best-effort installs Python deps,
# then runs `codehub analyze` so the with-pack arm has a graph to pack from.
#
# ⚠️ Fidelity: this materializes ONE checkout per instance. The v1 probe runner
# does not reset that checkout between the N runs, so the graded assertion
# pass-rate is indicative; the token + trajectory deltas are the trustworthy
# headline. Per-run isolation (or SWE-bench's official Docker images) is a v2
# upgrade — see docs/findings/0002.
set -euo pipefail

TASKS_DIR="${1:?usage: swebench-prep.sh <tasks-dir>}"
CLONES="${TASKS_DIR}/clones.json"
[ -f "$CLONES" ] || { echo "no clones.json in $TASKS_DIR — run swebench-to-tasks.mjs first" >&2; exit 1; }

# Resolve the codehub CLI: prefer a repo-local build, fall back to a global install.
CODEHUB="${CODEHUB:-codehub}"

# Emit the clone manifest as plain tab-separated rows in ONE node call, using
# process.stdout.write (console.log can be ANSI-colorized by a shim, which would
# corrupt the parsed fields). Iterate with `while read` — no per-field node
# spawns, no arithmetic on a possibly-colorized count.
node -e '
const rows = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
for (const r of rows) process.stdout.write([r.instanceId, r.cloneUrl, r.baseCommit, r.dest].join("\t") + "\n");
' "$CLONES" > "$TASKS_DIR/.clones.tsv"

echo "Preparing $(wc -l < "$TASKS_DIR/.clones.tsv" | tr -d ' ') SWE-bench repo(s) from ${CLONES}" >&2

while IFS=$'\t' read -r id url commit dest; do
  [ -n "$id" ] || continue
  echo "── ${id}" >&2
  if [ ! -d "$dest/.git" ]; then
    git clone --quiet "$url" "$dest"
  fi
  git -C "$dest" fetch --quiet origin "$commit" 2>/dev/null || true
  git -C "$dest" checkout --quiet --force "$commit"
  git -C "$dest" reset --hard --quiet "$commit"

  # Best-effort Python dep install (SWE-bench is ~94% Python). Non-fatal: a repo
  # that needs a bespoke env still yields token/trajectory deltas; only its
  # graded assertion needs the deps. Prefer uv, fall back to pip.
  if [ -f "$dest/pyproject.toml" ] || [ -f "$dest/setup.py" ]; then
    # Install the package + pytest into a per-repo uv venv so the assertion can
    # import and test it. Best-effort — a repo needing a bespoke env still
    # yields token/trajectory deltas; only its graded assertion needs deps.
    ( cd "$dest" \
      && uv venv --quiet .venv 2>/dev/null \
      && uv pip install --python .venv --quiet -e . pytest 2>/dev/null ) </dev/null \
      || echo "  (dep install skipped/failed — assertion may under-report; deltas still valid)" >&2
  fi

  # Analyze so the with-pack arm has a graph. --no-scan keeps it fast (findings
  # aren't needed for the pack context); drop it if a task exercises SARIF.
  # stdin from /dev/null so analyze never consumes the loop's manifest feed.
  if [ ! -f "$dest/.codehub/store.sqlite" ]; then
    "$CODEHUB" analyze "$dest" --no-scan >&2 </dev/null
  fi
done < "$TASKS_DIR/.clones.tsv"

echo "Done. Run e.g.:" >&2
echo "  CLAUDE_CODE_USE_BEDROCK=1 AWS_REGION=us-east-1 \\" >&2
echo "    codehub code-pack --variance-probe ${TASKS_DIR}/<id>.task.json --insight --runs 10 --json" >&2
