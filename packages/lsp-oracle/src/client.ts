/**
 * High-level pyright-langserver adapter.
 *
 * `PyrightClient` is the package's entire public surface. It owns:
 *
 *   - pyright subprocess lifecycle (spawn, stdin/stdout/stderr wiring,
 *     graceful shutdown with force-kill fallback after 5s)
 *   - LSP handshake (`initialize` / `initialized`, plus workspace config
 *     round-trip so pyright picks up pythonPath and extraPaths)
 *   - one-shot `textDocument/didOpen` per file before the first query
 *     on that file (required — pyright won't answer queries against URIs
 *     it hasn't been told about)
 *   - three public query methods (`queryCallers`, `queryReferences`,
 *     `queryImplementations`) that normalize pyright's 0-indexed LSP
 *     responses back into the 1-indexed positions the rest of our stack
 *     uses
 *   - the constructor-redirect fix for `__init__` callers (pyright
 *     attaches ctor references to the *class* symbol, not the `__init__`
 *     method — we detect empty results from `__init__` and retry against
 *     the class location automatically)
 *   - the `callHierarchy` → `references` fallback when pyright can't
 *     build a call-hierarchy item for the symbol (best-effort; flagged
 *     via `source: "references"` on the returned sites so consumers can
 *     downweight the provenance if they care)
 */

import { createRequire } from "node:module";
import path from "node:path";

import { BaseLspClient } from "./base-client.js";
import type { JsonRpcDispatcher } from "./jsonrpc.js";
import type {
  CallerSite,
  ClientStatus,
  PyrightClientOptions,
  PythonResolutionMode,
  QueryCallersInput,
} from "./types.js";
import { detectPythonEnv } from "./venv.js";

/**
 * Resolve the command + args to launch pyright-langserver. Prefers the
 * binary bundled inside the `pyright` npm package (so downstream users
 * never hit a "pyright-langserver not found" error), falls back to
 * whatever is on PATH.
 */
function resolveServerCommand(override?: readonly string[]): readonly string[] {
  if (override && override.length > 0) {
    return override;
  }
  try {
    const require = createRequire(import.meta.url);
    // pyright's npm package exposes the langserver at this path.
    const langserverJs = require.resolve("pyright/langserver.index.js");
    return [process.execPath, langserverJs, "--stdio"];
  } catch {
    return ["pyright-langserver", "--stdio"];
  }
}

export class PyrightClient extends BaseLspClient {
  private readonly resolvedCommand: readonly string[];
  private readonly pythonPathOverride: string | null;
  private pythonResolutionMode: PythonResolutionMode = "bundled-stdlib";
  private resolvedPythonPath: string | null = null;

