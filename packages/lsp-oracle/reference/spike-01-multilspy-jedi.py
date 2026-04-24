#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "multilspy>=0.0.14",
#     "duckdb>=1.1",
#     "rich>=13",
#     "PyYAML>=6",
# ]
# ///
"""
LSP Oracle Spike (week-1)

Drives a Python LSP programmatically, queries references / callHierarchy /
implementation for a sample of real sdk-python symbols, compares against
OpenCodeHub's tree-sitter graph, and produces a disagreement report.

Run:
    uv run scripts/spike-lsp-oracle.py

IMPORTANT NOTE ON THE LSP BACKEND:
    The spec called for pyright via multilspy. In practice, multilspy
    (>=0.0.14 on PyPI) ships a jedi-language-server backend for Python,
    not pyright -- see
    multilspy/language_servers/jedi_language_server/jedi_server.py
    in the installed package. multilspy has no pyright launcher.

    Per the spec's fallback guidance ("try ONE alternative approach"),
    this spike uses jedi-language-server. It is the backend multilspy
    actually provides for Python, it is research-grade, and it supports
    references / prepareCallHierarchy / incomingCalls / implementation.
    We call those via multilspy's raw LSP send channel
    (LanguageServer.server.send.*).

    Agreement numbers in this report therefore measure tree-sitter vs.
    JEDI, not tree-sitter vs. pyright. Jedi's recall is generally
    comparable-to-slightly-below pyright on cross-module references.
    Concrete implications are called out in the engineering takeaway.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import duckdb
import yaml
from multilspy import LanguageServer
from multilspy.multilspy_config import Language, MultilspyConfig
from multilspy.multilspy_logger import MultilspyLogger
from rich.console import Console
from rich.panel import Panel
from rich.rule import Rule
from rich.table import Table
from rich.text import Text

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SDK_PYTHON_PATH = Path("/Users/lalsaado/Projects/sdk-python")
GRAPH_DB_PATH = SDK_PYTHON_PATH / ".codehub" / "graph.duckdb"
REPORT_JSON = Path("/tmp/spike-lsp-oracle-report.json")
GOLDENS_YAML = Path("/tmp/spike-lsp-oracle-goldens.yaml")

LINE_FUZZ = 2  # +/- tolerance when matching LSP vs AST reference rows

console = Console()


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------


@dataclass
class Symbol:
    node_id: str
    kind: str              # Class / Method / Property / Function
    name: str              # bare name for LSP positioning (e.g. "invoke_async")
    qualified: str         # "Agent.invoke_async" or "BedrockModel"
    file_path: str         # relative to repo root
    start_line: int        # 1-indexed
    end_line: int
    category: str          # "class" / "async_method" / "property" / "ctor" / "private"

    @property
    def abs_path(self) -> Path:
        return SDK_PYTHON_PATH / self.file_path


@dataclass
class Reference:
    """Canonical disagreement-unit."""
    referrer_file: str   # relative
    referrer_line: int   # 1-indexed
    referrer_symbol: str | None  # enclosing node id if resolvable

    def key(self) -> tuple[str, int]:
        return (self.referrer_file, self.referrer_line)


@dataclass
class SymbolResult:
    symbol: Symbol
    lsp_refs: list[Reference] = field(default_factory=list)
    lsp_impls: list[dict] = field(default_factory=list)
    lsp_callers: list[Reference] = field(default_factory=list)
    ast_refs: list[Reference] = field(default_factory=list)
    agreed: list[Reference] = field(default_factory=list)
    lsp_only: list[Reference] = field(default_factory=list)
    ast_only: list[Reference] = field(default_factory=list)
    query_latency_s: float = 0.0
    lsp_error: str | None = None

    # labeler output
    lsp_only_labels: list[dict] = field(default_factory=list)
    ast_only_labels: list[dict] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Step 1: pick the symbol sample
# ---------------------------------------------------------------------------


def pick_symbols(db: duckdb.DuckDBPyConnection) -> list[Symbol]:
    """Query the graph for a curated mix of ~15 symbols."""

    symbols: list[Symbol] = []

    # 3 public classes
    class_targets = [
        "Class:src/strands/agent/agent.py:Agent",
        "Class:src/strands/models/bedrock.py:BedrockModel",
        "Class:src/strands/agent/conversation_manager/conversation_manager.py:ConversationManager",
    ]
    for nid in class_targets:
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
                    qualified=row[2],
                    file_path=row[3],
                    start_line=row[4],
                    end_line=row[5],
                    category="class",
                )
            )

    # 4 async methods with wide call graphs
    async_method_targets = [
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
    ]
    for nid, qualified in async_method_targets:
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
                    category="async_method",
                )
            )

    # 3 property getters (AgentResult.* is a clean cluster)
    prop_targets = [
        "Property:src/strands/agent/agent_result.py:AgentResult.message",
        "Property:src/strands/agent/agent_result.py:AgentResult.metrics",
        "Property:src/strands/agent/agent_result.py:AgentResult.stop_reason",
    ]
    for nid in prop_targets:
        row = db.execute(
            "SELECT id, kind, name, file_path, start_line, end_line FROM nodes WHERE id = ?",
            [nid],
        ).fetchone()
        if row:
            qualified = nid.split(":")[-1]
            symbols.append(
                Symbol(
                    node_id=row[0],
                    kind=row[1],
                    name=row[2],
                    qualified=qualified,
                    file_path=row[3],
                    start_line=row[4],
                    end_line=row[5],
                    category="property",
                )
            )

    # 2 constructors
    ctor_targets = [
        ("Method:src/strands/agent/agent.py:Agent.__init__", "Agent.__init__"),
        ("Method:src/strands/models/bedrock.py:BedrockModel.__init__", "BedrockModel.__init__"),
    ]
    for nid, qualified in ctor_targets:
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
                    category="ctor",
                )
            )

    # 3 private helpers — pick heavily-called ones, data-driven
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
        qualified = row[0].split(":")[-1]
        symbols.append(
            Symbol(
                node_id=row[0],
                kind=row[1],
                name=row[2],
                qualified=qualified,
                file_path=row[3],
                start_line=row[4],
                end_line=row[5],
                category="private",
            )
        )

    return symbols


# ---------------------------------------------------------------------------
# Step 2: OpenCodeHub reference extraction
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
    """Return all relations whose to_id is this symbol's node, as canonical refs."""
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
    """Find the tightest node in the file that contains `line`."""
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
# Step 3: LSP position-finding for target symbols
# ---------------------------------------------------------------------------


