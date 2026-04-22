"""Shared pytest fixtures for the OpenCodeHub eval harness.

This file is responsible for five things:

1. Configure anyio to run under asyncio by default.
2. Resolve the path to the built ``codehub`` CLI entrypoint.
3. Copy every language fixture into a throw-away working directory,
   initialise a minimal git repo in each, run ``codehub analyze`` once,
   and stamp the per-language name into a shared registry under a
   disposable ``$HOME``. Downstream tests reuse this session-scoped
   registry via the ``indexed_fixtures`` fixture.
4. Ingest a synthetic SARIF log into every indexed repo so the
   ``list_findings`` tool has Finding nodes to return.
5. Register a two-repo cross-language group so the ``group_query``
   tool has something to search across.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from collections.abc import Iterator
from pathlib import Path

import pytest

from opencodehub_eval.agent import default_cli_entry

# 14 language fixtures (7 MVP + 7 W2-C.2/3/4 additions).
LANGUAGES: tuple[str, ...] = (
    "ts",
    "js",
    "py",
    "go",
    "rust",
    "java",
    "csharp",
    "c",
    "cpp",
    "ruby",
    "kotlin",
    "swift",
    "php",
    "dart",
)

# Name of the two-repo group registered once per session for
# cross-repo tool coverage (group_query).
GROUP_NAME = "eval-cross-repo"
GROUP_MEMBERS: tuple[str, ...] = ("fixture-ts", "fixture-py")


@pytest.fixture(scope="session")
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture(scope="session")
def cli_entry() -> str:
    """Absolute path to the built CLI (``packages/cli/dist/index.js``)."""
    entry = default_cli_entry()
    if not Path(entry).exists():
        pytest.skip(
            f"CLI entry {entry} not built — run `pnpm -r build` before the eval harness."
        )
    return entry


@pytest.fixture(scope="session")
def fixtures_root() -> Path:
    """Directory that holds the 14 language fixtures."""
    here = Path(__file__).resolve()
    return here.parent.parent / "fixtures"


def _git_env() -> dict[str, str]:
    env = os.environ.copy()
    env.update(
        {
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_CONFIG_SYSTEM": "/dev/null",
            "GIT_AUTHOR_NAME": "OpenCodeHub Eval",
            "GIT_AUTHOR_EMAIL": "eval@opencodehub.invalid",
            "GIT_COMMITTER_NAME": "OpenCodeHub Eval",
            "GIT_COMMITTER_EMAIL": "eval@opencodehub.invalid",
        }
    )
    return env


def _git_init(workdir: Path) -> None:
    env = _git_env()
    subprocess.run(
        ["git", "init", "-q", "--initial-branch=main", str(workdir)],
        check=True,
        env=env,
    )
    subprocess.run(["git", "add", "."], check=True, cwd=workdir, env=env)
    subprocess.run(
        ["git", "commit", "-q", "-m", "fixture init"],
        check=True,
        cwd=workdir,
        env=env,
    )


def _analyze(cli_entry: str, repo: Path, home: Path) -> None:
    env = os.environ.copy()
    env["HOME"] = str(home)
    subprocess.run(
        ["node", cli_entry, "analyze", str(repo), "--force", "--skip-agents-md"],
        check=True,
        env=env,
        capture_output=True,
    )


def _synthetic_sarif(repo_name: str) -> dict[str, object]:
    """Minimal but valid SARIF 2.1.0 log with one finding.

    We deliberately target a file that exists in every fixture's
    registered repo ("README.md" — created below if absent, or a stand-in
    path) so the resulting Finding can be attached to a File node. The
    ingestion pipeline tolerates missing files by emitting the Finding
    without a FOUND_IN edge, which still satisfies the list_findings
    tool's structuredContent shape.
    """
    return {
        "version": "2.1.0",
        "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
        "runs": [
            {
                "tool": {
                    "driver": {
                        "name": "eval-synthetic",
                        "version": "0.0.0",
                        "rules": [
                            {
                                "id": "EVAL001",
                                "shortDescription": {"text": "synthetic rule"},
                            }
                        ],
                    }
                },
                "results": [
                    {
                        "ruleId": "EVAL001",
                        "level": "warning",
                        "message": {"text": f"synthetic finding for {repo_name}"},
                        "locations": [
                            {
                                "physicalLocation": {
                                    "artifactLocation": {"uri": "SYNTHETIC.sarif-target"},
                                    "region": {"startLine": 1, "endLine": 1},
                                }
                            }
                        ],
                    }
                ],
            }
        ],
    }


def _ingest_sarif(cli_entry: str, repo: Path, home: Path, repo_name: str) -> None:
    """Write a synthetic SARIF to the repo and ingest it.

    Failures are swallowed: ingestion depends on SARIF schema validation
    and a working store, and if either is broken we still want the
    non-findings-dependent cases to run.
    """
    env = os.environ.copy()
    env["HOME"] = str(home)
    sarif_path = repo / ".codehub-eval.sarif"
    sarif_path.write_text(json.dumps(_synthetic_sarif(repo_name)))
    subprocess.run(
        [
            "node",
            cli_entry,
            "ingest-sarif",
            str(sarif_path),
            "--repo",
            repo_name,
        ],
        env=env,
        capture_output=True,
        check=False,
    )


def _register_group(cli_entry: str, home: Path, members: tuple[str, ...]) -> None:
    """Define a named cross-repo group containing `members`.

    Silent on failure for the same reason as `_ingest_sarif`: the
    harness should still run the other parametrized cases even if group
    registration misfires.
    """
    env = os.environ.copy()
    env["HOME"] = str(home)
    subprocess.run(
        [
            "node",
            cli_entry,
            "group",
            "create",
            GROUP_NAME,
            *members,
        ],
        env=env,
        capture_output=True,
        check=False,
    )


@pytest.fixture(scope="session")
def indexed_fixtures(
    cli_entry: str,
    fixtures_root: Path,
    tmp_path_factory: pytest.TempPathFactory,
) -> Iterator[dict[str, object]]:
    """Stage every language fixture and analyze it once per test session.

    Yields a dict with:
      - ``home``: path to the isolated ``$HOME`` the MCP server must use
      - ``repos``: ``{lang: {"path": <str>, "name": <str>}}``
      - ``group``: name of the registered cross-repo group
    """
    session_root = tmp_path_factory.mktemp("opencodehub-eval")
    home = session_root / "home"
    home.mkdir(parents=True, exist_ok=True)
    (home / ".codehub").mkdir(parents=True, exist_ok=True)

    repos: dict[str, dict[str, str]] = {}
    for lang in LANGUAGES:
        src = fixtures_root / lang
        if not src.exists():
            continue
        dst = session_root / f"fixture-{lang}"
        shutil.copytree(src, dst)
        # Use a distinct directory name per language so the registry records
        # one repo per language.
        _git_init(dst)
        _analyze(cli_entry, dst, home)
        repos[lang] = {"path": str(dst), "name": dst.name}

    # After indexing, ingest a synthetic SARIF into every repo so
    # list_findings has something to return, and register a cross-repo
    # group so group_query has somewhere to search. Both steps are
    # best-effort — see docstrings on the helpers.
    for lang, entry in repos.items():
        _ingest_sarif(cli_entry, Path(entry["path"]), home, entry["name"])
    members = tuple(entry["name"] for lang, entry in repos.items() if lang in ("ts", "py"))
    if len(members) >= 1:
        _register_group(cli_entry, home, members)

    yield {"home": str(home), "repos": repos, "group": GROUP_NAME}


@pytest.fixture()
def eval_home(indexed_fixtures: dict[str, object]) -> str:
    return str(indexed_fixtures["home"])
