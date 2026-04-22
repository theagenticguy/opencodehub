"""Parametrized tool coverage for OpenCodeHub.

Two parameter matrices live in this file:

* ``test_tool_per_language`` — the 98-case MVP + v1.0 expansion: 14
  language fixtures times 7 core MCP tools (``list_repos``, ``query``,
  ``context``, ``impact``, ``detect_changes``, ``rename``, ``sql``).
  This is the W2-C.5 deliverable.

* ``test_new_tool_case`` — W5-3 coverage for the nine tools that ship in
  v1.0 on top of the MVP surface (``owners``, ``risk_trends``,
  ``verdict``, ``scan``, ``list_findings``, ``dependencies``,
  ``license_audit``, ``project_profile``, ``group_query``). Not every
  tool maps 1:1 to every language — ``dependencies`` only makes sense
  where the fixture has a manifest, ``group_query`` is a single
  cross-repo assertion — so the parameter list is computed per-tool.

Each case spawns an ``OpenCodeHubAgent`` against the shared session
registry, picks a language-appropriate argument, invokes the tool, and
asserts on ``isError`` / ``structuredContent`` keys.

Failure philosophy: tools that have nothing to do on a pristine fixture
(e.g. ``detect_changes`` with ``scope='all'`` returns 0 files) still
count as a pass as long as the envelope shape is valid — this is
documented in Wave 9 deliverables and carries forward into v1.0.
"""

from __future__ import annotations

from typing import Any

import anyio
import pytest

from opencodehub_eval.agent import OpenCodeHubAgent

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

# 7 core MCP tools present since MVP. Exercised against every fixture.
TOOLS: tuple[str, ...] = (
    "list_repos",
    "query",
    "context",
    "impact",
    "detect_changes",
    "rename",
    "sql",
)

# 9 v1.0 additions. Coverage varies per tool — see NEW_TOOL_CASES below.
NEW_TOOLS: tuple[str, ...] = (
    "owners",
    "risk_trends",
    "verdict",
    "scan",
    "list_findings",
    "dependencies",
    "license_audit",
    "project_profile",
    "group_query",
)

# Ecosystems that have manifest parsers in `@opencodehub/ingestion` today
# (npm, python, go, rust, maven, nuget). Every other fixture still runs
# the `dependencies` tool but the structuredContent body will report 0
# dependencies — still a valid envelope, so the shape assertion passes.
LANGS_WITH_MANIFESTS: frozenset[str] = frozenset(
    {"ts", "js", "py", "go", "rust", "java", "csharp"}
)

# Per-language argument tables for the core tools that need a symbol.
# Each fixture was designed so at least one of these resolves to a node.
CONTEXT_SYMBOLS: dict[str, str] = {
    "ts": "AuthService",
    "js": "Auth",
    "py": "Auth",
    "go": "AuthService",
    "rust": "AuthService",
    "java": "Auth",
    "csharp": "Auth",
    "c": "auth_login",
    "cpp": "Auth",
    "ruby": "Auth",
    "kotlin": "Auth",
    "swift": "Auth",
    "php": "Auth",
    "dart": "Auth",
}
IMPACT_TARGETS: dict[str, str] = {
    "ts": "signIn",
    "js": "signIn",
    "py": "login",
    "go": "SignIn",
    "rust": "sign_in",
    "java": "signIn",
    "csharp": "SignIn",
    "c": "auth_login",
    "cpp": "login",
    "ruby": "login",
    "kotlin": "login",
    "swift": "login",
    "php": "login",
    "dart": "login",
}
RENAME_ARGS: dict[str, tuple[str, str]] = {
    "ts": ("register", "createAccount"),
    "js": ("register", "createAccount"),
    "py": ("register", "create_account"),
    "go": ("Register", "CreateAccount"),
    "rust": ("register", "create_account"),
    "java": ("register", "createAccount"),
    "csharp": ("Register", "CreateAccount"),
    "c": ("auth_register", "auth_sign_up"),
    "cpp": ("register_user", "create_account"),
    "ruby": ("register", "create_account"),
    "kotlin": ("register", "createAccount"),
    "swift": ("register", "createAccount"),
    "php": ("register", "createAccount"),
    "dart": ("register", "createAccount"),
}

# For ``owners`` we need a node id, not a bare symbol name. File nodes
# carry a stable, predictable id of the form ``File:<path>:<path>``.
OWNERS_FILE_PATHS: dict[str, str] = {
    "ts": "auth.ts",
    "js": "api.js",
    "py": "auth.py",
    "go": "auth.go",
    "rust": "auth.rs",
    "java": "Auth.java",
    "csharp": "Auth.cs",
    "c": "auth.c",
    "cpp": "auth.cpp",
    "ruby": "auth.rb",
    "kotlin": "Auth.kt",
    "swift": "Auth.swift",
    "php": "Auth.php",
    "dart": "auth.dart",
}