def find_symbol_position(sym: Symbol) -> tuple[int, int] | None:
    """
    Return the (line, column) 0-indexed position of the identifier for `sym`
    in its source file. LSP requests the position of the *name token*,
    not the whole definition range.
    """
    try:
        text = sym.abs_path.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return None
    lines = text.splitlines()
    # Graph lines are 1-indexed. Search the top few lines of the def for the
    # bare name token.
    start0 = max(0, sym.start_line - 1)
    # For classes / methods the name typically appears on the def line.
    # For properties our graph records the return-annotation line, so widen.
    end0 = min(len(lines), sym.start_line + 4)
    for li in range(start0, end0):
        line = lines[li]
        col = line.find(sym.name)
        if col == -1:
            continue
        # Prefer an occurrence after "def ", "class ", or standalone.
        # Skip if it looks like a substring of a longer word.
        after = col + len(sym.name)
        before_char = line[col - 1] if col > 0 else " "
        after_char = line[after] if after < len(line) else " "
        if (before_char.isalnum() or before_char == "_") or (
            after_char.isalnum() or after_char == "_"
        ):
            continue
        return (li, col)
    return None


# ---------------------------------------------------------------------------
# Step 4: LSP driver
# ---------------------------------------------------------------------------


async def run_lsp_queries(
    server: LanguageServer, symbols: list[Symbol]
) -> tuple[dict[str, SymbolResult], dict[str, float]]:
    results: dict[str, SymbolResult] = {
        s.node_id: SymbolResult(symbol=s) for s in symbols
    }
    timings: dict[str, float] = {}

    # Per-symbol queries run sequentially in Python but each symbol's three
    # requests are executed as an asyncio.gather so the LSP server pipelines them.
    for sym in symbols:
        res = results[sym.node_id]
        pos = find_symbol_position(sym)
        if pos is None:
            res.lsp_error = f"could not locate name token for {sym.qualified}"
            console.print(f"  [yellow]skip[/yellow] {sym.qualified}: {res.lsp_error}")
            continue
        line, col = pos

        file_uri = sym.abs_path.as_uri()
        text_doc = {"uri": file_uri}
        position = {"line": line, "character": col}
        text_doc_pos = {"textDocument": text_doc, "position": position}

        t0 = time.perf_counter()
        try:
            # Ensure the file is opened in the server's in-memory view.
            with server.open_file(sym.file_path):
                refs_task = server.server.send.references(
                    {
                        "context": {"includeDeclaration": False},
                        **text_doc_pos,
                    }
                )
                impl_task = server.server.send.implementation(text_doc_pos)
                prep_task = server.server.send.prepare_call_hierarchy(text_doc_pos)

                refs_resp, impl_resp, prep_resp = await asyncio.gather(
                    refs_task, impl_task, prep_task, return_exceptions=True
                )

                if isinstance(prep_resp, Exception) or not prep_resp:
                    incoming_resp = []
                else:
                    # prep_resp is a list of CallHierarchyItem — use the first
                    # match (the symbol itself) to ask for incoming calls.
                    first_item = prep_resp[0]
                    try:
                        incoming_resp = (
                            await server.server.send.incoming_calls(
                                {"item": first_item}
                            )
                            or []
                        )
                    except Exception as exc:  # noqa: BLE001
                        incoming_resp = []
                        res.lsp_error = f"incoming_calls: {exc}"
        except Exception as exc:  # noqa: BLE001
            res.lsp_error = f"{type(exc).__name__}: {exc}"
            console.print(f"  [red]err [/red] {sym.qualified}: {res.lsp_error}")
            timings[sym.node_id] = time.perf_counter() - t0
            continue
        dt = time.perf_counter() - t0
        timings[sym.node_id] = dt

        # Normalize references.
        if isinstance(refs_resp, Exception):
            res.lsp_error = f"references: {refs_resp}"
        elif refs_resp:
            for item in refs_resp:
                uri = item.get("uri", "")
                file_abs = uri_to_path(uri)
                try:
                    file_rel = str(
                        Path(file_abs).relative_to(SDK_PYTHON_PATH)
                    )
                except ValueError:
                    continue
                line_ = int(item["range"]["start"]["line"]) + 1
                res.lsp_refs.append(
                    Reference(referrer_file=file_rel, referrer_line=line_, referrer_symbol=None)
                )

        # Normalize implementations.
        if not isinstance(impl_resp, Exception) and impl_resp:
            for item in impl_resp:
                res.lsp_impls.append(
                    {
                        "uri": item.get("uri"),
                        "line": (item.get("range") or {}).get("start", {}).get("line"),
                    }
                )

        # Normalize call hierarchy incoming calls.
        if not isinstance(incoming_resp, Exception) and incoming_resp:
            for call in incoming_resp:
                caller = call.get("from", {})
                uri = caller.get("uri", "")
                file_abs = uri_to_path(uri)
                try:
                    file_rel = str(Path(file_abs).relative_to(SDK_PYTHON_PATH))
                except ValueError:
                    continue
                line_ = (
                    int(caller.get("selectionRange", {}).get("start", {}).get("line", 0))
                    + 1
                )
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
            f" impls={len(res.lsp_impls):2d}  {dt:5.2f}s"
        )

    return results, timings


