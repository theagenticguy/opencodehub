/**
 * Public type contract for the LSP oracle.
 *
 * `PyrightClient` hides everything Python- and pyright-specific behind
 * these types. Downstream consumers (ingestion, analysis, CLI tools) only
 * see file-relative paths, 1-indexed positions, and a small set of
 * symbol-kind discriminators.
 */

/**
 * Symbol kinds we distinguish when querying pyright. These match the
 * OpenCodeHub graph's node taxonomy, not LSP's `SymbolKind` enum.
 *
 * `method` includes constructors (`__init__`). The constructor-redirect
 * behavior in `queryCallers` is keyed on this + a name ending in `.__init__`.
 */
export type SymbolKind = "class" | "method" | "function" | "property";

/** Pyright's workspace indexing modes, as reported by `getStatus()`. */
export type PythonResolutionMode = "venv" | "bundled-stdlib";

/**
 * 1-indexed file position. LSP uses 0-indexed line/character internally,
 * but every graph node and IDE-reported position in our stack is
 * 1-indexed; we convert at the boundary so consumers don't have to
 * remember.
 */
export interface FilePosition {
  readonly filePath: string;
  readonly line: number;
  readonly character: number;
}

export interface QueryCallersInput extends FilePosition {
  readonly symbolKind: SymbolKind;
  /**
   * Fully-qualified name of the symbol being queried, e.g.
   * `"Agent.invoke_async"` or `"MyClass.__init__"`. Used to detect the
   * constructor-redirect case (see `PyrightClient.queryCallers`).
   */
  readonly symbolName: string;
}

/** A single call-site or reference site returned by the oracle. */
export interface CallerSite {
  /** Path relative to the workspace root, forward-slash separated. */
  readonly file: string;
  /** 1-indexed line number of the call/reference. */
  readonly line: number;
  /** 1-indexed column of the first character of the call/reference token. */
  readonly character: number;
  /**
   * Name of the symbol that encloses the call site, as reported by
   * pyright's call-hierarchy (e.g. `"handle_request"`). Absent on sites
   * recovered via the `textDocument/references` fallback, which doesn't
   * include enclosing-symbol metadata.
   */
  readonly enclosingSymbolName?: string;
  /**
   * Provenance flag — `"callHierarchy"` if the site came from pyright's
   * `callHierarchy/incomingCalls`, `"references"` if it came from the
   * reference-based fallback when call-hierarchy returned empty.
   */
  readonly source: "callHierarchy" | "references";
}

/** A single reference site (raw `textDocument/references` result). */
export interface ReferenceSite {
  readonly file: string;
  readonly line: number;
  readonly character: number;
}

/** A single implementation site (raw `textDocument/implementation` result). */
export interface ImplementationSite {
  readonly file: string;
  readonly line: number;
  readonly character: number;
}

export interface ClientStatus {
  readonly started: boolean;
  readonly indexingComplete: boolean;
  readonly pythonResolutionMode: PythonResolutionMode;
  readonly pythonPath: string | null;
  readonly workspaceRoot: string;
  readonly coldStartMs: number | null;
  readonly serverCommand: readonly string[];
}

export interface PyrightClientOptions {
  /** Absolute path to the repository root pyright should index. */
  readonly workspaceRoot: string;
  /**
   * Explicit Python interpreter path. When omitted, a venv is auto-
   * detected at `${workspaceRoot}/.venv/bin/python` or `.../venv/...`;
   * if neither exists, pyright runs against its bundled stdlib.
   */
  readonly pythonPath?: string;
  /**
   * Ceiling on how long `start()` will wait for pyright's initial
   * workspace indexing to emit `$/progress kind: "end"`. If no end marker
   * arrives by the deadline, `start()` resolves with a console warning
   * and marks the client ready anyway — queries still work, they just
   * may race with ongoing indexing. Defaults to 15,000 ms.
   */
  readonly indexWaitMs?: number;
  /**
   * Per-request LSP timeout in milliseconds. Defaults to 60,000 ms —
   * generous because pyright can stall on large files while the cache
   * is warming.
   */
  readonly requestTimeoutMs?: number;
  /**
   * Override how we invoke pyright-langserver. Defaults to the binary
   * shipped by the `pyright` npm package. Pass `["pyright-langserver",
   * "--stdio"]` to use whatever's first on PATH.
   */
  readonly serverCommand?: readonly string[];
}
