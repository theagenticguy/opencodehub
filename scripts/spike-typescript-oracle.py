#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "duckdb>=1.1",
#     "rich>=13",
#     "PyYAML>=6",
# ]
# ///
"""
TypeScript LSP Oracle Spike.

Drives `typescript-language-server --stdio` directly over a hand-rolled LSP
stdio client (same pattern as the pyright spike in
`spike-pyright-oracle.py`). Runs a 12-symbol comparison against the
tree-sitter graph at `.codehub/graph.duckdb` and reports whether the TS
server's references / implementations / callHierarchy queries produce
materially better caller-graph signal than the AST pass.

Target repo:
    /Users/lalsaado/Projects/open-code-hub (this repo, self-dogfooding)

Preconditions:
    1. `/Users/lalsaado/Projects/open-code-hub/node_modules/typescript/package.json`
       exists (pnpm install has run).
    2. `/Users/lalsaado/Projects/open-code-hub/.codehub/graph.duckdb` exists
       and is populated (`pnpm exec codehub analyze --offline --force`).
    3. A scratch install at `/tmp/ts-lsp-host/` provides both
       `typescript-language-server` and the `typescript` package. We install
       it on-the-fly if missing.

Outputs:
    /tmp/spike-ts-oracle-report.json   # full normalized data
    /tmp/spike-ts-oracle-goldens.yaml  # auto-labeled golden callers
"""

from __future__ import annotations

import asyncio
import json
import os
import re
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

TARGET_REPO = Path("/Users/lalsaado/Projects/open-code-hub")
GRAPH_DB_PATH = TARGET_REPO / ".codehub" / "graph.duckdb"
REPORT_JSON = Path("/tmp/spike-ts-oracle-report.json")
GOLDENS_YAML = Path("/tmp/spike-ts-oracle-goldens.yaml")
PYRIGHT_JSON = Path("/tmp/spike-pyright-oracle-report.json")

TS_LSP_HOST = Path("/tmp/ts-lsp-host")
TS_LSP_BIN = TS_LSP_HOST / "node_modules" / ".bin" / "typescript-language-server"
TSSERVER_JS = TS_LSP_HOST / "node_modules" / "typescript" / "lib" / "tsserver.js"

LINE_FUZZ = 2
INIT_PROGRESS_CAP_S = 90.0  # tsserver project load can be slow on monorepos

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
    file_path: str  # relative to TARGET_REPO
    start_line: int
    end_line: int
    category: str

    @property
    def abs_path(self) -> Path:
        return TARGET_REPO / self.file_path

    @property
    def language_id(self) -> str:
        suffix = Path(self.file_path).suffix.lower()
        if suffix == ".tsx":
            return "typescriptreact"
        if suffix in (".js", ".mjs", ".cjs"):
            return "javascript"
        if suffix == ".jsx":
            return "javascriptreact"
        return "typescript"


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
# Hand-rolled LSP JSON-RPC stdio client (ported from the pyright spike)
# ---------------------------------------------------------------------------