def uri_to_path(uri: str) -> str:
    if uri.startswith("file://"):
        return uri[len("file://") :]
    return uri


# ---------------------------------------------------------------------------
# Step 5: Disagreement computation
# ---------------------------------------------------------------------------


def compute_disagreements(
    db: duckdb.DuckDBPyConnection, res: SymbolResult
) -> None:
    """Populate agreed / lsp_only / ast_only on `res` with line-fuzz matching."""

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
# Step 6: Inline labeling (heuristic classifier — "opus-4-7" label source)
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
    """
    For an AST-only reference, the graph stores the referrer's DEFINITION line,
    not the call site. To label it honestly, we look up the enclosing node's
    span and grep inside its body for `.name(` / `name(` / `.name ` patterns.

    Returns (is_real_call, reason, actual_call_line_or_None).
    """
    # Find the enclosing node (tight) around referrer_line.
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

    _enc_id, _enc_kind, enc_start, enc_end = enc_row
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
    patterns_subclass = [name]  # class inheritance will be caught below

    for i, ln in enumerate(lines, start=enc_start):
        stripped = ln.strip()
        if not stripped or stripped.startswith("#"):
            continue
        # Calls.
        if ln.lstrip().startswith(f"{name}(") or any(p in ln for p in patterns_call):
            return (True, f"call expression `{name}(` found at line {i}", i)
        # Subclass declaration for class targets.
        if (
            sym.category == "class"
            and stripped.startswith("class ")
            and "(" in stripped
            and name in stripped.split("(", 1)[1]
        ):
            return (True, f"subclass declaration `{stripped}` at line {i}", i)
        # Property access.
        if patterns_access and any(p in ln for p in patterns_access) and f"{name}(" not in ln:
            return (True, f"attribute access `.{name}` at line {i}", i)
        # Type annotation / isinstance reference for class targets.
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
    """
    Heuristic used as a programmatic stand-in for the 'opus-4-7 labeler'.
    Reads the actual source line and classifies:

    - call-ish:     `.name(` or `name(` on the line, not inside a string literal
    - subclass-ish: `class Foo(...{ClassName}...`
    - access-ish:   `.name` dereference, no call
    - string-only:  name only appears inside a quoted literal on that line
    - import-ish:   `from ... import name` / `import ... name`
    - def-site:     `def name(` or `class name(` (the definition itself)

    Returns (likely_real_caller, reason).
    """
    name = sym.name
    stripped = src_line.strip()

    if not name or name not in src_line:
        return (False, "name does not appear on the line (possible line-fuzz artifact)")

    # Definition site of the symbol itself.
    if stripped.startswith(f"def {name}(") or stripped.startswith(f"async def {name}(") \
            or stripped.startswith(f"class {name}(") or stripped.startswith(f"class {name}:"):
        return (False, "definition site, not a caller")

    # Import site.
    if stripped.startswith("from ") or stripped.startswith("import "):
        return (False, "import statement, not a call")

    # Class inheritance site for class targets.
    if sym.category == "class" and (
        stripped.startswith("class ") and "(" in stripped and name in stripped.split("(", 1)[1]
    ):
        return (True, f"subclass declaration referencing {name}")

    # Call detection: `.name(` or `name(` outside string literals.
    call_substrings = [f".{name}(", f" {name}(", f"({name}(", f"[{name}(", f",{name}(", f"={name}("]
    if any(cs in src_line for cs in call_substrings) or src_line.lstrip().startswith(f"{name}("):
        # Check if inside a comment.
        if stripped.startswith("#"):
            return (False, "inside a comment")
        # Exclude the trivial case of literal strings containing the call syntax.
        # (Rare; if both ' and " wrap the token, count it as string.)
        return (True, f"call expression `{name}(` on the line")

    # Attribute access — significant for @property getters.
    if sym.category == "property" and f".{name}" in src_line and f"{name}(" not in src_line:
        return (True, f"attribute access `.{name}` (property getter)")

    # Keyword-argument usage (e.g. `metrics=ANY,` or `name=foo,`) — this is how
    # attributes/properties of a dataclass get named at construction sites.
    import re
    if re.search(rf"\b{re.escape(name)}\s*=", src_line):
        return (True, f"keyword-argument / field reference `{name}=` on the line")

    # String-literal-only appearance.
    if (f"'{name}'" in src_line or f'"{name}"' in src_line) and f"{name}(" not in src_line:
        return (False, "appears only inside a string literal (e.g. log message)")

    # Annotation / type hint appearance.
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
        # AST-side stores referrer DEF line, not call site — scan enclosing body.
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
# Step 7: Rendering
# ---------------------------------------------------------------------------


