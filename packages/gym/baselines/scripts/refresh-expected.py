# /// script
# requires-python = ">=3.12"
# dependencies = ["ruamel.yaml"]
# ///
"""
Rewrite each gym corpus YAML's `cases[].expected` from the freshly-
generated SCIP baseline manifest. Keys match on (language, commit,
request.kind, request.target.{file,line,column,symbolName}).

Usage:
    uv run packages/gym/baselines/scripts/refresh-expected.py \
      packages/gym/baselines/manifest.jsonl

Preserves YAML comments + ordering via ruamel.yaml.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from ruamel.yaml import YAML

yaml = YAML(typ="rt")
yaml.preserve_quotes = True
yaml.width = 4096

REPO_ROOT = Path(__file__).resolve().parents[4]
CORPUS_ROOT = REPO_ROOT / "packages/gym/corpus"

def target_key(t: dict) -> tuple:
    return (
        t.get("file", ""),
        int(t.get("line", 0)),
        int(t.get("column", 0)),
        t.get("symbolName", ""),
    )

def main() -> int:
    manifest_path = Path(sys.argv[1])
    records = [json.loads(line) for line in manifest_path.read_text().splitlines() if line]

    by_key: dict[tuple, dict] = {}
    for rec in records:
        key = (rec["language"], rec["corpus"]["commit"], rec["request"]["kind"], target_key(rec["request"]["target"]))
        by_key[key] = rec

    total_rewrites = 0
    for corpus_file in sorted(CORPUS_ROOT.rglob("*.yaml")):
        if "repos" in corpus_file.parts:
            continue
        data = yaml.load(corpus_file)
        if not data or "cases" not in data:
            continue
        lang = data["language"]
        commit = data["corpus"]["commit"]
        rewrites = 0
        for case in data["cases"]:
            key = (lang, commit, case["kind"], target_key(case["target"]))
            rec = by_key.get(key)
            if rec is None:
                continue
            rs = rec.get("result_set", [])
            new_expected = []
            for r in rs:
                entry = {"file": r["file"], "line": r["line"], "column": r["column"]}
                if "enclosing" in r:
                    entry["enclosing"] = r["enclosing"]
                new_expected.append(entry)
            # Preserve case's existing shape of `expected` (list). Only
            # rewrite when we have a manifest record; absent records
            # leave the hand-labelled data alone. Auto-waive cases
            # whose SCIP result set is legitimately empty — the corpus
            # test asserts that every non-waived case has at least one
            # expected hit.
            case["expected"] = new_expected
            if len(new_expected) == 0 and not case.get("waived"):
                case["waived"] = True
                case["labeler_note"] = (
                    "Auto-waived: SCIP returned zero hits for this target. "
                    "The target symbol has no callers/references/implementers "
                    "inside the fixture."
                )
            rewrites += 1
        if rewrites > 0:
            yaml.dump(data, corpus_file)
            print(f"updated {corpus_file.relative_to(REPO_ROOT)}: {rewrites} case(s)")
            total_rewrites += rewrites
    print(f"total {total_rewrites} cases rewritten")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