class LspClient:
    """
    Minimal async LSP client over stdio. Content-Length framing, JSON body,
    multiplexes responses by id, buffers notifications, auto-acks common
    server->client requests so typescript-language-server doesn't block.
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
            text = line.decode("utf-8", errors="replace").rstrip()
            if "error" in text.lower() or "warn" in text.lower():
                console.print(f"[dim]ts-lsp.stderr:[/dim] {text[:200]}")

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
        # Response.
        if "id" in msg and "method" not in msg:
            fut = self._pending.pop(msg["id"], None)
            if fut and not fut.done():
                if "error" in msg:
                    fut.set_exception(RuntimeError(json.dumps(msg["error"])))
                else:
                    fut.set_result(msg.get("result"))
            return
        # Server->client request. Auto-ack the usual suspects.
        if "id" in msg and "method" in msg:
            await self._requests_from_server.put(msg)
            method = msg["method"]
            if method in (
                "workspace/configuration",
                "window/workDoneProgress/create",
                "client/registerCapability",
                "client/unregisterCapability",
            ):
                result: Any
                if method == "workspace/configuration":
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
        # ts-lsp pulls config for "typescript", "javascript", "diagnostics", etc.
        if section in ("typescript", "javascript"):
            return {
                "inlayHints": {
                    "includeInlayParameterNameHints": "none",
                    "includeInlayPropertyDeclarationTypeHints": False,
                    "includeInlayFunctionLikeReturnTypeHints": False,
                }
            }
        return {}

    async def _send_raw(self, msg: dict[str, Any]) -> None:
        body = json.dumps(msg).encode("utf-8")
        header = f"Content-Length: {len(body)}\r\n\r\n".encode("ascii")
        assert self._proc.stdin is not None
        self._proc.stdin.write(header + body)
        await self._proc.stdin.drain()

    async def request(self, method: str, params: Any, timeout: float = 60.0) -> Any:
        self._next_id += 1
        rid = self._next_id
        fut: asyncio.Future[Any] = asyncio.get_event_loop().create_future()
        self._pending[rid] = fut
        await self._send_raw(
            {"jsonrpc": "2.0", "id": rid, "method": method, "params": params}
        )
        return await asyncio.wait_for(fut, timeout=timeout)

    async def notify(self, method: str, params: Any) -> None:
        await self._send_raw({"jsonrpc": "2.0", "method": method, "params": params})

    async def wait_for_progress_end(self, timeout: float) -> bool:
        """
        Wait for a $/progress or window/workDoneProgress/* 'end' notification.
        Returns True if an end marker was seen. ts-lsp forwards tsserver
        progress through $/progress with value.kind == 'end'.
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
            if m in ("$/progress", "window/workDoneProgress/end"):
                saw_any = True
                value = (p or {}).get("value") or {}
                if value.get("kind") == "end" or m == "window/workDoneProgress/end":
                    return True

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            await asyncio.wait_for(self.request("shutdown", None, timeout=5.0), timeout=5.0)
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
# Preconditions & launch
# ---------------------------------------------------------------------------


def ensure_preconditions() -> None:
    if not (TARGET_REPO / "node_modules" / "typescript" / "package.json").exists():
        console.print(
            "[red]missing[/red] node_modules/typescript in target repo. "
            "Run `pnpm install` at the repo root."
        )
        sys.exit(2)
    if not GRAPH_DB_PATH.exists():
        console.print(
            f"[red]missing[/red] {GRAPH_DB_PATH}. "
            "Run `pnpm exec codehub analyze --offline --force` from the repo root."
        )
        sys.exit(2)
    # Confirm graph is populated (the file may exist but be empty from a prior failed run).
    db = duckdb.connect(str(GRAPH_DB_PATH), read_only=True)
    try:
        count = db.execute("SELECT COUNT(*) FROM nodes").fetchone()[0]
    finally:
        db.close()
    if count == 0:
        console.print(
            f"[red]empty[/red] {GRAPH_DB_PATH} has 0 nodes. "
            "Delete it and re-run `pnpm exec codehub analyze --offline --force`."
        )
        sys.exit(2)


def ensure_ts_lsp() -> tuple[str, str]:
    """Ensure /tmp/ts-lsp-host has typescript-language-server + typescript.

    Returns (ts_lsp_version, tsserver_version).
    """
    if not TS_LSP_BIN.exists() or not TSSERVER_JS.exists():
        console.print(
            f"[cyan]installing typescript-language-server + typescript into {TS_LSP_HOST}[/cyan]"
        )
        TS_LSP_HOST.mkdir(parents=True, exist_ok=True)
        # Fresh package.json so npm install is idempotent.
        (TS_LSP_HOST / "package.json").write_text('{"name":"ts-lsp-host","private":true}\n')
        try:
            subprocess.check_call(
                ["npm", "install", "--prefix", str(TS_LSP_HOST), "--silent",
                 "typescript-language-server", "typescript"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.STDOUT,
            )
        except Exception as exc:  # noqa: BLE001
            console.print(f"[red]npm install failed:[/red] {exc}")
            sys.exit(2)
    # Read versions.
    try:
        ts_lsp_pkg = json.loads(
            (TS_LSP_HOST / "node_modules" / "typescript-language-server" / "package.json").read_text()
        )
        ts_pkg = json.loads(
            (TS_LSP_HOST / "node_modules" / "typescript" / "package.json").read_text()
        )
    except Exception:
        return ("unknown", "unknown")
    return (str(ts_lsp_pkg.get("version")), str(ts_pkg.get("version")))


async def launch_ts_lsp() -> LspClient:
    argv = [str(TS_LSP_BIN), "--stdio"]
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env={**os.environ, "NODE_ENV": "production"},
    )
    await asyncio.sleep(0.25)
    if proc.returncode is not None:
        stderr = (
            (await proc.stderr.read()).decode("utf-8", errors="replace")
            if proc.stderr
            else ""
        )
        raise RuntimeError(
            f"typescript-language-server exited immediately (rc={proc.returncode}): "
            f"{stderr[:400]}"
        )
    client = LspClient(proc)
    await client.start()
    return client


# ---------------------------------------------------------------------------
# Symbol sample
# ---------------------------------------------------------------------------


def pick_symbols(db: duckdb.DuckDBPyConnection) -> list[Symbol]:
    """
    Hand-picked sample covering the shapes we care about on a TS codebase:
      - 2 exported classes (storage, ingestion)
      - 3 interfaces (core-types node type, plus two pipeline-option interfaces)
      - 2 generic functions
      - 1 discriminated-union helper (TypeAlias)
      - 2 class methods
      - 2 exported top-level functions (treated as "const-like" utilities)
    Total: 12 symbols.
    """
    plan: list[tuple[str, str]] = [
        # (node_id, category)
        ("Class:packages/storage/src/duckdb-adapter.ts:DuckDbStore", "class"),
        ("Class:packages/ingestion/src/parse/worker-pool.ts:ParsePool", "class"),
        ("Interface:packages/core-types/src/nodes.ts:FileNode", "interface"),
        ("Interface:packages/ingestion/src/pipeline/types.ts:PipelineOptions", "interface"),
        ("Interface:packages/ingestion/src/pipeline/orchestrator.ts:RunIngestionOptions", "interface"),
        ("Function:packages/mcp/src/next-step-hints.ts:withNextSteps", "generic_function"),
        ("Function:packages/ingestion/src/pipeline/ownership-helpers/orphan.ts:classifyOrphans", "generic_function"),
        ("TypeAlias:packages/core-types/src/nodes.ts:GraphNode", "discriminated_union"),
        ("Method:packages/storage/src/duckdb-adapter.ts:DuckDbStore.insertNodes", "method"),
        ("Method:packages/storage/src/duckdb-adapter.ts:DuckDbStore.insertEdges", "method"),
        ("Function:packages/core-types/src/id.ts:makeNodeId", "exported_fn"),
        ("Function:packages/mcp/src/error-envelope.ts:toolErrorFromUnknown", "exported_fn"),
    ]
    symbols: list[Symbol] = []
    for nid, category in plan:
        row = db.execute(
            "SELECT id, kind, name, file_path, start_line, end_line FROM nodes WHERE id = ?",
            [nid],
        ).fetchone()
        if not row:
            console.print(f"[yellow]missing symbol in graph:[/yellow] {nid}")
            continue
        symbols.append(
            Symbol(
                node_id=row[0],
                kind=row[1],
                name=row[2],
                qualified=nid.split(":", 2)[-1],
                file_path=row[3],
                start_line=row[4],
                end_line=row[5],
                category=category,
            )
        )
    return symbols


# ---------------------------------------------------------------------------
# AST reference extraction (from the tree-sitter graph)
# ---------------------------------------------------------------------------


RELEVANT_AST_EDGE_TYPES = (
    "CALLS",
    "REFERENCES",
    "ACCESSES",
    "EXTENDS",
    "IMPLEMENTS",
    "MEMBER_OF",
    "HAS_METHOD",
    "HAS_PROPERTY",
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
          AND kind IN ('Method', 'Function', 'Class', 'Property', 'Const',
                       'Variable', 'Interface', 'TypeAlias')
        ORDER BY (end_line - start_line) ASC
        LIMIT 1
        """,
        [file_rel, line, line],
    ).fetchone()
    return row[0] if row else None


# ---------------------------------------------------------------------------
# Name-token position lookup
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
# TS LSP queries
# ---------------------------------------------------------------------------


async def run_ts_queries(
    client: LspClient, symbols: list[Symbol]
) -> tuple[dict[str, SymbolResult], dict[str, float]]:
    results: dict[str, SymbolResult] = {
        s.node_id: SymbolResult(symbol=s) for s in symbols
    }
    timings: dict[str, float] = {}
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
                    "languageId": sym.language_id,
                    "version": 1,
                    "text": text,
                }
            },
        )
        opened.add(sym.file_path)
        # Let tsserver assemble the file into its project graph before we query.
        await asyncio.sleep(0.15)

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
        errs: list[str] = []

        async def _safe(method: str, params: Any) -> Any:
            try:
                return await client.request(method, params, timeout=45.0)
            except Exception as exc:  # noqa: BLE001
                errs.append(f"{method}: {exc}")
                return None

        refs_task = _safe(
            "textDocument/references",
            {"context": {"includeDeclaration": False}, **text_doc_pos},
        )
        impl_task = _safe("textDocument/implementation", text_doc_pos)
        prep_task = _safe("textDocument/prepareCallHierarchy", text_doc_pos)
        refs_resp, impl_resp, prep_resp = await asyncio.gather(
            refs_task, impl_task, prep_task
        )

        incoming_resp: Any = None
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

        for item in refs_resp or []:
            file_abs = uri_to_path(item.get("uri", ""))
            try:
                file_rel = str(Path(file_abs).relative_to(TARGET_REPO))
            except ValueError:
                continue
            line_ = int(item["range"]["start"]["line"]) + 1
            res.lsp_refs.append(
                Reference(referrer_file=file_rel, referrer_line=line_, referrer_symbol=None)
            )

        for item in impl_resp or []:
            uri_ = item.get("uri") or (item.get("targetUri") if isinstance(item, dict) else None)
            rng = item.get("range") or item.get("targetRange") or {}
            res.lsp_impls.append(
                {
                    "uri": uri_,
                    "line": (rng.get("start") or {}).get("line"),
                }
            )

        for call in incoming_resp or []:
            caller = call.get("from", {})
            file_abs = uri_to_path(caller.get("uri", ""))
            try:
                file_rel = str(Path(file_abs).relative_to(TARGET_REPO))
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
            f"  [green]ok  [/green] {sym.qualified[:68]:68s}"
            f" refs={len(res.lsp_refs):4d} callers={len(res.lsp_callers):3d}"
            f" impls={len(res.lsp_impls):2d}  prep={res.prepare_call_hierarchy_count}"
            f"  {dt:5.2f}s"
        )

    return results, timings


# ---------------------------------------------------------------------------
# Disagreement
# ---------------------------------------------------------------------------


def compute_disagreements(db: duckdb.DuckDBPyConnection, res: SymbolResult) -> None:
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
# TS-aware labeler
# ---------------------------------------------------------------------------


def _read_line(file_rel: str, line: int) -> str:
    try:
        with (TARGET_REPO / file_rel).open("r", encoding="utf-8", errors="replace") as f:
            for idx, raw in enumerate(f, start=1):
                if idx == line:
                    return raw.rstrip("\n")
        return ""
    except FileNotFoundError:
        return ""


def _read_lines_range(file_rel: str, start: int, end: int) -> list[str]:
    try:
        with (TARGET_REPO / file_rel).open("r", encoding="utf-8", errors="replace") as f:
            out = []
            for idx, raw in enumerate(f, start=1):
                if idx > end:
                    break
                if idx >= start:
                    out.append(raw.rstrip("\n"))
            return out
    except FileNotFoundError:
        return []


def _classify_ts_line(src_line: str, sym: Symbol) -> tuple[bool, str]:
    """
    Classify a source line as a referrer for `sym`. Returns
    (likely_real_caller, reason_tag).

    Reason tags:
      real_caller, type_annotation, import, reexport, generic_instantiation,
      string_match, def_site, comment, absent, unclear
    """
    name = sym.name
    stripped = src_line.strip()

    if not name:
        return (False, "absent")
    if name not in src_line:
        return (False, "absent")

    # Comment
    if stripped.startswith("//") or stripped.startswith("*") or stripped.startswith("/*"):
        return (False, "comment")

    # Definition sites.
    def_patterns = [
        rf"^(export\s+)?(abstract\s+)?class\s+{re.escape(name)}\b",
        rf"^(export\s+)?interface\s+{re.escape(name)}\b",
        rf"^(export\s+)?type\s+{re.escape(name)}\b",
        rf"^(export\s+)?(async\s+)?function\s+{re.escape(name)}\b",
        rf"^(export\s+)?const\s+{re.escape(name)}\b",
        rf"^(export\s+)?let\s+{re.escape(name)}\b",
    ]
    if sym.kind in ("Method",):
        # Method def site has `name(` at start of stripped line, possibly with modifiers.
        if re.match(rf"^(public\s+|private\s+|protected\s+|static\s+|async\s+|override\s+|readonly\s+)*"
                    rf"{re.escape(name)}\s*[<(]",
                    stripped):
            return (False, "def_site")
    else:
        for pat in def_patterns:
            if re.match(pat, stripped):
                return (False, "def_site")

    # Union-member def lines look like `  | Foo` — in the definition of a TypeAlias.
    # These are continuations of the def, not references.
    if re.match(rf"^\|\s*{re.escape(name)}\b", stripped):
        return (False, "def_site")

    # Re-export. `export { Foo } from ...` or `export * from ...`
    if stripped.startswith("export {") or stripped.startswith("export *") or stripped.startswith("export type {"):
        if name in stripped:
            return (True, "reexport")

    # Imports. `import { Foo } from "..."` or `import type { Foo }`.
    if stripped.startswith("import ") or stripped.startswith("} from "):
        if f"type {{" in stripped or stripped.startswith("import type"):
            return (True, "type_only_import")
        return (True, "import")

    # String literal only (no call or annotation).
    call_substrings = [
        f".{name}(",
        f" {name}(",
        f"({name}(",
        f"[{name}(",
        f",{name}(",
        f"={name}(",
        f"!{name}(",
    ]
    is_call = any(cs in src_line for cs in call_substrings) or stripped.startswith(f"{name}(")

    # Type annotation: `: Foo`, `as Foo`, `<Foo>`, `Foo[]`, extends/implements.
    type_patterns = [
        rf":\s*{re.escape(name)}\b",
        rf"\bas\s+{re.escape(name)}\b",
        rf"<\s*{re.escape(name)}\b",
        rf"\b{re.escape(name)}\[\]",
        rf"\bextends\s+{re.escape(name)}\b",
        rf"\bimplements\s+{re.escape(name)}\b",
        rf"\bkeyof\s+{re.escape(name)}\b",
        rf"\btypeof\s+{re.escape(name)}\b",
    ]
    is_type_annotation = any(re.search(pat, src_line) for pat in type_patterns)

    # Generic instantiation specifically: `<Foo>` or `<Foo,` inside a call or type.
    is_generic_instantiation = bool(
        re.search(rf"<[^<>]*\b{re.escape(name)}\b[^<>]*>", src_line)
    )

    if is_call:
        return (True, "real_caller")
    if is_type_annotation and not is_call:
        return (True, "type_annotation" if not is_generic_instantiation else "generic_instantiation")
    if is_generic_instantiation:
        return (True, "generic_instantiation")

    # `new Foo(...)` constructor
    if re.search(rf"\bnew\s+{re.escape(name)}\s*[(<]", src_line):
        return (True, "real_caller")

    # Discriminated-union narrowing: `n.kind === 'File'` etc.
    if sym.category == "discriminated_union" or sym.category == "interface":
        if re.search(rf"\b{re.escape(name)}\b", src_line) and re.search(r"\.kind\s*===", src_line):
            return (True, "discriminated_union_narrow")

    # String literal
    if (f"'{name}'" in src_line or f'"{name}"' in src_line) and not is_call:
        return (False, "string_match")

    # Keyword arg usage `name: value`
    if re.search(rf"\b{re.escape(name)}\s*:", src_line) and not stripped.startswith(f"{name}:"):
        return (True, "property_assignment")

    return (False, "unclear")


def _ast_body_contains_reference(
    db: duckdb.DuckDBPyConnection, file_rel: str, referrer_line: int, sym: Symbol
) -> tuple[bool, str, int | None]:
    enc_row = db.execute(
        """
        SELECT id, kind, start_line, end_line
        FROM nodes
        WHERE file_path = ?
          AND start_line IS NOT NULL AND end_line IS NOT NULL
          AND start_line <= ? AND end_line >= ?
          AND kind IN ('Method', 'Function', 'Class', 'Property', 'Interface',
                       'TypeAlias', 'Const')
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
    for i, ln in enumerate(lines, start=enc_start):
        if name in ln:
            real, tag = _classify_ts_line(ln, sym)
            if real:
                return (True, tag, i)
    return (False, f"name `{name}` never appears inside enclosing node body", None)


def label_samples(db: duckdb.DuckDBPyConnection, res: SymbolResult, k: int = 5) -> None:
    for ref in res.lsp_only[:k]:
        src_line = _read_line(ref.referrer_file, ref.referrer_line)
        real, reason = _classify_ts_line(src_line, res.symbol)
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
        real, tag, ref_line = _ast_body_contains_reference(
            db, ref.referrer_file, ref.referrer_line, res.symbol
        )
        src_line = _read_line(ref.referrer_file, ref_line) if ref_line else _read_line(
            ref.referrer_file, ref.referrer_line
        )
        res.ast_only_labels.append(
            {
                "file": ref.referrer_file,
                "line": ref_line if ref_line else ref.referrer_line,
                "def_line": ref.referrer_line,
                "enclosing": ref.referrer_symbol,
                "src": src_line,
                "likely_real_caller": real,
                "reason": tag,
            }
        )


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def render_environment(
    py_version: str,
    ts_lsp_version: str,
    tsserver_version: str,
    node_version: str,
    tsconfigs: list[str],
    symbols: list[Symbol],
    repo_head: str,
) -> None:
    t = Table(title="Environment", show_header=False, box=None)
    t.add_column(justify="right", style="bold cyan")
    t.add_column()
    t.add_row("Target repo", str(TARGET_REPO))
    t.add_row("Target HEAD", repo_head)
    t.add_row("Graph DB", str(GRAPH_DB_PATH))
    t.add_row("Python runtime", py_version)
    t.add_row("LSP backend", f"typescript-language-server {ts_lsp_version}")
    t.add_row("tsserver", tsserver_version)
    t.add_row("Node.js", node_version)
    t.add_row("tsconfigs found", f"{len(tsconfigs)}")
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
    t = Table(title="Capability matrix (typescript-language-server)")
    t.add_column("query")
    t.add_column("symbols non-zero", justify="right")
    t.add_column("total items", justify="right")
    t.add_row("textDocument/references", f"{any_refs}/{len(results)}", str(total_refs))
    t.add_row("textDocument/implementation", f"{any_impls}/{len(results)}", str(total_impls))
    t.add_row("prepareCallHierarchy", f"{any_prep}/{len(results)}", str(total_prep))
    t.add_row("callHierarchy/incomingCalls", f"{any_incoming}/{len(results)}", str(total_incoming))
    console.print(t)


def render_per_symbol(results: list[SymbolResult]) -> None:
    t = Table(title="Per-symbol counts")
    t.add_column("symbol")
    t.add_column("cat", style="magenta")
    t.add_column("lsp_refs", justify="right", style="cyan")
    t.add_column("lsp_impls", justify="right", style="cyan")
    t.add_column("lsp_calls", justify="right", style="cyan")
    t.add_column("ast_refs", justify="right", style="cyan")
    t.add_column("agreed", justify="right", style="green")
    t.add_column("lsp_only", justify="right", style="yellow")
    t.add_column("ast_only", justify="right", style="red")
    for r in results:
        t.add_row(
            r.symbol.qualified[:60],
            r.symbol.category,
            str(len(r.lsp_refs)),
            str(len(r.lsp_impls)),
            str(len(r.lsp_callers)),
            str(len(r.ast_refs)),
            str(len(r.agreed)),
            str(len(r.lsp_only)),
            str(len(r.ast_only)),
        )
    console.print(t)


def render_python_vs_ts(results: list[SymbolResult], wallclock: dict[str, Any]) -> dict[str, Any]:
    """Compare the TS oracle headline numbers to the pyright oracle dump."""
    py: dict[str, Any] = {}
    if PYRIGHT_JSON.exists():
        try:
            py = json.loads(PYRIGHT_JSON.read_text())
        except Exception:
            py = {}

    n_ts = len(results)
    ts_refs_total = sum(len(r.lsp_refs) for r in results)
    ts_calls_total = sum(len(r.lsp_callers) for r in results)
    ts_impls_total = sum(len(r.lsp_impls) for r in results)
    ts_prep_nonzero = sum(1 for r in results if r.prepare_call_hierarchy_count > 0)
    ts_calls_nonzero = sum(1 for r in results if r.lsp_callers)
    ts_impls_nonzero = sum(1 for r in results if r.lsp_impls)
    ts_refs_avg = ts_refs_total / n_ts if n_ts else 0.0

    if py:
        py_syms = py.get("symbols", [])
        n_py = len(py_syms)
        py_refs_total = sum(len(s.get("lsp_refs", [])) for s in py_syms)
        py_calls_total = sum(len(s.get("lsp_callers", [])) for s in py_syms)
        py_impls_total = sum(len(s.get("lsp_impls", [])) for s in py_syms)
        py_calls_nonzero = sum(1 for s in py_syms if s.get("lsp_callers"))
        py_impls_nonzero = sum(1 for s in py_syms if s.get("lsp_impls"))
        py_refs_avg = py_refs_total / n_py if n_py else 0.0
        py_cold = (py.get("wallclock") or {}).get("cold_start_s", 0.0)
        py_avg = (py.get("wallclock") or {}).get("avg_latency_s", 0.0)
    else:
        n_py = 0
        py_refs_total = py_calls_total = py_impls_total = 0
        py_calls_nonzero = py_impls_nonzero = 0
        py_refs_avg = 0.0
        py_cold = 0.0
        py_avg = 0.0

    t = Table(title="Python vs TypeScript oracle headline metrics")
    t.add_column("metric")
    t.add_column("pyright / sdk-python", justify="right", style="cyan")
    t.add_column("ts-lsp / opencodehub", justify="right", style="magenta")
    t.add_row("symbol sample size", str(n_py), str(n_ts))
    t.add_row("total references", str(py_refs_total), str(ts_refs_total))
    t.add_row("avg references / symbol", f"{py_refs_avg:.1f}", f"{ts_refs_avg:.1f}")
    t.add_row("callHierarchy coverage", f"{py_calls_nonzero}/{n_py}", f"{ts_calls_nonzero}/{n_ts}")
    t.add_row("total incomingCalls", str(py_calls_total), str(ts_calls_total))
    t.add_row("implementation coverage", f"{py_impls_nonzero}/{n_py}", f"{ts_impls_nonzero}/{n_ts}")
    t.add_row("total implementations", str(py_impls_total), str(ts_impls_total))
    t.add_row("cold start (s)", f"{py_cold:.2f}", f"{wallclock['cold_start_s']:.2f}")
    t.add_row("avg per-symbol latency (s)", f"{py_avg:.2f}", f"{wallclock['avg_latency_s']:.2f}")
    console.print(t)

    return {
        "ts": {
            "n": n_ts,
            "refs_total": ts_refs_total,
            "refs_avg_per_symbol": ts_refs_avg,
            "call_hierarchy_coverage": f"{ts_calls_nonzero}/{n_ts}",
            "calls_total": ts_calls_total,
            "impls_coverage": f"{ts_impls_nonzero}/{n_ts}",
            "impls_total": ts_impls_total,
        },
        "pyright": {
            "n": n_py,
            "refs_total": py_refs_total,
            "refs_avg_per_symbol": py_refs_avg,
            "call_hierarchy_coverage": f"{py_calls_nonzero}/{n_py}",
            "calls_total": py_calls_total,
            "impls_coverage": f"{py_impls_nonzero}/{n_py}",
            "impls_total": py_impls_total,
            "cold_start_s": py_cold,
            "avg_latency_s": py_avg,
        },
    }


def render_wallclock(cold_start_s: float, per_query: list[float], total_s: float) -> None:
    avg = sum(per_query) / len(per_query) if per_query else 0.0
    t = Table(title="Wall clock", show_header=False, box=None)
    t.add_column(justify="right", style="bold cyan")
    t.add_column()
    t.add_row("TS LSP cold start (init→ready)", f"{cold_start_s:.2f}s")
    t.add_row("Avg per-symbol latency", f"{avg:.2f}s  (n={len(per_query)})")
    if per_query:
        # ceil(0.95 * n) - 1, clamped to [0, n-1]
        n = len(per_query)
        p95_idx = min(n - 1, max(0, -(-n * 95 // 100) - 1))
        p95 = sorted(per_query)[p95_idx]
        t.add_row("p95 per-symbol latency", f"{p95:.2f}s")
    t.add_row("Total spike time", f"{total_s:.2f}s")
    console.print(t)


def render_labels(results: list[SymbolResult]) -> None:
    lsp_only_real: list[str] = []
    ast_only_real: list[str] = []
    confused: list[str] = []
    ts_blind_spots: list[str] = []

    ts_surface_tags = {
        "type_annotation",
        "generic_instantiation",
        "type_only_import",
        "reexport",
        "discriminated_union_narrow",
    }

    for r in results:
        for lab in r.lsp_only_labels:
            tag = (
                f"{r.symbol.qualified} @ {lab['file']}:{lab['line']} "
                f"[{lab['reason']}] {lab['src'][:80].strip()}"
            )
            if lab["reason"] in ts_surface_tags and lab["likely_real_caller"]:
                ts_blind_spots.append(tag)
                lsp_only_real.append(tag)
            elif lab["likely_real_caller"]:
                lsp_only_real.append(tag)
            elif lab["reason"] in ("def_site", "import", "comment"):
                pass
            else:
                confused.append(f"LSP false positive: {tag}")
        for lab in r.ast_only_labels:
            tag = (
                f"{r.symbol.qualified} @ {lab['file']}:{lab['line']} "
                f"[{lab['reason']}]"
            )
            if lab["likely_real_caller"]:
                ast_only_real.append(tag)
            else:
                confused.append(f"AST false positive: {tag}")

    console.print(Rule("[bold]Disagreement analysis (auto-labeled, TS-aware)[/bold]"))

    def _panel(title: str, items: list[str], color: str) -> None:
        body = "\n".join(f"- {x}" for x in items[:12]) if items else "(none)"
        console.print(Panel(body, title=title, border_style=color))

    _panel("tree-sitter blind spots: TS-idiomatic refs LSP surfaced first "
           "(type_annotation / generic / reexport / type_only_import / "
           "discriminated_union_narrow)",
           ts_blind_spots, "bright_yellow")
    _panel("lsp_only_real  (LSP found, AST missed — real refs)", lsp_only_real, "yellow")
    _panel("ast_only_real  (AST found, LSP missed — real refs)", ast_only_real, "red")
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

    def _enc_ast(r: SymbolResult) -> set[str]:
        return {a.referrer_symbol for a in r.ast_refs if a.referrer_symbol}

    def _enc_lsp(r: SymbolResult) -> set[str]:
        s: set[str] = set()
        for ref in r.lsp_refs:
            enc = enclosing_node_for(db, ref.referrer_file, ref.referrer_line)
            if enc:
                s.add(enc)
        return s

    union_size = inter_size = 0
    for r in results:
        a, b = _enc_ast(r), _enc_lsp(r)
        inter_size += len(a & b)
        union_size += len(a | b)
    enc_agreement = inter_size / union_size if union_size else 0.0

    ast_samples = sum(len(r.ast_only_labels) for r in results)
    ast_fp = sum(
        1 for r in results for l in r.ast_only_labels if not l["likely_real_caller"]
    )
    ast_fp_rate = ast_fp / ast_samples if ast_samples else 0.0

    def _lsp_signal(lab: dict) -> bool:
        return lab["reason"] not in ("def_site", "import", "comment")

    lsp_signal_samples = sum(
        1 for r in results for l in r.lsp_only_labels if _lsp_signal(l)
    )
    ast_blind = sum(
        1 for r in results for l in r.lsp_only_labels
        if _lsp_signal(l) and l["likely_real_caller"]
    )
    ast_blind_rate = ast_blind / lsp_signal_samples if lsp_signal_samples else 0.0

    t = Table(title="Rollup metrics (ts-lsp vs AST)", show_header=False, box=None)
    t.add_column(justify="right", style="bold cyan")
    t.add_column()
    t.add_row("Total ts-lsp references", str(total_lsp))
    t.add_row("Total AST references", str(total_ast))
    t.add_row("Line-level agreed (±2)", str(total_agreed))
    t.add_row(
        "Line-level agreement rate",
        f"{agreement_rate:.1%}  (low expected: AST=def-lines, LSP=call-lines)",
    )
    t.add_row("Enclosing-function agreement (Jaccard)", f"{enc_agreement:.1%}")
    t.add_row("ts-lsp-only (candidate AST blind spots)", str(total_lsp_only))
    t.add_row("AST-only (candidate AST false positives)", str(total_ast_only))
    t.add_row(
        "Est. AST false-positive rate",
        f"{ast_fp_rate:.1%}  (from {ast_samples} labeled samples)",
    )
    t.add_row(
        "Est. AST blind-spot rate",
        f"{ast_blind_rate:.1%}  (from {lsp_signal_samples} caller-like samples)",
    )
    console.print(t)
    return agreement_rate, enc_agreement, ast_fp_rate, ast_blind_rate


def render_takeaway(
    results: list[SymbolResult],
    cold_start: float,
    avg_latency: float,
    py_vs_ts: dict[str, Any],
) -> None:
    ts_calls_total = sum(len(r.lsp_callers) for r in results)
    ts_calls_nonzero = sum(1 for r in results if r.lsp_callers)
    ts_refs_total = sum(len(r.lsp_refs) for r in results)
    ts_impls_nonzero = sum(1 for r in results if r.lsp_impls)
    n = len(results)
    prep_nonzero = sum(1 for r in results if r.prepare_call_hierarchy_count > 0)

    ts_surface_tags = {
        "type_annotation", "generic_instantiation", "type_only_import",
        "reexport", "discriminated_union_narrow",
    }
    ts_idiom_count = sum(
        1 for r in results for l in r.lsp_only_labels
        if l["reason"] in ts_surface_tags and l["likely_real_caller"]
    )

    if ts_calls_total > 0:
        ch_status = (
            f"YES — callHierarchy returned {ts_calls_total} callers "
            f"across {ts_calls_nonzero}/{n} symbols."
        )
    elif prep_nonzero > 0:
        ch_status = (
            f"PARTIAL — prepareCallHierarchy succeeded on {prep_nonzero}/{n} symbols "
            "but incomingCalls returned 0."
        )
    else:
        ch_status = "NO — prepareCallHierarchy returned empty for every symbol."

    py = py_vs_ts.get("pyright", {})
    py_avg = py.get("refs_avg_per_symbol") or 0.0
    ts_avg = py_vs_ts.get("ts", {}).get("refs_avg_per_symbol", 0.0)
    latency_ratio = (avg_latency / py.get("avg_latency_s", 1.0)) if py.get("avg_latency_s") else 0.0

    refs_compare = (
        f"TS LSP avg refs/symbol = {ts_avg:.1f} vs pyright {py_avg:.1f} "
        f"(different repos, but normalized by symbol)."
    )

    if ts_impls_nonzero > 0:
        impl_line = (
            f"textDocument/implementation worked on {ts_impls_nonzero} symbol(s) — "
            "a TS-idiomatic capability pyright cannot exploit (no Python interfaces)."
        )
    else:
        impl_line = (
            "textDocument/implementation returned empty on every symbol. Double-check "
            "that interface targets are queried at the declaration identifier."
        )

    blind_line = (
        f"tree-sitter AST blind spots surfaced by ts-lsp ({ts_idiom_count} TS-idiomatic examples): "
        "type annotations, generic instantiations, re-exports, and type-only imports."
    )

    latency_line = (
        f"Cold start {cold_start:.1f}s (vs pyright {py.get('cold_start_s', 0.0):.1f}s), "
        f"avg per-symbol latency {avg_latency:.2f}s "
        f"(vs pyright {py.get('avg_latency_s', 0.0):.2f}s, "
        f"ratio {latency_ratio:.1f}x)."
    )

    if ts_calls_total > 0 and ts_refs_total > 0:
        recommendation = (
            "Use typescript-language-server at index time as the TypeScript caller oracle. "
            "callHierarchy delivers real incoming-call data, references captures type-level "
            "usages the AST misses, and implementation lifts interface→class edges for free. "
            "Cold start is the one-time cost; amortize across a long-lived indexer process."
        )
    elif ts_refs_total > 0:
        recommendation = (
            "Use typescript-language-server as the references oracle. callHierarchy is "
            "incomplete on this run — fall back to references + heuristic enclosing-symbol "
            "lookups for the caller graph until the tsserver regression is root-caused."
        )
    else:
        recommendation = (
            "BLOCKED — typescript-language-server returned no references. Likely tsserver "
            "project-load did not complete; investigate didOpen ordering and workspace "
            "folders before concluding."
        )

    body = (
        f"callHierarchy working? {ch_status}\n\n"
        f"{refs_compare}\n\n"
        f"{impl_line}\n\n"
        f"{blind_line}\n\n"
        f"{latency_line}\n\n"
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
    py_vs_ts: dict,
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
        "python_vs_typescript": py_vs_ts,
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


def write_goldens(results: list[SymbolResult], repo_head: str) -> None:
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
                        "source": "ts-lsp",
                        "labeler_note": f"ts-lsp was right, AST was wrong: {lab['reason']}",
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
                        "labeler_note": f"AST was right, ts-lsp was wrong: {lab['reason']}",
                    }
                )
        if not callers:
            continue
        goldens.append(
            {
                "fixture": "opencodehub",
                "commit": repo_head,
                "target": r.symbol.node_id,
                "method_callers": callers,
                "labeler": "opus-4-7",
                "labeled_at": now,
            }
        )
    GOLDENS_YAML.write_text(yaml.safe_dump(goldens, sort_keys=False))
    console.print(f"[green]wrote[/green] {GOLDENS_YAML} ({len(goldens)} golden cases)")


# ---------------------------------------------------------------------------
# Initialize
# ---------------------------------------------------------------------------


async def initialize_ts_lsp(client: LspClient) -> float:
    t0 = time.perf_counter()
    init_params: dict[str, Any] = {
        "processId": os.getpid(),
        "clientInfo": {"name": "spike-ts-oracle", "version": "0.1"},
        "rootUri": TARGET_REPO.as_uri(),
        "rootPath": str(TARGET_REPO),
        "workspaceFolders": [
            {"uri": TARGET_REPO.as_uri(), "name": "opencodehub"}
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
            "tsserver": {
                "logVerbosity": "off",
                "path": str(TSSERVER_JS),
            },
            "preferences": {
                "includeInlayParameterNameHints": "none",
                "includeInlayPropertyDeclarationTypeHints": False,
                "includeInlayFunctionLikeReturnTypeHints": False,
            },
        },
    }
    await client.request("initialize", init_params, timeout=90.0)
    await client.notify("initialized", {})
    # Nudge tsserver with a didChangeConfiguration so it pulls workspace config.
    await client.notify(
        "workspace/didChangeConfiguration",
        {"settings": {}},
    )
    # Warmup: open one file per workspace package root so tsserver loads
    # every inferred project up front. Without this, the first
    # cross-package references query returns empty because the target
    # package's tsconfig hasn't been loaded yet. For each package we also
    # fire a no-op references request against the opened file; tsserver
    # blocks the request until the project is loaded, so the timing is
    # honest.
    package_roots = sorted(TARGET_REPO.glob("packages/*/src/index.ts"))
    for idx, warmup_file in enumerate(package_roots):
        try:
            text = warmup_file.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        await client.notify(
            "textDocument/didOpen",
            {
                "textDocument": {
                    "uri": warmup_file.as_uri(),
                    "languageId": "typescript",
                    "version": 1,
                    "text": text,
                }
            },
        )
        # Only block-wait on the last package; earlier opens parallelize
        # under the hood via tsserver's project scan.
        if idx == len(package_roots) - 1:
            try:
                await client.request(
                    "textDocument/references",
                    {
                        "context": {"includeDeclaration": False},
                        "textDocument": {"uri": warmup_file.as_uri()},
                        "position": {"line": 0, "character": 0},
                    },
                    timeout=INIT_PROGRESS_CAP_S,
                )
            except Exception as exc:  # noqa: BLE001
                console.print(f"[yellow]warmup references errored:[/yellow] {exc}")
    return time.perf_counter() - t0


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