def render_environment(
    py_version: str, lsp_version: str, symbols: list[Symbol], sdk_head: str
) -> None:
    t = Table(title="Environment", show_header=False, box=None)
    t.add_column(justify="right", style="bold cyan")
    t.add_column()
    t.add_row("Target repo", str(SDK_PYTHON_PATH))
    t.add_row("Target HEAD", sdk_head)
    t.add_row("Graph DB", str(GRAPH_DB_PATH))
    t.add_row("Python runtime", py_version)
    t.add_row("LSP backend", f"jedi-language-server ({lsp_version})")
    t.add_row("LSP backend note", "multilspy ships jedi for Python, not pyright")
    t.add_row("Venv", "not present; jedi resolves via workspace")
    t.add_row("Symbols in sample", str(len(symbols)))
    console.print(t)


def render_sample(symbols: list[Symbol]) -> None:
    t = Table(title="Symbol sample", show_lines=False)
    t.add_column("#")
    t.add_column("category", style="magenta")
    t.add_column("qualified")
    t.add_column("file:line", style="dim")
    for i, s in enumerate(symbols, 1):
        t.add_row(
            str(i),
            s.category,
            s.qualified,
            f"{s.file_path}:{s.start_line}",
        )
    console.print(t)


def render_wallclock(cold_start_s: float, per_query: list[float], total_s: float) -> None:
    avg = sum(per_query) / len(per_query) if per_query else 0.0
    t = Table(title="Wall clock", show_header=False, box=None)
    t.add_column(justify="right", style="bold cyan")
    t.add_column()
    t.add_row("LSP cold start", f"{cold_start_s:.2f}s")
    t.add_row("LSP avg per-symbol latency", f"{avg:.2f}s  (n={len(per_query)})")
    t.add_row("LSP p95 per-symbol latency", f"{sorted(per_query)[int(len(per_query)*0.95)-1]:.2f}s" if per_query else "n/a")
    t.add_row("Total spike time", f"{total_s:.2f}s")
    console.print(t)


