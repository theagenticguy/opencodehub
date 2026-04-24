"""Thin async wrapper around the official `mcp` Python SDK stdio client.

`OpenCodeHubAgent` spawns `node <cli_entry> mcp` as a subprocess, opens an
MCP `ClientSession` over its stdio, and exposes one async method per
OpenCodeHub tool. Each method forwards kwargs as the tool input and
returns the parsed `CallToolResult` serialised into a dict with the
shape ``{isError, structuredContent, content, _meta}``.

Designed for use as an async context manager:

    async with OpenCodeHubAgent(cli_entry, home=home) as agent:
        result = await agent.query("login", repo="fixture-ts")

The agent is deliberately tolerant: if a tool call raises (e.g. the
server returns an error envelope) the exception is caught and returned
as ``{"isError": True, "error": str(err), ...}`` so parametrized tests
can make per-case assertions instead of aborting the whole run.
"""

from __future__ import annotations

import os
from contextlib import AsyncExitStack
from pathlib import Path
from typing import Any

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


def _to_plain(obj: Any) -> Any:
    """Recursively coerce pydantic models / mcp types into plain dicts/lists."""
    if hasattr(obj, "model_dump"):
        return _to_plain(obj.model_dump())
    if isinstance(obj, dict):
        return {k: _to_plain(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_to_plain(v) for v in obj]
    return obj


class OpenCodeHubAgent:
    """MCP stdio client bound to `node <cli_entry> mcp`.

    Parameters
    ----------
    cli_entry
        Absolute path to the built CLI entry point (``packages/cli/dist/index.js``).
    home
        Optional override for ``$HOME`` passed to the child process. Tests use
        this to point the server at an isolated registry directory.
    extra_env
        Extra environment variables merged on top of ``os.environ``.
    """

    def __init__(
        self,
        cli_entry: str,
        *,
        home: str | None = None,
        extra_env: dict[str, str] | None = None,
    ) -> None:
        self._cli_entry = cli_entry
        self._home = home
        self._extra_env = dict(extra_env or {})
        self._stack: AsyncExitStack | None = None
        self._session: ClientSession | None = None

    async def __aenter__(self) -> "OpenCodeHubAgent":
        env = os.environ.copy()
        env.update(self._extra_env)
        if self._home is not None:
            env["HOME"] = self._home
        params = StdioServerParameters(
            command="node",
            args=[self._cli_entry, "mcp"],
            env=env,
        )
        # AsyncExitStack keeps both context managers in the same scope so
        # they unwind in LIFO order. Without this the stdio_client
        # cancel scope can outlive the ClientSession and trigger spurious
        # CancelledError when pytest tears down the test task.
        stack = AsyncExitStack()
        await stack.__aenter__()
        try:
            read, write = await stack.enter_async_context(stdio_client(params))
            session = await stack.enter_async_context(ClientSession(read, write))
            await session.initialize()
        except BaseException:
            await stack.aclose()
            raise
        self._stack = stack
        self._session = session
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        stack = self._stack
        self._session = None
        self._stack = None
        if stack is not None:
            try:
                await stack.__aexit__(exc_type, exc, tb)
            except (RuntimeError, Exception):
                # Swallow teardown-time errors — they are not actionable in
                # eval tests and masking them keeps the test result clean.
                pass

    async def list_tools(self) -> list[dict[str, Any]]:
        assert self._session is not None, "agent not entered"
        result = await self._session.list_tools()
        return [_to_plain(t) for t in result.tools]

    async def _call(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        assert self._session is not None, "agent not entered"
        try:
            result = await self._session.call_tool(name, arguments)
        except Exception as err:  # pragma: no cover — translated to test result
            return {
                "isError": True,
                "error": f"{type(err).__name__}: {err}",
                "structuredContent": None,
                "content": [],
                "_meta": None,
            }
        return {
            "isError": bool(getattr(result, "isError", False)),
            "structuredContent": _to_plain(getattr(result, "structuredContent", None)),
            "content": _to_plain(getattr(result, "content", [])),
            "_meta": _to_plain(getattr(result, "_meta", None)),
        }

    # --- 7 OpenCodeHub tools ------------------------------------------------

    async def list_repos(self) -> dict[str, Any]:
        return await self._call("list_repos", {})

    async def query(self, text: str, **kw: Any) -> dict[str, Any]:
        args: dict[str, Any] = {"query": text}
        args.update(kw)
        return await self._call("query", args)

    async def context(self, symbol: str, **kw: Any) -> dict[str, Any]:
        args: dict[str, Any] = {"symbol": symbol}
        args.update(kw)
        return await self._call("context", args)

    async def impact(self, target: str, **kw: Any) -> dict[str, Any]:
        args: dict[str, Any] = {"target": target}
        args.update(kw)
        return await self._call("impact", args)

    async def detect_changes(self, scope: str = "all", **kw: Any) -> dict[str, Any]:
        args: dict[str, Any] = {"scope": scope}
        args.update(kw)
        return await self._call("detect_changes", args)

    async def rename(
        self,
        symbol_name: str,
        new_name: str,
        dry_run: bool = True,
        **kw: Any,
    ) -> dict[str, Any]:
        args: dict[str, Any] = {
            "symbol_name": symbol_name,
            "new_name": new_name,
            "dry_run": dry_run,
        }
        args.update(kw)
        return await self._call("rename", args)

    async def sql(self, query: str, **kw: Any) -> dict[str, Any]:
        args: dict[str, Any] = {"sql": query}
        args.update(kw)
        return await self._call("sql", args)

    # --- v1.0 tools --------------------------------------------------------
    #
    # Each method wraps ``self._call`` exactly like the seven core tools
    # above. The kwargs merge lets callers pass tool-specific options
    # (e.g. ``scanners=[...]`` for ``scan``) without forcing the agent to
    # enumerate every MCP input parameter.
    #
    # NOTE: ``risk_trends`` and ``verdict`` may correspond to tools that
    # are unregistered in a given build. When the tool is not registered
    # the server returns an error envelope; ``_call`` folds that into
    # ``{"isError": True, ...}`` so the eval harness records a
    # non-blocking failure instead of crashing.

    async def owners(
        self,
        target: str,
        *,
        repo: str | None = None,
        limit: int | None = None,
    ) -> dict[str, Any]:
        args: dict[str, Any] = {"target": target}
        if repo is not None:
            args["repo"] = repo
        if limit is not None:
            args["limit"] = limit
        return await self._call("owners", args)

    async def risk_trends(self, *, repo: str | None = None) -> dict[str, Any]:
        args: dict[str, Any] = {}
        if repo is not None:
            args["repo"] = repo
        return await self._call("risk_trends", args)

    async def verdict(
        self,
        *,
        base: str | None = None,
        head: str | None = None,
        repo: str | None = None,
    ) -> dict[str, Any]:
        args: dict[str, Any] = {}
        if base is not None:
            args["base"] = base
        if head is not None:
            args["head"] = head
        if repo is not None:
            args["repo"] = repo
        return await self._call("verdict", args)

    async def scan(
        self,
        *,
        scanners: list[str] | None = None,
        repo: str | None = None,
        timeout_ms: int | None = None,
    ) -> dict[str, Any]:
        args: dict[str, Any] = {}
        if scanners is not None:
            args["scanners"] = scanners
        # MCP tool schema uses `repoPath` for scan/list_findings/license_audit/
        # project_profile but `repo` for owners/dependencies — honour each.
        if repo is not None:
            args["repoPath"] = repo
        if timeout_ms is not None:
            args["timeoutMs"] = timeout_ms
        return await self._call("scan", args)

    async def list_findings(
        self,
        *,
        severity: str | None = None,
        scanner: str | None = None,
        rule_id: str | None = None,
        file_path: str | None = None,
        limit: int | None = None,
        repo: str | None = None,
    ) -> dict[str, Any]:
        args: dict[str, Any] = {}
        if severity is not None:
            args["severity"] = severity
        if scanner is not None:
            args["scanner"] = scanner
        if rule_id is not None:
            args["ruleId"] = rule_id
        if file_path is not None:
            args["filePath"] = file_path
        if limit is not None:
            args["limit"] = limit
        if repo is not None:
            args["repoPath"] = repo
        return await self._call("list_findings", args)

    async def dependencies(
        self,
        *,
        file_path: str | None = None,
        ecosystem: str | None = None,
        limit: int | None = None,
        repo: str | None = None,
    ) -> dict[str, Any]:
        args: dict[str, Any] = {}
        if file_path is not None:
            args["filePath"] = file_path
        if ecosystem is not None:
            args["ecosystem"] = ecosystem
        if limit is not None:
            args["limit"] = limit
        if repo is not None:
            args["repo"] = repo
        return await self._call("dependencies", args)

    async def license_audit(self, *, repo: str | None = None) -> dict[str, Any]:
        args: dict[str, Any] = {}
        if repo is not None:
            args["repoPath"] = repo
        return await self._call("license_audit", args)

    async def project_profile(self, *, repo: str | None = None) -> dict[str, Any]:
        args: dict[str, Any] = {}
        if repo is not None:
            args["repoPath"] = repo
        return await self._call("project_profile", args)

    async def group_query(
        self,
        group_name: str,
        query: str,
        *,
        limit: int | None = None,
    ) -> dict[str, Any]:
        args: dict[str, Any] = {"groupName": group_name, "query": query}
        if limit is not None:
            args["limit"] = limit
        return await self._call("group_query", args)


def default_cli_entry() -> str:
    """Resolve the built CLI entry relative to the repo root."""
    here = Path(__file__).resolve()
    # src/opencodehub_eval/agent.py → packages/eval/src/opencodehub_eval
    # parents[3] is packages/eval; parents[4] is packages/.
    cli = here.parents[3] / "cli" / "dist" / "index.js"
    return str(cli)
