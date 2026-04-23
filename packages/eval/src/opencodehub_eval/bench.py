"""MVP acceptance dashboard.

Prints a markdown table showing pass/fail status for each of the 9 MVP
acceptance criteria from the PRD. Intended as a quick "does this cut
still satisfy MVP DoD?" overview — the authoritative verifier is
``scripts/acceptance.sh``, which this script complements.

Run with:

    uv run python -m opencodehub_eval.bench
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from rich.console import Console
from rich.table import Table

from opencodehub_eval.agent import default_cli_entry


REPO_ROOT = Path(__file__).resolve().parents[3].parent  # packages/ → repo root


def _run(cmd: list[str], **kwargs: Any) -> tuple[int, str, str]:
    res = subprocess.run(cmd, capture_output=True, text=True, **kwargs)
    return res.returncode, res.stdout, res.stderr


def _check_build() -> tuple[str, str]:
    code, _, stderr = _run(["pnpm", "-r", "build"], cwd=str(REPO_ROOT))
    return ("PASS", "pnpm -r build green") if code == 0 else ("FAIL", stderr[-200:])


def _check_min_analyze() -> tuple[str, str]:
    cli = default_cli_entry()
    if not Path(cli).exists():
        return "SKIP", "CLI not built"
    with tempfile.TemporaryDirectory() as d:
        repo = Path(d) / "fixture"
        shutil.copytree(Path(__file__).parent / "fixtures" / "ts", repo)
        env = os.environ.copy()
        home = Path(d) / "home"
        (home / ".codehub").mkdir(parents=True)
        env["HOME"] = str(home)
        _run(["git", "init", "-q", "--initial-branch=main", str(repo)], env=env)
        _run(["git", "add", "."], cwd=str(repo), env=env)
        _run(
            [
                "git",
                "-c",
                "user.email=e@e",
                "-c",
                "user.name=e",
                "commit",
                "-q",
                "-m",
                "init",
            ],
            cwd=str(repo),
            env=env,
        )
        code, out, err = _run(
            ["node", cli, "analyze", str(repo), "--force", "--skip-agents-md"],
            env=env,
        )
        combined = out + err
        # Parse "N nodes, M edges".
        import re

        m = re.search(r"(\d+)\s+nodes,\s*(\d+)\s+edges", combined)
        if not m:
            return "FAIL", combined[-200:]
        n, e = int(m.group(1)), int(m.group(2))
        if n >= 5 and e >= 3:
            return "PASS", f"{n} nodes, {e} edges"
        return "FAIL", f"only {n} nodes, {e} edges (need ≥5, ≥3)"


def _check_determinism() -> tuple[str, str]:
    cli = default_cli_entry()
    if not Path(cli).exists():
        return "SKIP", "CLI not built"
    import re

    with tempfile.TemporaryDirectory() as d:
        a = Path(d) / "a"
        b = Path(d) / "b"
        shutil.copytree(Path(__file__).parent / "fixtures" / "ts", a)
        shutil.copytree(Path(__file__).parent / "fixtures" / "ts", b)
        env = os.environ.copy()
        home = Path(d) / "home"
        (home / ".codehub").mkdir(parents=True)
        env["HOME"] = str(home)
        hashes: list[str] = []
        for repo in (a, b):
            _run(["git", "init", "-q", "--initial-branch=main", str(repo)], env=env)
            _run(["git", "add", "."], cwd=str(repo), env=env)
            _run(
                [
                    "git",
                    "-c",
                    "user.email=e@e",
                    "-c",
                    "user.name=e",
                    "commit",
                    "-q",
                    "-m",
                    "init",
                ],
                cwd=str(repo),
                env=env,
            )
            _, out, err = _run(
                ["node", cli, "analyze", str(repo), "--force", "--skip-agents-md"],
                env=env,
            )
            m = re.search(r"graph\s+([a-f0-9]{8})", out + err)
            if m:
                hashes.append(m.group(1))
        if len(hashes) == 2 and hashes[0] == hashes[1]:
            return "PASS", f"graphHash={hashes[0]}"
        return "FAIL", f"hashes diverged: {hashes}"


def _check_mcp_tools() -> tuple[str, str]:
    smoke = REPO_ROOT / "scripts" / "smoke-mcp.sh"
    if not smoke.exists():
        return "SKIP", "smoke script missing"
    code, out, err = _run(["bash", str(smoke)])
    return ("PASS", "7 tools listed") if code == 0 else ("FAIL", err or out)


def _check_banned_strings() -> tuple[str, str]:
    script = REPO_ROOT / "scripts" / "check-banned-strings.sh"
    if not script.exists():
        return "SKIP", "script missing"
    code, _, _ = _run(["bash", str(script)])
    return ("PASS", "clean") if code == 0 else ("FAIL", "banned pattern found")


def _check_licenses() -> tuple[str, str]:
    code, _, stderr = _run(
        [
            "pnpm",
            "exec",
            "license-checker-rseidelsohn",
            "--onlyAllow",
            "Apache-2.0;MIT;BSD-2-Clause;BSD-3-Clause;ISC;CC0-1.0",
            "--excludePrivatePackages",
            "--production",
        ],
        cwd=str(REPO_ROOT),
    )
    return ("PASS", "allowlist clean") if code == 0 else ("FAIL", stderr[-200:])


def _check_setup_command() -> tuple[str, str]:
    cli = default_cli_entry()
    if not Path(cli).exists():
        return "SKIP", "CLI not built"
    with tempfile.TemporaryDirectory() as d:
        env = os.environ.copy()
        home = Path(d) / "home"
        project = Path(d) / "project"
        home.mkdir()
        project.mkdir()
        env["HOME"] = str(home)
        # `setup` writes three global configs under $HOME (cursor, codex,
        # windsurf) and two project-scoped configs under CWD (claude-code,
        # opencode). Run with CWD=project so both sets land somewhere
        # observable.
        code, _, err = _run(["node", cli, "setup", "--force"], env=env, cwd=str(project))
        if code != 0:
            return "FAIL", err[-200:]
        candidates = [
            project / ".mcp.json",  # claude-code
            home / ".cursor" / "mcp.json",  # cursor
            home / ".codex" / "config.toml",  # codex
            home / ".codeium" / "windsurf" / "mcp_config.json",  # windsurf
            project / "opencode.json",  # opencode
        ]
        touched = sum(1 for p in candidates if p.exists())
        return (
            ("PASS", f"{touched}/5 editor configs written")
            if touched >= 5
            else ("FAIL", f"only {touched}/5 editor configs written")
        )


def _check_offline() -> tuple[str, str]:
    cli = default_cli_entry()
    if not Path(cli).exists():
        return "SKIP", "CLI not built"
    with tempfile.TemporaryDirectory() as d:
        repo = Path(d) / "fixture"
        shutil.copytree(Path(__file__).parent / "fixtures" / "py", repo)
        env = os.environ.copy()
        home = Path(d) / "home"
        (home / ".codehub").mkdir(parents=True)
        env["HOME"] = str(home)
        _run(["git", "init", "-q", "--initial-branch=main", str(repo)], env=env)
        _run(["git", "add", "."], cwd=str(repo), env=env)
        _run(
            [
                "git",
                "-c",
                "user.email=e@e",
                "-c",
                "user.name=e",
                "commit",
                "-q",
                "-m",
                "init",
            ],
            cwd=str(repo),
            env=env,
        )
        code, _, err = _run(
            ["node", cli, "analyze", str(repo), "--force", "--offline", "--skip-agents-md"],
            env=env,
        )
        return (
            ("PASS", "analyze --offline completed")
            if code == 0
            else ("FAIL", err[-200:])
        )


def _check_eval_cases() -> tuple[str, str]:
    """Run the parametrized eval suite and report pass rate.

    Target (from baselines/opencodehub-v1.json):
      - core = 98  (14 langs × 7 core tools)
      - new  = 63  (v1.0 new-tool matrix)
      - total = 161
    The v1.0 acceptance gate is >=95 core passes + >=80% of new cases.
    """
    code, out, err = _run(
        ["uv", "run", "pytest", "src/opencodehub_eval/tests/test_parametrized.py", "-q"],
        cwd=str(REPO_ROOT / "packages" / "eval"),
    )
    # Look for "NN passed" in the output.
    import re

    baseline_total = _load_baseline_total()
    m = re.search(r"(\d+)\s+passed", out + err)
    if m:
        return (
            ("PASS", f"{m.group(1)}/{baseline_total} pass")
            if code == 0
            else ("FAIL", f"{m.group(1)}/{baseline_total} pass (non-zero exit)")
        )
    return ("FAIL", "could not parse pytest output")


def _load_baseline_total() -> int:
    """Resolve the authoritative `total_case_count` for the current release.

    Prefers the v1.0 baseline; falls back to the MVP baseline, then to a
    hard-coded 98 (the core-tool target) if neither file is present.
    """
    for name in ("opencodehub-v1.json", "opencodehub-mvp.json"):
        candidate = REPO_ROOT / "packages" / "eval" / "baselines" / name
        if not candidate.exists():
            continue
        try:
            payload = json.loads(candidate.read_text())
        except json.JSONDecodeError:
            continue
        total = payload.get("total_case_count") or payload.get("eval_cases_total")
        if isinstance(total, int) and total > 0:
            return total
    return 98


CRITERIA: list[tuple[str, Any]] = [
    ("pnpm -r build", _check_build),
    ("analyze fixture → ≥5 nodes, ≥3 edges", _check_min_analyze),
    ("determinism (graphHash identical)", _check_determinism),
    ("setup writes 5 editor configs", _check_setup_command),
    ("analyze --offline completes", _check_offline),
    ("banned-strings grep clean", _check_banned_strings),
    ("license allowlist clean", _check_licenses),
    ("MCP server lists 7 tools", _check_mcp_tools),
    ("parametrized eval cases (98 core + 63 v1.0 new)", _check_eval_cases),
]


def main() -> int:
    console = Console()
    table = Table(title="OpenCodeHub MVP Acceptance Dashboard")
    table.add_column("#", justify="right")
    table.add_column("Criterion")
    table.add_column("Status", justify="center")
    table.add_column("Detail")

    fails = 0
    for i, (name, fn) in enumerate(CRITERIA, start=1):
        try:
            status, detail = fn()
        except Exception as err:  # noqa: BLE001
            status, detail = "FAIL", f"exception: {err}"
        if status == "FAIL":
            fails += 1
        color = {"PASS": "green", "FAIL": "red", "SKIP": "yellow"}.get(status, "white")
        table.add_row(str(i), name, f"[{color}]{status}[/{color}]", detail[:80])

    console.print(table)
    console.print(f"\n{len(CRITERIA) - fails}/{len(CRITERIA)} criteria passing.")

    # Write a machine-readable artifact too.
    out_path = REPO_ROOT / ".erpaval" / "sessions" / "001" / "acceptance-bench.json"
    if out_path.parent.exists():
        out_path.write_text(
            json.dumps(
                {"total": len(CRITERIA), "failing": fails, "passing": len(CRITERIA) - fails},
                indent=2,
            )
        )
    return 1 if fails > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
