# @opencodehub/eval — extracted

The Python retrieval / graph-quality evaluation harness that used to live
here was extracted to the sibling `opencodehub-testbed` repository so the
production package set ships free of test-time dependencies. Any local
`.venv/`, `.pytest_cache/`, `.ruff_cache/`, or `src/` left in this folder
is untracked and gitignored — see `opencodehub-testbed` for the harness.