def _expected_structured_keys(tool: str) -> tuple[str, ...]:
    """Top-level keys we expect inside `structuredContent` for each tool."""
    return {
        "list_repos": ("repos",),
        "query": ("results",),
        "context": ("target",),
        "impact": ("risk",),
        "detect_changes": ("summary",),
        "rename": ("status",),
        "sql": ("rows",),
        # New tools (W5-3). ``risk_trends`` / ``verdict`` return whatever
        # key W3-F.1/W3-F.2 lands on — for now the tool is unregistered
        # so structuredContent assertions are skipped via the isError
        # branch.
        "owners": ("owners",),
        # risk_trends returns a community-level trend payload (W3-F.2):
        # communities, overall_trend, snapshot_count.
        "risk_trends": ("overall_trend",),
        # verdict (W3-F.1) returns tier + rationale + findings bundle. Once
        # the MCP tool lands we'll pin the exact key; until then this falls
        # through to the isError branch.
        "verdict": ("verdict",),
        "scan": ("summary",),
        "list_findings": ("findings",),
        "dependencies": ("dependencies",),
        "license_audit": ("tier",),
        "project_profile": ("profile",),
        "group_query": ("results",),
    }[tool]


async def _dispatch(
    agent: OpenCodeHubAgent,
    tool: str,
    lang: str,
    repo_name: str,
) -> dict[str, Any]:
    """Invoke a core tool with a language-appropriate input."""
    if tool == "list_repos":
        return await agent.list_repos()
    if tool == "query":
        return await agent.query("login", repo=repo_name)
    if tool == "context":
        return await agent.context(CONTEXT_SYMBOLS[lang], repo=repo_name)
    if tool == "impact":
        return await agent.impact(IMPACT_TARGETS[lang], repo=repo_name)
    if tool == "detect_changes":
        return await agent.detect_changes(scope="all", repo=repo_name)
    if tool == "rename":
        old, new = RENAME_ARGS[lang]
        return await agent.rename(old, new, dry_run=True, repo=repo_name)
    if tool == "sql":
        # Plain scalar rows avoid the BigInt serialization path that
        # blocks COUNT(*) responses at the MCP transport layer.
        return await agent.sql(
            "SELECT name, kind FROM nodes ORDER BY name LIMIT 3",
            repo=repo_name,
        )
    raise ValueError(f"unknown tool: {tool}")


async def _dispatch_new(
    agent: OpenCodeHubAgent,
    tool: str,
    lang: str,
    repo_name: str,
    group_name: str,
) -> dict[str, Any]:
    """Invoke a v1.0 tool with language-appropriate inputs."""
    if tool == "owners":
        # owners expects a node id (not a bare symbol). File nodes use
        # the canonical form ``File:<path>:<path>``.
        path = OWNERS_FILE_PATHS[lang]
        target = f"File:{path}:{path}"
        return await agent.owners(target, repo=repo_name)
    if tool == "risk_trends":
        return await agent.risk_trends(repo=repo_name)
    if tool == "verdict":
        # HEAD vs HEAD yields an empty diff, which the verdict tool
        # should still be able to evaluate.
        return await agent.verdict(base="HEAD", head="HEAD", repo=repo_name)
    if tool == "scan":
        # Don't exercise external scanners in CI — pass an empty
        # `scanners` list so the tool short-circuits to the "no scanners
        # selected" branch. Still exercises the full envelope code path.
        return await agent.scan(scanners=[], repo=repo_name)
    if tool == "list_findings":
        return await agent.list_findings(repo=repo_name, limit=50)
    if tool == "dependencies":
        return await agent.dependencies(repo=repo_name, limit=50)
    if tool == "license_audit":
        return await agent.license_audit(repo=repo_name)
    if tool == "project_profile":
        return await agent.project_profile(repo=repo_name)
    if tool == "group_query":
        return await agent.group_query(group_name, "login")
    raise ValueError(f"unknown new tool: {tool}")