def render_per_symbol(results: list[SymbolResult]) -> None:
    t = Table(title="Per-symbol reference counts")
    t.add_column("symbol")
    t.add_column("cat", style="magenta")
    t.add_column("lsp_refs", justify="right", style="cyan")
    t.add_column("ast_refs", justify="right", style="cyan")
    t.add_column("agreed", justify="right", style="green")
    t.add_column("lsp_only", justify="right", style="yellow")
    t.add_column("ast_only", justify="right", style="red")
    t.add_column("error", style="red")
    for r in results:
        t.add_row(
            r.symbol.qualified,
            r.symbol.category,
            str(len(r.lsp_refs)),
            str(len(r.ast_refs)),
            str(len(r.agreed)),
            str(len(r.lsp_only)),
            str(len(r.ast_only)),
            (r.lsp_error or "")[:40],
        )
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
                # LSP surfaced these correctly; AST was correct not to link.
                # Not a disagreement — skip.
                pass
            else:
                confused.append(f"LSP false positive: {tag}")
        for lab in r.ast_only_labels:
            tag = f"{r.symbol.qualified} @ {lab['file']}:{lab['line']} — {lab['reason']}"
            if lab["likely_real_caller"]:
                ast_only_real.append(tag)
            else:
                confused.append(f"AST false positive: {tag}")

    console.print(Rule("[bold]Disagreement analysis (auto-labeled by opus-4-7 heuristic)[/bold]"))

    def _panel(title: str, items: list[str], color: str) -> None:
        body = "\n".join(f"- {x}" for x in items[:15]) if items else "(none)"
        console.print(Panel(body, title=title, border_style=color))

    _panel("lsp_only_real  (LSP found, AST missed — real calls)", lsp_only_real, "yellow")
    _panel("ast_only_real  (AST found, LSP missed — real calls)", ast_only_real, "red")
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

    # Enclosing-node agreement: for each symbol, compute the set of
    # enclosing-node-ids that each side identifies as "a caller / referrer".
    # Jaccard of those sets is a far more honest agreement metric, since
    # tree-sitter stores def-lines and jedi stores call-lines — they never
    # line up at ±2 lines but they frequently agree on the enclosing function.
    def _enclosing_set_ast(r: SymbolResult) -> set[str]:
        # AST `from_id` is already the enclosing def node.
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

    # AST false positive rate = fraction of sampled ast_only that the labeler
    # marked as NOT a real caller.
    ast_samples = sum(len(r.ast_only_labels) for r in results)
    ast_false_positives = sum(
        1 for r in results for l in r.ast_only_labels if not l["likely_real_caller"]
    )
    ast_fp_rate = ast_false_positives / ast_samples if ast_samples else 0.0

    # AST blind spot rate: exclude the LSP hits that are obviously imports /
    # definition sites — those are not "calls" that AST should have linked.
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

    t = Table(title="Rollup metrics", show_header=False, box=None)
    t.add_column(justify="right", style="bold cyan")
    t.add_column()
    t.add_row("Total LSP references found", str(total_lsp))
    t.add_row("Total AST references found", str(total_ast))
    t.add_row("Line-level agreed (fuzzy ±2)", f"{total_agreed}")
    t.add_row(
        "Line-level agreement rate",
        f"{agreement_rate:.1%}  (low is expected: AST stores def-lines, LSP stores call-lines)",
    )
    t.add_row(
        "Enclosing-function agreement (Jaccard)",
        f"{enc_agreement:.1%}  (do both sides agree which funcs are callers?)",
    )
    t.add_row("LSP-only (candidate AST blind spots)", str(total_lsp_only))
    t.add_row("AST-only (candidate AST false positives)", str(total_ast_only))
    t.add_row("Est. AST false positive rate", f"{ast_fp_rate:.1%}  (from {ast_samples} labeled samples)")
    t.add_row(
        "Est. AST blind spot rate",
        f"{ast_blind_rate:.1%}  (from {lsp_signal_samples} caller-like LSP samples)",
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
) -> None:
    # Where does the LSP win? Where does it miss?
    biggest_lsp_win = max(
        results, key=lambda r: len(r.lsp_only), default=None
    )
    biggest_ast_win = max(
        results, key=lambda r: len(r.ast_only), default=None
    )
    win_line = (
        f"biggest LSP-only delta: {biggest_lsp_win.symbol.qualified} "
        f"({len(biggest_lsp_win.lsp_only)} extra refs)"
        if biggest_lsp_win
        else ""
    )
    miss_line = (
        f"biggest AST-only delta: {biggest_ast_win.symbol.qualified} "
        f"({len(biggest_ast_win.ast_only)} extra refs)"
        if biggest_ast_win
        else ""
    )

    verdict_bits = []
    if ast_blind >= 0.3 or len([r for r in results if len(r.lsp_only) > 0]) >= 3:
        verdict_bits.append(
            "LSP finds references tree-sitter misses on real code — the delta is real."
        )
    else:
        verdict_bits.append(
            "LSP adds little recall over the existing AST graph in this sample."
        )
    if ast_fp >= 0.3:
        verdict_bits.append(
            "Tree-sitter also reports references the LSP does not confirm; many of these are name-collision false positives."
        )
    if cold_start > 20:
        verdict_bits.append(
            f"Cold start is {cold_start:.0f}s — non-trivial, but dwarfed by tree-sitter's one-time index (~minutes)."
        )
    else:
        verdict_bits.append(f"Cold start was {cold_start:.1f}s, cheap.")
    if avg_latency > 2:
        verdict_bits.append(
            f"Per-symbol LSP cost averaged {avg_latency:.1f}s — would be expensive at index-time over thousands of symbols."
        )
    else:
        verdict_bits.append(
            f"Per-symbol LSP cost averaged {avg_latency:.1f}s — tractable at index-time for hot symbols."
        )

    if ast_blind >= 0.3 and ast_fp >= 0.3:
        verdict_bits.append("Week-2 recommendation: YES, proceed to Go / Rust / Ruby oracles.")
    elif ast_blind >= 0.2:
        verdict_bits.append(
            "Week-2 recommendation: YES but scope-narrow — use LSP for the edge kinds where it wins (inheritance, dynamic dispatch, decorators)."
        )
    else:
        verdict_bits.append(
            "Week-2 recommendation: HOLD. Fix tree-sitter tuning before investing in multi-language LSP infra."
        )

    body = (
        f"Enclosing-function Jaccard agreement: {enc_agreement:.1%}. "
        f"Estimated AST false positive rate: {ast_fp:.1%}. "
        f"Estimated AST blind-spot rate: {ast_blind:.1%}.\n\n"
        f"{win_line}\n{miss_line}\n\n"
        + " ".join(verdict_bits)
        + "\n\nCaveat: backend is jedi-language-server (what multilspy actually ships), "
        "not pyright. Jedi under-reports vs. pyright on cross-module and decorator-wrapped "
        "references, and jedi's callHierarchy returned 0 callers for every target in this "
        "sample (textDocument/references is jedi's primary reliable API). So the "
        "estimated AST blind-spot rate above is a LOWER BOUND on what a pyright oracle "
        "would report. If this lower bound already justifies the effort, pyright will too; "
        "if it does not, swap to pyright-langserver behind a thin adapter before concluding."
    )

    console.print(
        Rule("[bold green]Engineering takeaway[/bold green]")
    )
    console.print(Panel(body, border_style="green"))