  constructor(options: PyrightClientOptions) {
    super({
      workspaceRoot: options.workspaceRoot,
      ...(options.indexWaitMs !== undefined ? { indexWaitMs: options.indexWaitMs } : {}),
      ...(options.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: options.requestTimeoutMs }
        : {}),
    });
    this.resolvedCommand = resolveServerCommand(options.serverCommand);
    this.pythonPathOverride = options.pythonPath ?? null;
  }

  protected override serverCommand(): { cmd: string; args: readonly string[] } {
    const [cmd, ...args] = this.resolvedCommand;
    return { cmd: cmd ?? "", args };
  }

  protected override serverEnv(): NodeJS.ProcessEnv {
    return { ...process.env, PYTHONIOENCODING: "utf-8" };
  }

  protected override clientName(): string {
    return "pyright";
  }

  protected override languageId(): string {
    return "python";
  }

  protected override onBeforeStart(): void {
    if (this.pythonPathOverride !== null) {
      this.pythonResolutionMode = "venv";
      this.resolvedPythonPath = this.pythonPathOverride;
    } else {
      const detected = detectPythonEnv(this.workspaceRoot);
      this.pythonResolutionMode = detected.mode;
      this.resolvedPythonPath = detected.pythonPath;
    }
  }

  protected override initializationOptions(): unknown {
    return {
      python: { pythonPath: this.resolvedPythonPath ?? undefined },
      pyright: {
        disableLanguageServices: false,
        disableOrganizeImports: true,
        reportMissingImports: "warning",
      },
    };
  }

  protected override onInitialized(dispatcher: JsonRpcDispatcher): void {
    dispatcher.notify("workspace/didChangeConfiguration", {
      settings: {
        python: { pythonPath: this.resolvedPythonPath ?? undefined },
        "python.analysis": {
          autoSearchPaths: true,
          useLibraryCodeForTypes: true,
          diagnosticMode: "workspace",
          extraPaths: ["src"],
        },
      },
    });
  }

  protected override onServerRequest(method: string, params: unknown): unknown {
    switch (method) {
      case "workspace/configuration": {
        const p = (params ?? {}) as { items?: Array<{ section?: string }> };
        const items = p.items ?? [];
        return items.map((item) => {
          const section = item.section ?? "";
          if (section.startsWith("python.analysis")) {
            return {
              autoSearchPaths: true,
              useLibraryCodeForTypes: true,
              diagnosticMode: "workspace",
              extraPaths: ["src"],
            };
          }
          if (section === "python") {
            return { pythonPath: this.resolvedPythonPath };
          }
          return {};
        });
      }
      case "window/workDoneProgress/create":
      case "client/registerCapability":
      case "client/unregisterCapability":
        return null;
      default:
        return null;
    }
  }

  override getStatus(): ClientStatus {
    return {
      started: this.started,
      indexingComplete: this.indexingComplete,
      pythonResolutionMode: this.pythonResolutionMode,
      pythonPath: this.resolvedPythonPath,
      workspaceRoot: this.workspaceRoot,
      coldStartMs: this.coldStartMs,
      serverCommand: this.resolvedCommand,
    };
  }

  /**
   * Find incoming callers for a symbol.
   *
   * Strategy:
   *   1. `textDocument/prepareCallHierarchy` on the given position.
   *   2. If it returns items, call `callHierarchy/incomingCalls` on the
   *      first item and map results to `CallerSite[]`.
   *   3. If `__init__` is the method name AND callers came back empty,
   *      re-query the enclosing class name at its definition. Pyright
   *      attaches constructor references to the class, not `__init__`.
   *   4. If call-hierarchy yields nothing at all, fall back to
   *      `textDocument/references` and tag each site `source: "references"`
   *      — a lossy but non-empty answer is better than an empty one.
   */
  override async queryCallers(input: QueryCallersInput): Promise<readonly CallerSite[]> {
    await this.ensureOpen(input.filePath);

    const primary = await this.callHierarchyIncoming(input.filePath, input.line, input.character);

    if (primary.length > 0) {
      return primary;
    }

    // Constructor redirect: when the symbol is `Foo.__init__` but pyright
    // returned no incoming calls, try the class definition instead. The
    // caller owns locating the class position — but we do the redirect
    // ourselves for the common case where the class lives in the same
    // file, one or two lines above the method.
    if (input.symbolKind === "method" && input.symbolName.endsWith(".__init__")) {
      const redirected = await this.tryConstructorRedirect(input);
      if (redirected.length > 0) {
        return redirected;
      }
    }

    const refs = await this.queryReferences({
      filePath: input.filePath,
      line: input.line,
      character: input.character,
    });
    return refs.map((r) => ({
      file: r.file,
      line: r.line,
      character: r.character,
      source: "references" as const,
    }));
  }

  /**
   * Constructor redirect — try the class that owns this `__init__`.
   *
   * We scan the file's text backwards from the `__init__` line looking
   * for the nearest `class Foo(` or `class Foo:` header, then re-query
   * call-hierarchy at the `Foo` identifier. This isn't perfect (nested
   * classes can fool it), but for the > 99% common case of a top-level
   * class it's exactly right and hides the Python quirk from consumers.
   */
  private async tryConstructorRedirect(input: QueryCallersInput): Promise<CallerSite[]> {
    const parts = input.symbolName.split(".");
    if (parts.length < 2) return [];
    const className = parts[parts.length - 2];
    if (className === undefined) return [];

    const abs = path.isAbsolute(input.filePath)
      ? input.filePath
      : path.join(this.workspaceRoot, input.filePath);

    let contents: string;
    try {
      const { readFileSync } = await import("node:fs");
      contents = readFileSync(abs, "utf-8");
    } catch {
      return [];
    }
    const lines = contents.split(/\r?\n/);
    const classHeaderRe = new RegExp(
      `^(\\s*)class\\s+${className.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`,
    );
    let classLine1 = -1;
    let classCol1 = -1;
    const startIdx = Math.min(Math.max(0, input.line - 1), lines.length - 1);
    for (let i = startIdx; i >= 0; i -= 1) {
      const raw = lines[i];
      if (raw === undefined) continue;
      const match = classHeaderRe.exec(raw);
      if (match) {
        const leading = match[1] ?? "";
        const colZero = leading.length + "class ".length;
        classLine1 = i + 1;
        classCol1 = colZero + 1;
        break;
      }
    }
    if (classLine1 === -1) return [];
    return this.callHierarchyIncoming(input.filePath, classLine1, classCol1);
  }
}