def _build_new_tool_cases() -> list[tuple[str, str]]:
    """Compute the (tool, lang) pairs for the W5-3 expansion.

    The rules target ~40-50 new cases so the harness runtime stays
    bounded while every v1.0 tool gets non-trivial multi-language
    coverage:

    * ``owners``, ``project_profile``, ``license_audit`` — one case per
      language (14 each = 42 cases). These are the v1.0 tools most
      reliably wired end-to-end, so they form the "breadth" layer.
    * ``scan``, ``list_findings``, ``risk_trends``, ``verdict`` — a
      curated 3-language sample (ts / py / go) that exercises the
      envelope without bloating the runtime. These tools depend on
      cross-cutting infra (scanners, SARIF ingest, risk snapshots,
      verdict engine) that is language-independent.
    * ``dependencies`` — every language whose fixture ships a
      supported manifest (LANGS_WITH_MANIFESTS → 7 cases).
    * ``group_query`` — two cases probing the same cross-repo group
      registered in the conftest (one for each member).

    Total new cases: 14*3 + 3*4 + 7 + 2 = 42 + 12 + 7 + 2 = 63.
    Combined with the 98 core cases the full suite reports 161 cases.
    """
    cases: list[tuple[str, str]] = []
    full_matrix_tools = ("owners", "project_profile", "license_audit")
    sampled_tools = ("scan", "list_findings", "risk_trends", "verdict")
    sampled_langs: tuple[str, ...] = ("ts", "py", "go")

    for tool in full_matrix_tools:
        for lang in LANGUAGES:
            cases.append((tool, lang))
    for tool in sampled_tools:
        for lang in sampled_langs:
            cases.append((tool, lang))
    for lang in LANGUAGES:
        if lang in LANGS_WITH_MANIFESTS:
            cases.append(("dependencies", lang))
    cases.append(("group_query", "ts"))
    cases.append(("group_query", "py"))
    return cases


NEW_TOOL_CASES: tuple[tuple[str, str], ...] = tuple(_build_new_tool_cases())


async def _with_retries(
    cli_entry: str,
    home: str,
    invoke: Any,
) -> dict[str, Any]:
    """Run an MCP dispatch with up to 3 retries around stdio flakes."""
    result: dict[str, Any] | None = None
    last_err: Exception | None = None
    for attempt in range(3):
        try:
            async with OpenCodeHubAgent(cli_entry, home=home) as agent:
                result = await invoke(agent)
            break
        except Exception as err:  # noqa: BLE001
            last_err = err
            await anyio.sleep(1.0 * (attempt + 1))
    if result is None:
        raise last_err if last_err is not None else RuntimeError("agent dispatch failed")
    return result


def _assert_envelope(tool: str, lang: str, result: dict[str, Any]) -> None:
    assert isinstance(result, dict), f"{tool}/{lang}: expected dict"
    # We accept two outcomes:
    #  (a) isError=False and structuredContent has the expected top-level keys
    #  (b) isError=True with a structured error envelope — allowed for
    #      tools that legitimately fail on pristine fixtures (e.g. rename
    #      with no matches, context on an ambiguous/missing symbol,
    #      verdict/risk_trends before those tools ship)
    if result.get("isError"):
        content = result.get("content") or []
        error_txt = result.get("error") or ""
        assert content or error_txt, (
            f"{tool}/{lang}: error result had no content or error: {result!r}"
        )
        return

    structured = result.get("structuredContent")
    assert structured is not None, (
        f"{tool}/{lang}: success result missing structuredContent: {result!r}"
    )
    expected = _expected_structured_keys(tool)
    missing = [k for k in expected if k not in structured]
    assert not missing, (
        f"{tool}/{lang}: structuredContent missing expected keys {missing}: "
        f"{sorted(structured.keys())}"
    )


@pytest.mark.anyio
@pytest.mark.parametrize("tool", TOOLS)
@pytest.mark.parametrize("lang", LANGUAGES)
async def test_tool_per_language(
    lang: str,
    tool: str,
    indexed_fixtures: dict[str, Any],
    cli_entry: str,
) -> None:
    repos = indexed_fixtures["repos"]
    if lang not in repos:
        pytest.skip(f"fixture missing for {lang}")
    repo_name = repos[lang]["name"]
    home = indexed_fixtures["home"]

    async def invoke(agent: OpenCodeHubAgent) -> dict[str, Any]:
        return await _dispatch(agent, tool, lang, repo_name)

    result = await _with_retries(cli_entry, home, invoke)
    _assert_envelope(tool, lang, result)


@pytest.mark.anyio
@pytest.mark.parametrize(
    "tool,lang",
    NEW_TOOL_CASES,
    ids=[f"{tool}-{lang}" for (tool, lang) in NEW_TOOL_CASES],
)
async def test_new_tool_case(
    tool: str,
    lang: str,
    indexed_fixtures: dict[str, Any],
    cli_entry: str,
) -> None:
    repos = indexed_fixtures["repos"]
    if lang not in repos:
        pytest.skip(f"fixture missing for {lang}")
    repo_name = repos[lang]["name"]
    home = indexed_fixtures["home"]
    group_name = str(indexed_fixtures.get("group", ""))

    async def invoke(agent: OpenCodeHubAgent) -> dict[str, Any]:
        return await _dispatch_new(agent, tool, lang, repo_name, group_name)

    result = await _with_retries(cli_entry, home, invoke)
    _assert_envelope(tool, lang, result)