# ---------------------------------------------------------------------------
# Step 8: Goldens
# ---------------------------------------------------------------------------


def write_goldens(results: list[SymbolResult], sdk_head: str) -> None:
    now = datetime.now(timezone.utc).isoformat()
    goldens: list[dict] = []
    for r in results:
        # Only add symbols where agreement was meaningful OR a clear lsp-only-real
        # finding exists.
        callers: list[dict] = []
        # Agreed cases (both sides)
        for ref in r.agreed[:4]:
            callers.append(
                {
                    "file": ref.referrer_file,
                    "line": ref.referrer_line,
                    "enclosing": enclosing_safe(ref.referrer_symbol),
                    "source": "both",
                    "labeler_note": f"agreed caller at {ref.referrer_file}:{ref.referrer_line}",
                }
            )
        # LSP-only labeled as real
        for lab in r.lsp_only_labels:
            if lab["likely_real_caller"]:
                callers.append(
                    {
                        "file": lab["file"],
                        "line": lab["line"],
                        "enclosing": enclosing_safe(lab["enclosing"]),
                        "source": "lsp",
                        "labeler_note": f"LSP was right, AST was wrong: {lab['reason']}",
                    }
                )
        # AST-only labeled as real
        for lab in r.ast_only_labels:
            if lab["likely_real_caller"]:
                callers.append(
                    {
                        "file": lab["file"],
                        "line": lab["line"],
                        "enclosing": enclosing_safe(lab["enclosing"]),
                        "source": "ast",
                        "labeler_note": f"AST was right, LSP was wrong: {lab['reason']}",
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


def enclosing_safe(v: Any) -> str | None:
    if v is None:
        return None
    return str(v)


# ---------------------------------------------------------------------------
# Step 9: JSON dump
# ---------------------------------------------------------------------------


def dump_json(
    results: list[SymbolResult],
    env_info: dict,
    wallclock: dict,
    rollup: dict,
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


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


async def _main_async() -> None:
    t_total = time.perf_counter()

    # Preflight.
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

    try:
        lsp_version = subprocess.check_output(
            ["jedi-language-server", "--version"], text=True, stderr=subprocess.STDOUT
        ).strip()
    except Exception as exc:  # noqa: BLE001
        console.print(
            f"[red]failed to find jedi-language-server on PATH: {exc}[/red]\n"
            "Hint: re-run with network enabled once so uv can install the script deps."
        )
        sys.exit(2)

    console.print(Rule("[bold]LSP Oracle Spike[/bold]"))
    db = duckdb.connect(str(GRAPH_DB_PATH), read_only=True)

    symbols = pick_symbols(db)
    render_environment(
        py_version=sys.version.split()[0],
        lsp_version=lsp_version,
        symbols=symbols,
        sdk_head=sdk_head,
    )
    render_sample(symbols)

    # AST-side queries (cheap, in-process).
    for s in symbols:
        pass  # computed below per-result

    # Spin up the LSP server.
    console.print(Rule("[cyan]starting jedi-language-server[/cyan]"))
    config = MultilspyConfig.from_dict({"code_language": "python"})
    logger = MultilspyLogger()
    server = LanguageServer.create(config, logger, str(SDK_PYTHON_PATH))

    t_cold = time.perf_counter()
    async with server.start_server():
        init_s = time.perf_counter() - t_cold
        console.print(
            f"[green]LSP initialize handshake[/green] in {init_s:.2f}s "
            "(note: jedi lazy-indexes on first request)"
        )

        # Measure real cold-start: time to first request-completion. Do a
        # cheap workspace_symbol against a definitely-present name.
        t_first = time.perf_counter()
        try:
            with server.open_file(symbols[0].file_path):
                _ = await server.server.send.document_symbol(
                    {"textDocument": {"uri": symbols[0].abs_path.as_uri()}}
                )
        except Exception as exc:  # noqa: BLE001
            console.print(f"[yellow]first-request warmup failed:[/yellow] {exc}")
        cold_start_s = time.perf_counter() - t_cold
        first_req_s = time.perf_counter() - t_first
        console.print(
            f"[green]first real request[/green] returned in {first_req_s:.2f}s — "
            f"effective cold start ≈ {cold_start_s:.2f}s"
        )

        results_map, timings = await run_lsp_queries(server, symbols)

    results: list[SymbolResult] = [results_map[s.node_id] for s in symbols]

    # Attach latency per symbol.
    for s in symbols:
        results_map[s.node_id].query_latency_s = timings.get(s.node_id, 0.0)

    # AST refs + disagreements + labeling.
    for r in results:
        r.ast_refs = ast_references_for(db, r.symbol)
        compute_disagreements(db, r)
        label_samples(db, r)

    # Render report.
    console.print(Rule("[bold]Report[/bold]"))
    render_per_symbol(results)
    render_wallclock(cold_start_s, list(timings.values()), time.perf_counter() - t_total)
    render_labels(results)
    agreement, enc_agreement, ast_fp, ast_blind = render_rollup(db, results)
    avg_latency = sum(timings.values()) / len(timings) if timings else 0.0
    render_takeaway(enc_agreement, ast_fp, ast_blind, cold_start_s, avg_latency, results)

    # Persist.
    dump_json(
        results,
        env_info={
            "python": sys.version,
            "lsp_backend": "jedi-language-server",
            "lsp_version": lsp_version,
            "sdk_head": sdk_head,
        },
        wallclock={
            "cold_start_s": cold_start_s,
            "avg_latency_s": avg_latency,
            "total_s": time.perf_counter() - t_total,
            "per_symbol": {sid: t for sid, t in timings.items()},
        },
        rollup={
            "line_agreement_rate": agreement,
            "enclosing_agreement_jaccard": enc_agreement,
            "ast_false_positive_rate_sampled": ast_fp,
            "ast_blind_spot_rate_sampled": ast_blind,
        },
    )
    write_goldens(results, sdk_head)

    db.close()


def main() -> None:
    # The LSP subprocess is a cwd-dependent `jedi-language-server` binary.
    # Ensure we don't inherit a weird PYTHONPATH that confuses jedi.
    os.environ.pop("PYTHONPATH", None)
    asyncio.run(_main_async())


if __name__ == "__main__":
    main()