async def _main_async() -> None:
    t_total = time.perf_counter()

    ensure_preconditions()
    ts_lsp_version, tsserver_version = ensure_ts_lsp()
    try:
        node_version = subprocess.check_output(
            ["node", "--version"], text=True
        ).strip()
    except Exception:
        node_version = "unknown"

    try:
        repo_head = subprocess.check_output(
            ["git", "-C", str(TARGET_REPO), "rev-parse", "HEAD"], text=True
        ).strip()
    except Exception:
        repo_head = "unknown"

    tsconfigs = [
        str(p.relative_to(TARGET_REPO))
        for p in TARGET_REPO.glob("packages/*/tsconfig.json")
    ]
    if (TARGET_REPO / "tsconfig.json").exists():
        tsconfigs.insert(0, "tsconfig.json")

    console.print(Rule("[bold]TypeScript LSP Oracle Spike[/bold]"))
    db = duckdb.connect(str(GRAPH_DB_PATH), read_only=True)
    symbols = pick_symbols(db)

    render_environment(
        py_version=sys.version.split()[0],
        ts_lsp_version=ts_lsp_version,
        tsserver_version=tsserver_version,
        node_version=node_version,
        tsconfigs=tsconfigs,
        symbols=symbols,
        repo_head=repo_head,
    )
    render_sample(symbols)

    console.print(Rule("[cyan]starting typescript-language-server[/cyan]"))
    client = await launch_ts_lsp()
    console.print("[green]launched[/green] typescript-language-server --stdio")

    try:
        cold_start_s = await initialize_ts_lsp(client)
        console.print(f"[green]ts-lsp ready[/green] after {cold_start_s:.2f}s")
        results_map, timings = await run_ts_queries(client, symbols)
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
    avg_latency = sum(timings.values()) / len(timings) if timings else 0.0
    wallclock = {
        "cold_start_s": cold_start_s,
        "avg_latency_s": avg_latency,
        "total_s": time.perf_counter() - t_total,
        "per_symbol": dict(timings),
    }
    py_vs_ts = render_python_vs_ts(results, wallclock)
    render_wallclock(cold_start_s, list(timings.values()), time.perf_counter() - t_total)
    render_labels(results)
    agreement, enc_agreement, ast_fp, ast_blind = render_rollup(db, results)

    render_takeaway(results, cold_start_s, avg_latency, py_vs_ts)

    dump_json(
        results,
        env_info={
            "python": sys.version,
            "lsp_backend": "typescript-language-server",
            "lsp_version": ts_lsp_version,
            "tsserver_version": tsserver_version,
            "node_version": node_version,
            "target_repo": str(TARGET_REPO),
            "repo_head": repo_head,
            "tsconfigs": tsconfigs,
        },
        wallclock=wallclock,
        rollup={
            "line_agreement_rate": agreement,
            "enclosing_agreement_jaccard": enc_agreement,
            "ast_false_positive_rate_sampled": ast_fp,
            "ast_blind_spot_rate_sampled": ast_blind,
        },
        py_vs_ts=py_vs_ts,
    )
    write_goldens(results, repo_head)
    db.close()


def main() -> None:
    asyncio.run(_main_async())


if __name__ == "__main__":
    main()
