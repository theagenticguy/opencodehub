#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "pygls>=1.3",
#     "pyright>=1.1.390",
#     "duckdb>=1.1",
#     "rich>=13",
#     "PyYAML>=6",
# ]
# ///
"""
Pyright Oracle Spike (week-1, follow-up to the jedi spike).

Drives pyright-langserver directly over stdio (hand-rolled LSP client),
runs the SAME 15-symbol comparison as the previous spike-lsp-oracle.py,
and reports whether pyright is materially better than jedi on the sdk-python
sample.

Run:
    uv run scripts/spike-pyright-oracle.py

Why hand-rolled: pygls 1.x does not ship a first-class stdio LSP *client*.
The framing protocol is tiny (Content-Length headers + JSON body), so we
write it ourselves and keep total control of the wire.

Outputs:
    /tmp/spike-pyright-oracle-report.json   # full normalized data
    /tmp/spike-pyright-oracle-goldens.yaml  # auto-labeled golden callers
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import duckdb
import yaml
from rich.console import Console
from rich.panel import Panel
from rich.rule import Rule
from rich.table import Table

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SDK_PYTHON_PATH = Path("/Users/lalsaado/Projects/sdk-python")
GRAPH_DB_PATH = SDK_PYTHON_PATH / ".codehub" / "graph.duckdb"
REPORT_JSON = Path("/tmp/spike-pyright-oracle-report.json")
GOLDENS_YAML = Path("/tmp/spike-pyright-oracle-goldens.yaml")
JEDI_JSON = Path("/tmp/spike-lsp-oracle-report.json")

LINE_FUZZ = 2
INDEX_WAIT_CAP_S = 45.0  # hard ceiling; we also listen for $/progress end

console = Console()


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------


@dataclass
class Symbol:
    node_id: str
    kind: str
    name: str
    qualified: str
    file_path: str
    start_line: int
    end_line: int
    category: str

    @property
    def abs_path(self) -> Path:
        return SDK_PYTHON_PATH / self.file_path


@dataclass
class Reference:
    referrer_file: str
    referrer_line: int
    referrer_symbol: str | None

    def key(self) -> tuple[str, int]:
        return (self.referrer_file, self.referrer_line)


@dataclass
class SymbolResult:
    symbol: Symbol
    lsp_refs: list[Reference] = field(default_factory=list)
    lsp_impls: list[dict] = field(default_factory=list)
    lsp_callers: list[Reference] = field(default_factory=list)
    prepare_call_hierarchy_count: int = 0
    ast_refs: list[Reference] = field(default_factory=list)
    agreed: list[Reference] = field(default_factory=list)
    lsp_only: list[Reference] = field(default_factory=list)
    ast_only: list[Reference] = field(default_factory=list)
    query_latency_s: float = 0.0
    lsp_error: str | None = None

    lsp_only_labels: list[dict] = field(default_factory=list)
    ast_only_labels: list[dict] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Hand-rolled LSP JSON-RPC stdio client
# ---------------------------------------------------------------------------


class LspClient:
    """
    Minimal async LSP client. Speaks Content-Length framing over stdio with
    pyright-langserver. Multiplexes requests by id, buffers unrelated
    notifications into a queue so callers can wait on $/progress.
    """

    def __init__(self, proc: asyncio.subprocess.Process) -> None:
        self._proc = proc
        self._next_id = 0
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._notifications: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()
        self._requests_from_server: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._reader_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._closed = False

    async def start(self) -> None:
        self._reader_task = asyncio.create_task(self._read_loop())
        self._stderr_task = asyncio.create_task(self._drain_stderr())

    async def _drain_stderr(self) -> None:
        assert self._proc.stderr is not None
        while True:
            line = await self._proc.stderr.readline()
            if not line:
                return
            # Surface stderr only if it looks like an error/warning.
            text = line.decode("utf-8", errors="replace").rstrip()
            if "error" in text.lower() or "warn" in text.lower():
                # Keep it short.
                console.print(f"[dim]pyright.stderr:[/dim] {text[:200]}")

    async def _read_loop(self) -> None:
        assert self._proc.stdout is not None
        reader = self._proc.stdout
        while True:
            try:
                header = await reader.readuntil(b"\r\n\r\n")
            except asyncio.IncompleteReadError:
                return
            except Exception:
                return
            length = 0
            for raw in header.split(b"\r\n"):
                if raw.lower().startswith(b"content-length:"):
                    length = int(raw.split(b":", 1)[1].strip())
                    break
            if length == 0:
                continue
            body = await reader.readexactly(length)
            try:
                msg = json.loads(body.decode("utf-8"))
            except Exception:
                continue
            await self._dispatch(msg)

    async def _dispatch(self, msg: dict[str, Any]) -> None:
        # Response (has id + result/error, no method).
        if "id" in msg and "method" not in msg:
            fut = self._pending.pop(msg["id"], None)
            if fut and not fut.done():
                if "error" in msg:
                    fut.set_exception(RuntimeError(json.dumps(msg["error"])))
                else:
                    fut.set_result(msg.get("result"))
            return
        # Request from server (needs a response).
        if "id" in msg and "method" in msg:
            await self._requests_from_server.put(msg)
            # Auto-ack common server->client requests so pyright doesn't block.
            method = msg["method"]
            if method in (
                "workspace/configuration",
                "window/workDoneProgress/create",
                "client/registerCapability",
                "client/unregisterCapability",
            ):
                result: Any
                if method == "workspace/configuration":
                    # Return one config object per requested item. Empty dict
                    # is fine; pyright falls back to initializationOptions.
                    params = msg.get("params", {}) or {}
                    items = params.get("items", []) or []
                    result = [self._workspace_config_for(i) for i in items]
                else:
                    result = None
                await self._send_raw(
                    {"jsonrpc": "2.0", "id": msg["id"], "result": result}
                )
            return
        # Notification.
        method = msg.get("method")
        if method:
            await self._notifications.put((method, msg.get("params")))

    def _workspace_config_for(self, item: dict[str, Any]) -> dict[str, Any]:
        section = (item or {}).get("section", "") or ""
        if section.startswith("python.analysis"):
            return {
                "autoSearchPaths": True,
                "useLibraryCodeForTypes": True,
                "diagnosticMode": "workspace",
                "extraPaths": ["src"],
            }
        if section == "python":
            return {"pythonPath": sys.executable}
        return {}

    async def _send_raw(self, msg: dict[str, Any]) -> None:
        body = json.dumps(msg).encode("utf-8")
        header = f"Content-Length: {len(body)}\r\n\r\n".encode("ascii")
        assert self._proc.stdin is not None
        self._proc.stdin.write(header + body)
        await self._proc.stdin.drain()

    async def request(self, method: str, params: Any) -> Any:
        self._next_id += 1
        rid = self._next_id
        fut: asyncio.Future[Any] = asyncio.get_event_loop().create_future()
        self._pending[rid] = fut
        await self._send_raw(
            {"jsonrpc": "2.0", "id": rid, "method": method, "params": params}
        )
        return await asyncio.wait_for(fut, timeout=60.0)

    async def notify(self, method: str, params: Any) -> None:
        await self._send_raw({"jsonrpc": "2.0", "method": method, "params": params})

    async def wait_for_notification(
        self, method: str, timeout: float
    ) -> tuple[str, Any] | None:
        deadline = asyncio.get_event_loop().time() + timeout
        while True:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                return None
            try:
                m, p = await asyncio.wait_for(
                    self._notifications.get(), timeout=remaining
                )
            except asyncio.TimeoutError:
                return None
            if m == method:
                return (m, p)

    async def wait_for_progress_end(self, timeout: float) -> bool:
        """
        Wait until we see at least one $/progress with value.kind == 'end',
        OR the timeout expires. Returns True if an end marker was seen.
        """
        deadline = asyncio.get_event_loop().time() + timeout
        saw_any = False
        while True:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                return saw_any
            try:
                m, p = await asyncio.wait_for(
                    self._notifications.get(), timeout=remaining
                )
            except asyncio.TimeoutError:
                return saw_any
            if m == "$/progress":
                saw_any = True
                value = (p or {}).get("value") or {}
                if value.get("kind") == "end":
                    return True

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            await asyncio.wait_for(self.request("shutdown", None), timeout=5.0)
        except Exception:
            pass
        try:
            await self.notify("exit", None)
        except Exception:
            pass
        if self._reader_task:
            self._reader_task.cancel()
        if self._stderr_task:
            self._stderr_task.cancel()
        try:
            await asyncio.wait_for(self._proc.wait(), timeout=5.0)
        except Exception:
            try:
                self._proc.kill()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Pyright launch
# ---------------------------------------------------------------------------


async def launch_pyright() -> tuple[LspClient, str, str]:
    """
    Try to launch pyright-langserver. Returns (client, launch_mode,
    pyright_version_string).

    Tries in order:
      1. `pyright-langserver --stdio` from PATH (works if PyPI pyright
         previously ran a wrapper so the bundled binary is cached).
      2. `uvx --from pyright==1.1.390 pyright-langserver --stdio` (forces
         uv to install into an isolated tool cache).
    """
    attempts: list[list[str]] = []
    if shutil.which("pyright-langserver"):
        attempts.append(["pyright-langserver", "--stdio"])
    attempts.append(
        ["uvx", "--from", "pyright==1.1.390", "pyright-langserver", "--stdio"]
    )

    last_err: Exception | None = None
    for argv in attempts:
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env={**os.environ, "PYTHONIOENCODING": "utf-8"},
            )
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            continue
        # Give it a moment; if it exited immediately with something on stderr,
        # surface that.
        await asyncio.sleep(0.3)
        if proc.returncode is not None:
            stderr = (
                (await proc.stderr.read()).decode("utf-8", errors="replace")
                if proc.stderr
                else ""
            )
            last_err = RuntimeError(
                f"{argv[0]} exited immediately (rc={proc.returncode}): {stderr[:400]}"
            )
            continue
        client = LspClient(proc)
        await client.start()
        # Resolve version independently — use whichever argv variant worked.
        try:
            if argv[0] == "uvx":
                version = subprocess.check_output(
                    ["uvx", "--from", "pyright==1.1.390", "pyright", "--version"],
                    text=True,
                    stderr=subprocess.STDOUT,
                ).strip()
            else:
                version = subprocess.check_output(
                    ["pyright", "--version"], text=True, stderr=subprocess.STDOUT
                ).strip()
        except Exception:
            version = "unknown"
        return client, " ".join(argv), version

    raise RuntimeError(
        f"Could not launch pyright-langserver. Last error: {last_err}. "
        "Hint: run `uvx --from pyright==1.1.390 pyright --version` once manually "
        "so pyright's Node bundle lands in ~/.cache/pyright-python/."
    )


# ---------------------------------------------------------------------------
# Step 1: symbol sample (same 15 as jedi spike)
# ---------------------------------------------------------------------------


def pick_symbols(db: duckdb.DuckDBPyConnection) -> list[Symbol]:
    symbols: list[Symbol] = []

    def _add(nid: str, qualified: str, category: str) -> None:
        row = db.execute(
            "SELECT id, kind, name, file_path, start_line, end_line FROM nodes WHERE id = ?",
            [nid],
        ).fetchone()
        if row:
            symbols.append(
                Symbol(
                    node_id=row[0],
                    kind=row[1],
                    name=row[2],
                    qualified=qualified,
                    file_path=row[3],
                    start_line=row[4],
                    end_line=row[5],
                    category=category,
                )
            )

    for nid in [
        "Class:src/strands/agent/agent.py:Agent",
        "Class:src/strands/models/bedrock.py:BedrockModel",
        "Class:src/strands/agent/conversation_manager/conversation_manager.py:ConversationManager",
    ]:
        _add(nid, nid.split(":")[-1], "class")

    for nid, q in [
        ("Method:src/strands/agent/agent.py:Agent.invoke_async", "Agent.invoke_async"),
        ("Method:src/strands/agent/agent.py:Agent.stream_async", "Agent.stream_async"),
        (
            "Method:src/strands/agent/agent.py:Agent.structured_output_async",
            "Agent.structured_output_async",
        ),
        (
            "Method:src/strands/agent/conversation_manager/sliding_window_conversation_manager.py:SlidingWindowConversationManager.reduce_context",
            "SlidingWindowConversationManager.reduce_context",
        ),
    ]:
        _add(nid, q, "async_method")

    for nid in [
        "Property:src/strands/agent/agent_result.py:AgentResult.message",
        "Property:src/strands/agent/agent_result.py:AgentResult.metrics",
        "Property:src/strands/agent/agent_result.py:AgentResult.stop_reason",
    ]:
        _add(nid, nid.split(":")[-1], "property")

    for nid, q in [
        ("Method:src/strands/agent/agent.py:Agent.__init__", "Agent.__init__"),
        ("Method:src/strands/models/bedrock.py:BedrockModel.__init__", "BedrockModel.__init__"),
    ]:
        _add(nid, q, "ctor")

    rows = db.execute(
        """
        SELECT n.id, n.kind, n.name, n.file_path, n.start_line, n.end_line, COUNT(r.id) AS n_incoming
        FROM nodes n
        JOIN relations r ON r.to_id = n.id AND r.type = 'CALLS'
        WHERE n.kind IN ('Method', 'Function')
          AND n.name LIKE '\\_%' ESCAPE '\\'
          AND n.file_path LIKE 'src/strands/%'
          AND NOT n.file_path LIKE '%experimental%'
        GROUP BY n.id, n.kind, n.name, n.file_path, n.start_line, n.end_line
        ORDER BY n_incoming DESC
        LIMIT 3
        """
    ).fetchall()
    for row in rows:
        symbols.append(
            Symbol(
                node_id=row[0],
                kind=row[1],
                name=row[2],
                qualified=row[0].split(":")[-1],
                file_path=row[3],
                start_line=row[4],
                end_line=row[5],
                category="private",
            )
        )

    return symbols


# ---------------------------------------------------------------------------
# Step 2: AST reference extraction
# ---------------------------------------------------------------------------


RELEVANT_AST_EDGE_TYPES = (
    "CALLS",
    "REFERENCES",
    "ACCESSES",
    "EXTENDS",
    "IMPLEMENTS",
    "METHOD_OVERRIDES",
)


def ast_references_for(db: duckdb.DuckDBPyConnection, sym: Symbol) -> list[Reference]:
    edge_list = ",".join(f"'{t}'" for t in RELEVANT_AST_EDGE_TYPES)
    rows = db.execute(
        f"""
        SELECT n.id, n.file_path, n.start_line
        FROM relations r
        JOIN nodes n ON r.from_id = n.id
        WHERE r.to_id = ?
          AND r.type IN ({edge_list})
        """,
        [sym.node_id],
    ).fetchall()
    refs: list[Reference] = []
    for node_id, file_path, start_line in rows:
        if file_path is None or start_line is None:
            continue
        refs.append(
            Reference(
                referrer_file=file_path,
                referrer_line=int(start_line),
                referrer_symbol=node_id,
            )
        )
    return refs


def enclosing_node_for(
    db: duckdb.DuckDBPyConnection, file_rel: str, line: int
) -> str | None:
    row = db.execute(
        """
        SELECT id, start_line, end_line
        FROM nodes
        WHERE file_path = ?
          AND start_line IS NOT NULL AND end_line IS NOT NULL
          AND start_line <= ? AND end_line >= ?
          AND kind IN ('Method', 'Function', 'Class', 'Property', 'Const', 'Variable')
        ORDER BY (end_line - start_line) ASC
        LIMIT 1
        """,
        [file_rel, line, line],
    ).fetchone()
    return row[0] if row else None


# ---------------------------------------------------------------------------
# Step 3: name-token position lookup
# ---------------------------------------------------------------------------


def find_symbol_position(sym: Symbol) -> tuple[int, int] | None:
    try:
        text = sym.abs_path.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return None
    lines = text.splitlines()
    start0 = max(0, sym.start_line - 1)
    end0 = min(len(lines), sym.start_line + 4)
    for li in range(start0, end0):
        line = lines[li]
        col = line.find(sym.name)
        if col == -1:
            continue
        after = col + len(sym.name)
        before_char = line[col - 1] if col > 0 else " "
        after_char = line[after] if after < len(line) else " "
        if (before_char.isalnum() or before_char == "_") or (
            after_char.isalnum() or after_char == "_"
        ):
            continue
        return (li, col)
    return None


def uri_to_path(uri: str) -> str:
    if uri.startswith("file://"):
        return uri[len("file://") :]
    return uri


# ---------------------------------------------------------------------------
# Step 4: pyright-driven queries
# ---------------------------------------------------------------------------


async def run_pyright_queries(
    client: LspClient, symbols: list[Symbol]
) -> tuple[dict[str, SymbolResult], dict[str, float]]:
    results: dict[str, SymbolResult] = {
        s.node_id: SymbolResult(symbol=s) for s in symbols
    }
    timings: dict[str, float] = {}

    # Open each target file once.
    opened: set[str] = set()

    async def ensure_open(sym: Symbol) -> None:
        if sym.file_path in opened:
            return
        try:
            text = sym.abs_path.read_text(encoding="utf-8", errors="replace")
        except FileNotFoundError:
            return
        await client.notify(
            "textDocument/didOpen",
            {
                "textDocument": {
                    "uri": sym.abs_path.as_uri(),
                    "languageId": "python",
                    "version": 1,
                    "text": text,
                }
            },
        )
        opened.add(sym.file_path)

    for sym in symbols:
        res = results[sym.node_id]
        await ensure_open(sym)
        pos = find_symbol_position(sym)
        if pos is None:
            res.lsp_error = f"could not locate name token for {sym.qualified}"
            console.print(f"  [yellow]skip[/yellow] {sym.qualified}: {res.lsp_error}")
            continue
        line, col = pos
        uri = sym.abs_path.as_uri()
        text_doc_pos = {
            "textDocument": {"uri": uri},
            "position": {"line": line, "character": col},
        }

        t0 = time.perf_counter()
        refs_resp: Any = None
        impl_resp: Any = None
        prep_resp: Any = None
        incoming_resp: Any = None
        errs: list[str] = []

        async def _safe(method: str, params: Any) -> Any:
            try:
                return await client.request(method, params)
            except Exception as exc:  # noqa: BLE001
                errs.append(f"{method}: {exc}")
                return None

        # Run references + implementation in parallel.
        refs_task = _safe(
            "textDocument/references",
            {"context": {"includeDeclaration": False}, **text_doc_pos},
        )
        impl_task = _safe("textDocument/implementation", text_doc_pos)
        prep_task = _safe("textDocument/prepareCallHierarchy", text_doc_pos)
        refs_resp, impl_resp, prep_resp = await asyncio.gather(
            refs_task, impl_task, prep_task
        )

        if prep_resp:
            res.prepare_call_hierarchy_count = len(prep_resp)
            first_item = prep_resp[0]
            incoming_resp = await _safe(
                "callHierarchy/incomingCalls", {"item": first_item}
            )

        dt = time.perf_counter() - t0
        timings[sym.node_id] = dt
        res.query_latency_s = dt
        if errs:
            res.lsp_error = "; ".join(errs)[:300]

        # Normalize.
        for item in refs_resp or []:
            file_abs = uri_to_path(item.get("uri", ""))
            try:
                file_rel = str(Path(file_abs).relative_to(SDK_PYTHON_PATH))
            except ValueError:
                continue
            line_ = int(item["range"]["start"]["line"]) + 1
            res.lsp_refs.append(
                Reference(referrer_file=file_rel, referrer_line=line_, referrer_symbol=None)
            )

        for item in impl_resp or []:
            res.lsp_impls.append(
                {
                    "uri": item.get("uri"),
                    "line": (item.get("range") or {}).get("start", {}).get("line"),
                }
            )

        for call in incoming_resp or []:
            caller = call.get("from", {})
            file_abs = uri_to_path(caller.get("uri", ""))
            try:
                file_rel = str(Path(file_abs).relative_to(SDK_PYTHON_PATH))
            except ValueError:
                continue
            sel = caller.get("selectionRange") or caller.get("range") or {}
            line_ = int((sel.get("start") or {}).get("line", 0)) + 1
            res.lsp_callers.append(
                Reference(
                    referrer_file=file_rel,
                    referrer_line=line_,
                    referrer_symbol=caller.get("name"),
                )
            )

        console.print(
            f"  [green]ok  [/green] {sym.qualified:70s}"
            f" refs={len(res.lsp_refs):4d} callers={len(res.lsp_callers):3d}"
            f" impls={len(res.lsp_impls):2d}  prep={res.prepare_call_hierarchy_count}"
            f"  {dt:5.2f}s"
        )

    return results, timings


# ---------------------------------------------------------------------------
# Step 5: disagreement
# ---------------------------------------------------------------------------


def compute_disagreements(
    db: duckdb.DuckDBPyConnection, res: SymbolResult
) -> None:
    ast_by_file: dict[str, list[Reference]] = {}
    for r in res.ast_refs:
        ast_by_file.setdefault(r.referrer_file, []).append(r)

    lsp_by_file: dict[str, list[Reference]] = {}
    for r in res.lsp_refs:
        lsp_by_file.setdefault(r.referrer_file, []).append(r)

    matched_ast: set[tuple[str, int]] = set()
    matched_lsp: set[tuple[str, int]] = set()

    for file_rel, lsp_refs in lsp_by_file.items():
        ast_candidates = ast_by_file.get(file_rel, [])
        for lref in lsp_refs:
            best = None
            for aref in ast_candidates:
                if (aref.referrer_file, aref.referrer_line) in matched_ast:
                    continue
                if abs(aref.referrer_line - lref.referrer_line) <= LINE_FUZZ:
                    best = aref
                    break
            if best is not None:
                matched_ast.add((best.referrer_file, best.referrer_line))
                matched_lsp.add((lref.referrer_file, lref.referrer_line))
                res.agreed.append(lref)

    for lref in res.lsp_refs:
        if (lref.referrer_file, lref.referrer_line) in matched_lsp:
            continue
        enc = enclosing_node_for(db, lref.referrer_file, lref.referrer_line)
        res.lsp_only.append(
            Reference(
                referrer_file=lref.referrer_file,
                referrer_line=lref.referrer_line,
                referrer_symbol=enc,
            )
        )
    for aref in res.ast_refs:
        if (aref.referrer_file, aref.referrer_line) in matched_ast:
            continue
        res.ast_only.append(aref)


# ---------------------------------------------------------------------------
# Step 6: labeler (copied from jedi spike)
# ---------------------------------------------------------------------------


def _read_line(file_rel: str, line: int) -> str:
    try:
        with (SDK_PYTHON_PATH / file_rel).open("r", encoding="utf-8", errors="replace") as f:
            for idx, raw in enumerate(f, start=1):
                if idx == line:
                    return raw.rstrip("\n")
        return ""
    except FileNotFoundError:
        return ""


def _read_lines_range(file_rel: str, start: int, end: int) -> list[str]:
    try:
        with (SDK_PYTHON_PATH / file_rel).open("r", encoding="utf-8", errors="replace") as f:
            out = []
            for idx, raw in enumerate(f, start=1):
                if idx > end:
                    break
                if idx >= start:
                    out.append(raw.rstrip("\n"))
            return out
    except FileNotFoundError:
        return []


def _ast_body_contains_call(
    db: duckdb.DuckDBPyConnection, file_rel: str, referrer_line: int, sym: Symbol
) -> tuple[bool, str, int | None]:
    enc_row = db.execute(
        """
        SELECT id, kind, start_line, end_line
        FROM nodes
        WHERE file_path = ?
          AND start_line IS NOT NULL AND end_line IS NOT NULL
          AND start_line <= ? AND end_line >= ?
          AND kind IN ('Method', 'Function', 'Class', 'Property')
        ORDER BY (end_line - start_line) ASC
        LIMIT 1
        """,
        [file_rel, referrer_line, referrer_line],
    ).fetchone()
    if not enc_row:
        return (False, "no enclosing node resolved", None)

    _id, _kind, enc_start, enc_end = enc_row
    lines = _read_lines_range(file_rel, enc_start, enc_end)
    if not lines:
        return (False, "could not read source range", None)

    name = sym.name
    patterns_call = [
        f".{name}(",
        f" {name}(",
        f"({name}(",
        f"[{name}(",
        f",{name}(",
        f"={name}(",
    ]
    patterns_access = [f".{name}"] if sym.category == "property" else []

    for i, ln in enumerate(lines, start=enc_start):
        stripped = ln.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if ln.lstrip().startswith(f"{name}(") or any(p in ln for p in patterns_call):
            return (True, f"call expression `{name}(` found at line {i}", i)
        if (
            sym.category == "class"
            and stripped.startswith("class ")
            and "(" in stripped
            and name in stripped.split("(", 1)[1]
        ):
            return (True, f"subclass declaration `{stripped}` at line {i}", i)
        if patterns_access and any(p in ln for p in patterns_access) and f"{name}(" not in ln:
            return (True, f"attribute access `.{name}` at line {i}", i)
        if sym.category == "class":
            if (
                f": {name}" in ln
                or f"[{name}]" in ln
                or f"({name})" in ln
                or f" {name}," in ln
            ):
                return (True, f"type/isinstance reference at line {i}", i)

    return (False, f"name `{name}` never appears inside enclosing node body", None)


def _is_real_call_line(src_line: str, sym: Symbol) -> tuple[bool, str]:
    name = sym.name
    stripped = src_line.strip()

    if not name or name not in src_line:
        return (False, "name does not appear on the line (possible line-fuzz artifact)")

    if (
        stripped.startswith(f"def {name}(")
        or stripped.startswith(f"async def {name}(")
        or stripped.startswith(f"class {name}(")
        or stripped.startswith(f"class {name}:")
    ):
        return (False, "definition site, not a caller")

    if stripped.startswith("from ") or stripped.startswith("import "):
        return (False, "import statement, not a call")

    if sym.category == "class" and (
        stripped.startswith("class ") and "(" in stripped and name in stripped.split("(", 1)[1]
    ):
        return (True, f"subclass declaration referencing {name}")

    call_substrings = [
        f".{name}(",
        f" {name}(",
        f"({name}(",
        f"[{name}(",
        f",{name}(",
        f"={name}(",
    ]
    if any(cs in src_line for cs in call_substrings) or src_line.lstrip().startswith(f"{name}("):
        if stripped.startswith("#"):
            return (False, "inside a comment")
        return (True, f"call expression `{name}(` on the line")

    if sym.category == "property" and f".{name}" in src_line and f"{name}(" not in src_line:
        return (True, f"attribute access `.{name}` (property getter)")

    if re.search(rf"\b{re.escape(name)}\s*=", src_line):
        return (True, f"keyword-argument / field reference `{name}=` on the line")

    if (f"'{name}'" in src_line or f'"{name}"' in src_line) and f"{name}(" not in src_line:
        return (False, "appears only inside a string literal (e.g. log message)")

    if ":" in stripped and name in stripped.split(":", 1)[1] and f"{name}(" not in src_line:
        return (True, f"type annotation referencing {name}")

    return (False, "name appears but no clear call/access pattern identified")


def label_samples(db: duckdb.DuckDBPyConnection, res: SymbolResult, k: int = 5) -> None:
    for ref in res.lsp_only[:k]:
        src_line = _read_line(ref.referrer_file, ref.referrer_line)
        real, reason = _is_real_call_line(src_line, res.symbol)
        res.lsp_only_labels.append(
            {
                "file": ref.referrer_file,
                "line": ref.referrer_line,
                "enclosing": ref.referrer_symbol,
                "src": src_line,
                "likely_real_caller": real,
                "reason": reason,
            }
        )
    for ref in res.ast_only[:k]:
        real, reason, call_line = _ast_body_contains_call(
            db, ref.referrer_file, ref.referrer_line, res.symbol
        )
        src_line = _read_line(ref.referrer_file, call_line) if call_line else _read_line(
            ref.referrer_file, ref.referrer_line
        )
        res.ast_only_labels.append(
            {
                "file": ref.referrer_file,
                "line": call_line if call_line else ref.referrer_line,
                "def_line": ref.referrer_line,
                "enclosing": ref.referrer_symbol,
                "src": src_line,
                "likely_real_caller": real,
                "reason": reason,
            }
        )


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def render_environment(
    py_version: str,
    pyright_version: str,
    launch_mode: str,
    venv_path: str,
    symbols: list[Symbol],
    sdk_head: str,
) -> None:
    t = Table(title="Environment", show_header=False, box=None)
    t.add_column(justify="right", style="bold cyan")
    t.add_column()
    t.add_row("Target repo", str(SDK_PYTHON_PATH))
    t.add_row("Target HEAD", sdk_head)
    t.add_row("Graph DB", str(GRAPH_DB_PATH))
    t.add_row("Python runtime", py_version)
    t.add_row("LSP backend", f"pyright-langserver ({pyright_version})")
    t.add_row("Launch mode", launch_mode)
    t.add_row("sdk-python venv", venv_path)
    t.add_row("Symbols in sample", str(len(symbols)))
    console.print(t)


def render_sample(symbols: list[Symbol]) -> None:
    t = Table(title="Symbol sample", show_lines=False)
    t.add_column("#")
    t.add_column("category", style="magenta")
    t.add_column("qualified")
    t.add_column("file:line", style="dim")
    for i, s in enumerate(symbols, 1):
        t.add_row(str(i), s.category, s.qualified, f"{s.file_path}:{s.start_line}")
    console.print(t)


def render_capability_matrix(results: list[SymbolResult]) -> None:
    any_refs = sum(1 for r in results if r.lsp_refs)
    any_impls = sum(1 for r in results if r.lsp_impls)
    any_prep = sum(1 for r in results if r.prepare_call_hierarchy_count > 0)
    any_incoming = sum(1 for r in results if r.lsp_callers)
    total_refs = sum(len(r.lsp_refs) for r in results)
    total_impls = sum(len(r.lsp_impls) for r in results)
    total_prep = sum(r.prepare_call_hierarchy_count for r in results)
    total_incoming = sum(len(r.lsp_callers) for r in results)
    t = Table(title="Capability matrix (pyright)")
    t.add_column("query")
    t.add_column("symbols non-zero", justify="right")
    t.add_column("total items", justify="right")
    t.add_row("textDocument/references", f"{any_refs}/{len(results)}", str(total_refs))
    t.add_row(
        "textDocument/implementation",
        f"{any_impls}/{len(results)}",
        str(total_impls),
    )
    t.add_row(
        "prepareCallHierarchy",
        f"{any_prep}/{len(results)}",
        str(total_prep),
    )
    t.add_row(
        "callHierarchy/incomingCalls",
        f"{any_incoming}/{len(results)}",
        str(total_incoming),
    )
    console.print(t)


def render_per_symbol(results: list[SymbolResult]) -> None:
    t = Table(title="Per-symbol counts")
    t.add_column("symbol")
    t.add_column("cat", style="magenta")
    t.add_column("py_refs", justify="right", style="cyan")
    t.add_column("py_impls", justify="right", style="cyan")
    t.add_column("py_prep", justify="right", style="cyan")
    t.add_column("py_calls", justify="right", style="cyan")
    t.add_column("ast_refs", justify="right", style="cyan")
    t.add_column("agreed", justify="right", style="green")
    t.add_column("lsp_only", justify="right", style="yellow")
    t.add_column("ast_only", justify="right", style="red")
    for r in results:
        t.add_row(
            r.symbol.qualified,
            r.symbol.category,
            str(len(r.lsp_refs)),
            str(len(r.lsp_impls)),
            str(r.prepare_call_hierarchy_count),
            str(len(r.lsp_callers)),
            str(len(r.ast_refs)),
            str(len(r.agreed)),
            str(len(r.lsp_only)),
            str(len(r.ast_only)),
        )
    console.print(t)


def render_jedi_diff(results: list[SymbolResult]) -> dict[str, Any]:
    """Load the jedi report and compute per-symbol deltas."""
    if not JEDI_JSON.exists():
        console.print(f"[yellow]no jedi report at {JEDI_JSON}, skipping diff[/yellow]")
        return {}
    jedi_blob = json.loads(JEDI_JSON.read_text())
    jedi_by_id = {s["node_id"]: s for s in jedi_blob.get("symbols", [])}

    t = Table(title="pyright vs jedi (same 15 symbols)")
    t.add_column("symbol")
    t.add_column("jedi_refs", justify="right", style="cyan")
    t.add_column("py_refs", justify="right", style="cyan")
    t.add_column("delta", justify="right", style="bold")
    t.add_column("jedi_calls", justify="right", style="cyan")
    t.add_column("py_calls", justify="right", style="bold green")
    t.add_column("jedi_impls", justify="right", style="cyan")
    t.add_column("py_impls", justify="right", style="cyan")

    total_delta = 0
    rows: list[dict[str, Any]] = []
    for r in results:
        j = jedi_by_id.get(r.symbol.node_id)
        if not j:
            continue
        j_refs = len(j.get("lsp_refs", []))
        j_calls = len(j.get("lsp_callers", []))
        j_impls = len(j.get("lsp_impls", []))
        p_refs = len(r.lsp_refs)
        p_calls = len(r.lsp_callers)
        p_impls = len(r.lsp_impls)
        delta = p_refs - j_refs
        total_delta += delta
        delta_str = f"{delta:+d}"
        t.add_row(
            r.symbol.qualified,
            str(j_refs),
            str(p_refs),
            delta_str,
            str(j_calls),
            str(p_calls),
            str(j_impls),
            str(p_impls),
        )
        rows.append(
            {
                "symbol": r.symbol.qualified,
                "jedi_refs": j_refs,
                "py_refs": p_refs,
                "delta_refs": delta,
                "jedi_calls": j_calls,
                "py_calls": p_calls,
                "jedi_impls": j_impls,
                "py_impls": p_impls,
            }
        )
    console.print(t)

    jedi_totals = {
        "refs": sum(len(s.get("lsp_refs", [])) for s in jedi_blob["symbols"]),
        "calls": sum(len(s.get("lsp_callers", [])) for s in jedi_blob["symbols"]),
        "impls": sum(len(s.get("lsp_impls", [])) for s in jedi_blob["symbols"]),
    }
    py_totals = {
        "refs": sum(len(r.lsp_refs) for r in results),
        "calls": sum(len(r.lsp_callers) for r in results),
        "impls": sum(len(r.lsp_impls) for r in results),
    }
    summary = Table(title="Totals", show_header=False, box=None)
    summary.add_column(justify="right", style="bold cyan")
    summary.add_column()
    summary.add_row("jedi total refs", str(jedi_totals["refs"]))
    summary.add_row("pyright total refs", str(py_totals["refs"]))
    summary.add_row(
        "Δ refs",
        f"{py_totals['refs'] - jedi_totals['refs']:+d}  "
        f"({(py_totals['refs'] - jedi_totals['refs']) / max(1, jedi_totals['refs']):+.1%})",
    )
    summary.add_row("jedi total incomingCalls", str(jedi_totals["calls"]))
    summary.add_row("pyright total incomingCalls", str(py_totals["calls"]))
    summary.add_row("jedi total impls", str(jedi_totals["impls"]))
    summary.add_row("pyright total impls", str(py_totals["impls"]))
    console.print(summary)

    return {
        "rows": rows,
        "jedi_totals": jedi_totals,
        "pyright_totals": py_totals,
    }


def render_wallclock(cold_start_s: float, per_query: list[float], total_s: float) -> None:
    avg = sum(per_query) / len(per_query) if per_query else 0.0
    t = Table(title="Wall clock", show_header=False, box=None)
    t.add_column(justify="right", style="bold cyan")
    t.add_column()
    t.add_row("Pyright cold start (init→ready)", f"{cold_start_s:.2f}s")
    t.add_row(
        "Avg per-symbol latency", f"{avg:.2f}s  (n={len(per_query)})"
    )
    if per_query:
        p95 = sorted(per_query)[max(0, int(len(per_query) * 0.95) - 1)]
        t.add_row("p95 per-symbol latency", f"{p95:.2f}s")
    t.add_row("Total spike time", f"{total_s:.2f}s")
    console.print(t)


def render_labels(results: list[SymbolResult]) -> None:
    lsp_only_real: list[str] = []
    ast_only_real: list[str] = []
    confused: list[str] = []

    for r in results:
        for lab in r.lsp_only_labels:
            tag = f"{r.symbol.qualified} @ {lab['file']}:{lab['line']} — {lab['reason']}"
            if lab["likely_real_caller"]:
                lsp_only_real.append(tag)
            elif lab["reason"] in (
                "import statement, not a call",
                "definition site, not a caller",
            ):
                pass
            else:
                confused.append(f"LSP false positive: {tag}")
        for lab in r.ast_only_labels:
            tag = f"{r.symbol.qualified} @ {lab['file']}:{lab['line']} — {lab['reason']}"
            if lab["likely_real_caller"]:
                ast_only_real.append(tag)
            else:
                confused.append(f"AST false positive: {tag}")

    console.print(Rule("[bold]Disagreement analysis (auto-labeled)[/bold]"))

    def _panel(title: str, items: list[str], color: str) -> None:
        body = "\n".join(f"- {x}" for x in items[:15]) if items else "(none)"
        console.print(Panel(body, title=title, border_style=color))

    _panel("lsp_only_real  (pyright found, AST missed — real refs)", lsp_only_real, "yellow")
    _panel("ast_only_real  (AST found, pyright missed — real refs)", ast_only_real, "red")
    _panel("confused      (at least one side was a false positive)", confused, "dim")


def render_rollup(
    db: duckdb.DuckDBPyConnection, results: list[SymbolResult]
) -> tuple[float, float, float, float]:
    total_lsp = sum(len(r.lsp_refs) for r in results)
    total_ast = sum(len(r.ast_refs) for r in results)
    total_agreed = sum(len(r.agreed) for r in results)
    total_lsp_only = sum(len(r.lsp_only) for r in results)
    total_ast_only = sum(len(r.ast_only) for r in results)

    denom = max(1, total_lsp + total_ast - total_agreed)
    agreement_rate = total_agreed / denom

    def _enclosing_set_ast(r: SymbolResult) -> set[str]:
        return {a.referrer_symbol for a in r.ast_refs if a.referrer_symbol}

    def _enclosing_set_lsp(r: SymbolResult) -> set[str]:
        s: set[str] = set()
        for ref in r.lsp_refs:
            enc = enclosing_node_for(db, ref.referrer_file, ref.referrer_line)
            if enc:
                s.add(enc)
        return s

    union_size = 0
    inter_size = 0
    for r in results:
        ast_set = _enclosing_set_ast(r)
        lsp_set = _enclosing_set_lsp(r)
        inter_size += len(ast_set & lsp_set)
        union_size += len(ast_set | lsp_set)
    enc_agreement = inter_size / union_size if union_size else 0.0

    ast_samples = sum(len(r.ast_only_labels) for r in results)
    ast_false_positives = sum(
        1 for r in results for l in r.ast_only_labels if not l["likely_real_caller"]
    )
    ast_fp_rate = ast_false_positives / ast_samples if ast_samples else 0.0

    def _lsp_counts_as_signal(lab: dict) -> bool:
        return lab["reason"] not in (
            "import statement, not a call",
            "definition site, not a caller",
        )

    lsp_signal_samples = sum(
        1 for r in results for l in r.lsp_only_labels if _lsp_counts_as_signal(l)
    )
    ast_blind_spots = sum(
        1 for r in results for l in r.lsp_only_labels
        if _lsp_counts_as_signal(l) and l["likely_real_caller"]
    )
    ast_blind_rate = ast_blind_spots / lsp_signal_samples if lsp_signal_samples else 0.0

    t = Table(title="Rollup metrics (pyright vs AST)", show_header=False, box=None)
    t.add_column(justify="right", style="bold cyan")
    t.add_column()
    t.add_row("Total pyright references", str(total_lsp))
    t.add_row("Total AST references", str(total_ast))
    t.add_row("Line-level agreed (±2)", str(total_agreed))
    t.add_row(
        "Line-level agreement rate",
        f"{agreement_rate:.1%}  (low expected: AST=def-lines, LSP=call-lines)",
    )
    t.add_row(
        "Enclosing-function agreement (Jaccard)",
        f"{enc_agreement:.1%}",
    )
    t.add_row("pyright-only (candidate AST blind spots)", str(total_lsp_only))
    t.add_row("AST-only (candidate AST false positives)", str(total_ast_only))
    t.add_row(
        "Est. AST false positive rate",
        f"{ast_fp_rate:.1%}  (from {ast_samples} labeled samples)",
    )
    t.add_row(
        "Est. AST blind spot rate",
        f"{ast_blind_rate:.1%}  (from {lsp_signal_samples} caller-like samples)",
    )
    console.print(t)
    return agreement_rate, enc_agreement, ast_fp_rate, ast_blind_rate


def render_takeaway(
    enc_agreement: float,
    ast_fp: float,
    ast_blind: float,
    cold_start: float,
    avg_latency: float,
    results: list[SymbolResult],
    diff_summary: dict[str, Any],
    jedi_blob: dict | None,
    venv_path: str,
) -> None:
    jedi_refs_total = 0
    jedi_calls_total = 0
    jedi_blind_rate = None
    if jedi_blob:
        jedi_refs_total = sum(len(s.get("lsp_refs", [])) for s in jedi_blob["symbols"])
        jedi_calls_total = sum(len(s.get("lsp_callers", [])) for s in jedi_blob["symbols"])
        jedi_blind_rate = (jedi_blob.get("rollup") or {}).get("ast_blind_spot_rate_sampled")
    py_refs_total = sum(len(r.lsp_refs) for r in results)
    py_calls_total = sum(len(r.lsp_callers) for r in results)

    call_hierarchy_status: str
    prep_nonzero = sum(1 for r in results if r.prepare_call_hierarchy_count > 0)
    if py_calls_total > 0:
        call_hierarchy_status = (
            f"YES — callHierarchy returned {py_calls_total} callers across "
            f"{sum(1 for r in results if r.lsp_callers)} symbols."
        )
    elif prep_nonzero > 0:
        call_hierarchy_status = (
            f"PARTIAL — prepareCallHierarchy succeeded on {prep_nonzero} symbols "
            "but incomingCalls returned 0. Same failure mode as jedi."
        )
    else:
        call_hierarchy_status = (
            "NO — prepareCallHierarchy returned empty. Same failure mode as jedi."
        )

    refs_delta_pct = (
        (py_refs_total - jedi_refs_total) / max(1, jedi_refs_total) * 100
    )
    if py_refs_total > jedi_refs_total * 1.2:
        refs_verdict = (
            f"pyright finds {py_refs_total - jedi_refs_total} more refs than jedi "
            f"({refs_delta_pct:+.0f}% delta) — materially better recall."
        )
    elif py_refs_total > jedi_refs_total:
        refs_verdict = (
            f"pyright finds {py_refs_total - jedi_refs_total} more refs than jedi "
            f"({refs_delta_pct:+.0f}%) — marginal improvement."
        )
    elif py_refs_total == jedi_refs_total:
        refs_verdict = "pyright matches jedi on reference counts — no improvement."
    else:
        refs_verdict = (
            f"pyright finds {jedi_refs_total - py_refs_total} FEWER refs than jedi "
            f"({refs_delta_pct:+.0f}%). Investigate indexing / pythonPath."
        )

    biggest_win = None
    if diff_summary.get("rows"):
        biggest_win = max(diff_summary["rows"], key=lambda r: r["delta_refs"])

    win_line = ""
    if biggest_win and biggest_win["delta_refs"] > 0:
        win_line = (
            f"Biggest win: {biggest_win['symbol']} "
            f"— pyright={biggest_win['py_refs']} vs jedi={biggest_win['jedi_refs']} "
            f"(+{biggest_win['delta_refs']})."
        )

    blind_compare = ""
    if jedi_blind_rate is not None:
        blind_compare = (
            f"AST blind-spot rate: jedi={jedi_blind_rate:.1%} vs pyright={ast_blind:.1%}. "
        )

    recommendation: str
    if py_calls_total > 0 and py_refs_total > jedi_refs_total * 1.1:
        recommendation = (
            "Swap the backend to pyright. callHierarchy works, recall is higher, "
            "and the cold-start cost is a one-time hit at session start."
        )
    elif py_refs_total > jedi_refs_total * 1.1:
        recommendation = (
            "Swap to pyright for references. callHierarchy is broken/empty on the "
            "LSP wire for both backends, so stick with textDocument/references as "
            "the caller oracle — just driven by pyright instead of jedi."
        )
    elif py_refs_total >= jedi_refs_total:
        recommendation = (
            "Parity with jedi. Pyright is strictly better on typed, third-party "
            "cross-module code — which sdk-python mostly lacks without a venv. "
            "Re-run once sdk-python has a resolvable venv before concluding."
        )
    else:
        recommendation = (
            "Pyright underperformed jedi here. Most likely cause: pyright couldn't "
            "resolve workspace paths without a pythonPath. Debug initializationOptions "
            "and rerun."
        )

    venv_note = (
        "sdk-python has no .venv; pyright is running against its bundled stdlib "
        "only, so third-party refs (boto3, pydantic, etc.) cannot resolve."
        if "none" in venv_path
        else f"pythonPath={venv_path}"
    )

    body = (
        f"callHierarchy working? {call_hierarchy_status}\n\n"
        f"{refs_verdict} {win_line}\n"
        f"{blind_compare}"
        f"Enclosing-function Jaccard: {enc_agreement:.1%}. "
        f"AST-FP rate: {ast_fp:.1%}. Cold start: {cold_start:.1f}s, "
        f"avg per-symbol latency: {avg_latency:.2f}s.\n\n"
        f"{venv_note}\n\n"
        f"Recommendation: {recommendation}"
    )
    console.print(Rule("[bold green]Engineering takeaway[/bold green]"))
    console.print(Panel(body, border_style="green"))


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------


def dump_json(
    results: list[SymbolResult],
    env_info: dict,
    wallclock: dict,
    rollup: dict,
    diff_summary: dict,
) -> None:
    def _ref(r: Reference) -> dict:
        return {
            "file": r.referrer_file,
            "line": r.referrer_line,
            "enclosing": r.referrer_symbol,
        }

    blob = {
        "env": env_info,
        "wallclock": wallclock,
        "rollup": rollup,
        "jedi_diff": diff_summary,
        "symbols": [
            {
                "node_id": r.symbol.node_id,
                "qualified": r.symbol.qualified,
                "category": r.symbol.category,
                "file": r.symbol.file_path,
                "start_line": r.symbol.start_line,
                "lsp_refs": [_ref(x) for x in r.lsp_refs],
                "lsp_impls": r.lsp_impls,
                "lsp_callers": [_ref(x) for x in r.lsp_callers],
                "prepare_call_hierarchy_count": r.prepare_call_hierarchy_count,
                "ast_refs": [_ref(x) for x in r.ast_refs],
                "agreed": [_ref(x) for x in r.agreed],
                "lsp_only": [_ref(x) for x in r.lsp_only],
                "ast_only": [_ref(x) for x in r.ast_only],
                "lsp_only_labels": r.lsp_only_labels,
                "ast_only_labels": r.ast_only_labels,
                "latency_s": r.query_latency_s,
                "error": r.lsp_error,
            }
            for r in results
        ],
    }
    REPORT_JSON.write_text(json.dumps(blob, indent=2, default=str))
    console.print(f"[green]wrote[/green] {REPORT_JSON}")


def write_goldens(results: list[SymbolResult], sdk_head: str) -> None:
    now = datetime.now(timezone.utc).isoformat()
    goldens: list[dict] = []
    for r in results:
        callers: list[dict] = []
        for ref in r.agreed[:4]:
            callers.append(
                {
                    "file": ref.referrer_file,
                    "line": ref.referrer_line,
                    "enclosing": str(ref.referrer_symbol) if ref.referrer_symbol else None,
                    "source": "both",
                    "labeler_note": f"agreed caller at {ref.referrer_file}:{ref.referrer_line}",
                }
            )
        for lab in r.lsp_only_labels:
            if lab["likely_real_caller"]:
                callers.append(
                    {
                        "file": lab["file"],
                        "line": lab["line"],
                        "enclosing": str(lab["enclosing"]) if lab["enclosing"] else None,
                        "source": "pyright",
                        "labeler_note": f"pyright was right, AST was wrong: {lab['reason']}",
                    }
                )
        for lab in r.ast_only_labels:
            if lab["likely_real_caller"]:
                callers.append(
                    {
                        "file": lab["file"],
                        "line": lab["line"],
                        "enclosing": str(lab["enclosing"]) if lab["enclosing"] else None,
                        "source": "ast",
                        "labeler_note": f"AST was right, pyright was wrong: {lab['reason']}",
                    }
                )
        if not callers:
            continue
        goldens.append(
            {
                "fixture": "sdk-python",
                "commit": sdk_head,
                "target": r.symbol.node_id,
                "method_callers": callers,
                "labeler": "opus-4-7",
                "labeled_at": now,
            }
        )
    GOLDENS_YAML.write_text(yaml.safe_dump(goldens, sort_keys=False))
    console.print(f"[green]wrote[/green] {GOLDENS_YAML} ({len(goldens)} golden cases)")


# ---------------------------------------------------------------------------
# Pyright initialize
# ---------------------------------------------------------------------------


def detect_venv() -> tuple[str | None, str]:
    """Return (pythonPath, label)."""
    for candidate in (
        SDK_PYTHON_PATH / ".venv" / "bin" / "python",
        SDK_PYTHON_PATH / "venv" / "bin" / "python",
    ):
        if candidate.exists():
            return (str(candidate), str(candidate))
    return (None, "none — bundled stdlib only")


async def initialize_pyright(client: LspClient, python_path: str | None) -> float:
    t0 = time.perf_counter()
    init_params: dict[str, Any] = {
        "processId": os.getpid(),
        "clientInfo": {"name": "spike-pyright-oracle", "version": "0.1"},
        "rootUri": SDK_PYTHON_PATH.as_uri(),
        "rootPath": str(SDK_PYTHON_PATH),
        "workspaceFolders": [
            {"uri": SDK_PYTHON_PATH.as_uri(), "name": "sdk-python"}
        ],
        "capabilities": {
            "workspace": {
                "configuration": True,
                "workspaceFolders": True,
                "didChangeConfiguration": {"dynamicRegistration": False},
            },
            "textDocument": {
                "references": {"dynamicRegistration": False},
                "implementation": {"dynamicRegistration": False, "linkSupport": False},
                "callHierarchy": {"dynamicRegistration": False},
                "synchronization": {
                    "dynamicRegistration": False,
                    "didSave": True,
                    "willSave": False,
                    "willSaveWaitUntil": False,
                },
                "publishDiagnostics": {"relatedInformation": False},
            },
            "window": {"workDoneProgress": True},
        },
        "initializationOptions": {
            "python": {"pythonPath": python_path or sys.executable},
            "pyright": {
                "disableLanguageServices": False,
                "disableOrganizeImports": True,
            },
        },
    }
    await client.request("initialize", init_params)
    await client.notify("initialized", {})
    # Trigger config pull so pyright uses workspace settings.
    await client.notify(
        "workspace/didChangeConfiguration",
        {
            "settings": {
                "python": {"pythonPath": python_path or sys.executable},
                "python.analysis": {
                    "autoSearchPaths": True,
                    "useLibraryCodeForTypes": True,
                    "diagnosticMode": "workspace",
                    "extraPaths": ["src"],
                },
            }
        },
    )
    # Wait for pyright to finish its initial workspace scan via $/progress.
    saw_end = await client.wait_for_progress_end(INDEX_WAIT_CAP_S)
    if not saw_end:
        console.print(
            "[yellow]no $/progress end seen; continuing after cap[/yellow]"
        )
    return time.perf_counter() - t0


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


async def _main_async() -> None:
    t_total = time.perf_counter()

    if not GRAPH_DB_PATH.exists():
        console.print(f"[red]missing:[/red] {GRAPH_DB_PATH}")
        sys.exit(2)
    if not SDK_PYTHON_PATH.exists():
        console.print(f"[red]missing:[/red] {SDK_PYTHON_PATH}")
        sys.exit(2)

    try:
        sdk_head = subprocess.check_output(
            ["git", "-C", str(SDK_PYTHON_PATH), "rev-parse", "HEAD"], text=True
        ).strip()
    except Exception:
        sdk_head = "unknown"

    # Sanity check: does `pyright --version` run? If not, fail fast.
    pyright_preflight_version: str | None = None
    if shutil.which("pyright"):
        try:
            pyright_preflight_version = subprocess.check_output(
                ["pyright", "--version"], text=True, stderr=subprocess.STDOUT
            ).strip()
        except Exception:
            pyright_preflight_version = None
    if not pyright_preflight_version:
        try:
            pyright_preflight_version = subprocess.check_output(
                ["uvx", "--from", "pyright==1.1.390", "pyright", "--version"],
                text=True,
                stderr=subprocess.STDOUT,
            ).strip()
        except Exception as exc:  # noqa: BLE001
            console.print(
                f"[red]pyright --version failed:[/red] {exc}\n"
                "Hint: `uvx --from pyright==1.1.390 pyright --version` should work."
            )
            sys.exit(2)
    console.print(f"[cyan]pyright preflight:[/cyan] {pyright_preflight_version}")

    console.print(Rule("[bold]Pyright Oracle Spike[/bold]"))
    db = duckdb.connect(str(GRAPH_DB_PATH), read_only=True)
    symbols = pick_symbols(db)

    python_path, venv_label = detect_venv()

    console.print(Rule("[cyan]starting pyright-langserver[/cyan]"))
    client, launch_mode, pyright_version = await launch_pyright()
    console.print(f"[green]launched via:[/green] {launch_mode}")

    render_environment(
        py_version=sys.version.split()[0],
        pyright_version=pyright_version or pyright_preflight_version,
        launch_mode=launch_mode,
        venv_path=venv_label,
        symbols=symbols,
        sdk_head=sdk_head,
    )
    render_sample(symbols)

    try:
        cold_start_s = await initialize_pyright(client, python_path)
        console.print(
            f"[green]pyright ready[/green] after {cold_start_s:.2f}s"
        )

        results_map, timings = await run_pyright_queries(client, symbols)
    finally:
        await client.close()

    results: list[SymbolResult] = [results_map[s.node_id] for s in symbols]

    for r in results:
        r.ast_refs = ast_references_for(db, r.symbol)
        compute_disagreements(db, r)
        label_samples(db, r)

    console.print(Rule("[bold]Report[/bold]"))
    render_capability_matrix(results)
    render_per_symbol(results)
    diff_summary = render_jedi_diff(results)
    render_wallclock(cold_start_s, list(timings.values()), time.perf_counter() - t_total)
    render_labels(results)
    agreement, enc_agreement, ast_fp, ast_blind = render_rollup(db, results)
    avg_latency = sum(timings.values()) / len(timings) if timings else 0.0

    jedi_blob: dict | None = None
    if JEDI_JSON.exists():
        try:
            jedi_blob = json.loads(JEDI_JSON.read_text())
        except Exception:
            jedi_blob = None

    render_takeaway(
        enc_agreement,
        ast_fp,
        ast_blind,
        cold_start_s,
        avg_latency,
        results,
        diff_summary,
        jedi_blob,
        venv_label,
    )

    dump_json(
        results,
        env_info={
            "python": sys.version,
            "lsp_backend": "pyright-langserver",
            "lsp_version": pyright_version,
            "launch_mode": launch_mode,
            "python_path": python_path,
            "sdk_head": sdk_head,
        },
        wallclock={
            "cold_start_s": cold_start_s,
            "avg_latency_s": avg_latency,
            "total_s": time.perf_counter() - t_total,
            "per_symbol": dict(timings),
        },
        rollup={
            "line_agreement_rate": agreement,
            "enclosing_agreement_jaccard": enc_agreement,
            "ast_false_positive_rate_sampled": ast_fp,
            "ast_blind_spot_rate_sampled": ast_blind,
        },
        diff_summary=diff_summary,
    )
    write_goldens(results, sdk_head)

    db.close()


def main() -> None:
    os.environ.pop("PYTHONPATH", None)
    asyncio.run(_main_async())


if __name__ == "__main__":
    main()
