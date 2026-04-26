/**
 * Server-agnostic LSP client core.
 *
 * `BaseLspClient` owns the machinery every language-server adapter
 * re-implements identically:
 *
 *   - subprocess lifecycle (spawn, stdio wiring, graceful `shutdown` →
 *     `exit` → SIGKILL fallback after 5s)
 *   - LSP framing + JSON-RPC dispatcher hookup
 *   - `initialize` / `initialized` handshake and `$/progress` end wait
 *   - per-file `textDocument/didOpen` cache (`ensureOpen`)
 *   - the three common query shapes (`queryReferences`,
 *     `queryImplementations`, and a call-hierarchy `queryCallers` default)
 *   - 1-indexed ↔ 0-indexed position conversion and workspace-relative
 *     path normalization
 *
 * Language-specific behavior lives in subclasses. A subclass supplies the
 * command + env to spawn via `serverCommand()` and `serverEnv()`, the
 * `languageId` used on `didOpen`, the `initializationOptions` block, and
 * may override `onInitialized()` (for per-server config pushes),
 * `onServerRequest()` (for responders like `workspace/configuration`), and
 * `queryCallers()` (for language-specific redirects).
 */

import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { FrameDecoder } from "./framing.js";
import { JsonRpcDispatcher } from "./jsonrpc.js";
import type {
  CallerSite,
  FilePosition,
  ImplementationSite,
  QueryCallersInput,
  ReferenceSite,
} from "./types.js";

export const DEFAULT_INDEX_WAIT_MS = 15_000;
export const SHUTDOWN_GRACE_MS = 5_000;

export interface LspPosition {
  readonly line: number;
  readonly character: number;
}

export interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}

export interface LspLocation {
  readonly uri: string;
  readonly range: LspRange;
}

export interface LspCallHierarchyItem {
  readonly name: string;
  readonly kind: number;
  readonly uri: string;
  readonly range: LspRange;
  readonly selectionRange: LspRange;
  readonly data?: unknown;
}

export interface LspCallHierarchyIncomingCall {
  readonly from: LspCallHierarchyItem;
  readonly fromRanges: readonly LspRange[];
}

export interface BaseLspClientOptions {
  readonly workspaceRoot: string;
  readonly indexWaitMs?: number;
  readonly requestTimeoutMs?: number;
}

export interface BaseClientStatus {
  readonly started: boolean;
  readonly indexingComplete: boolean;
  readonly workspaceRoot: string;
  readonly coldStartMs: number | null;
  readonly serverCommand: readonly string[];
}

export function uriToFsPath(uri: string): string {
  if (uri.startsWith("file://")) {
    try {
      return fileURLToPath(uri);
    } catch {
      return uri.slice("file://".length);
    }
  }
  return uri;
}

export function toRelativeFilePath(workspaceRoot: string, absPath: string): string {
  const normalizedRoot = path.resolve(workspaceRoot);
  const normalizedAbs = path.resolve(absPath);
  if (!normalizedAbs.startsWith(normalizedRoot)) {
    return normalizedAbs.replace(/\\/g, "/");
  }
  const rel = path.relative(normalizedRoot, normalizedAbs);
  return rel.split(path.sep).join("/");
}

export function toFileUri(absPath: string): string {
  return pathToFileURL(absPath).toString();
}

export function makeTextDocumentPosition(
  workspaceRoot: string,
  filePath: string,
  line1Indexed: number,
  character1Indexed: number,
): { textDocument: { uri: string }; position: LspPosition } {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);
  return {
    textDocument: { uri: toFileUri(abs) },
    position: {
      line: Math.max(0, line1Indexed - 1),
      character: Math.max(0, character1Indexed - 1),
    },
  };
}

export abstract class BaseLspClient {
  protected readonly workspaceRoot: string;
  protected readonly indexWaitMs: number;
  protected readonly requestTimeoutMs: number;

  protected proc: ChildProcess | null = null;
  protected dispatcher: JsonRpcDispatcher | null = null;
  protected readonly openedFiles = new Set<string>();
  protected started = false;
  protected stopping = false;
  protected indexingComplete = false;
  protected coldStartMs: number | null = null;

  private progressWaiters: Array<() => void> = [];

  constructor(options: BaseLspClientOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.indexWaitMs = options.indexWaitMs ?? DEFAULT_INDEX_WAIT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  }

  protected abstract serverCommand(): { cmd: string; args: readonly string[] };
  protected abstract serverEnv(): NodeJS.ProcessEnv;
  protected abstract clientName(): string;
  protected abstract languageId(): string;
  protected abstract initializationOptions(): unknown;

  protected onInitialized(_dispatcher: JsonRpcDispatcher): Promise<void> | void {
    return;
  }

  protected onServerRequest(_method: string, _params: unknown): unknown {
    return null;
  }

  protected onBeforeStart(): Promise<void> | void {
    return;
  }

  /**
   * Extension hook fired for every `$/progress` notification from the
   * server. Default is a no-op. Subclasses (e.g. RustAnalyzerClient)
   * override this to implement server-specific warmup semantics — for
   * instance, rust-analyzer's cachePriming END is the only reliable
   * "ready for queries" signal. Called BEFORE the base class fans out
   * generic indexing-end waiters.
   */
  protected onProgress(_params: unknown): void {
    return;
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error(`lsp-oracle: ${this.clientName()}.start() already called`);
    }
    this.started = true;

    const t0 = performance.now();

    await this.onBeforeStart();

    const { cmd, args } = this.serverCommand();
    if (!cmd) {
      throw new Error("lsp-oracle: resolved serverCommand is empty");
    }
    const proc = spawn(cmd, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.serverEnv(),
    });
    this.proc = proc;

    if (proc.stdin === null || proc.stdout === null || proc.stderr === null) {
      throw new Error(`lsp-oracle: ${this.clientName()} subprocess stdio pipes are null`);
    }

    const decoder = new FrameDecoder();
    const dispatcher = new JsonRpcDispatcher({
      stdout: proc.stdin,
      onNotification: (method, params) => this.handleNotification(method, params),
      onServerRequest: (method, params) => this.onServerRequest(method, params),
      requestTimeoutMs: this.requestTimeoutMs,
    });
    this.dispatcher = dispatcher;

    proc.stdout.on("data", (chunk: Buffer) => {
      try {
        decoder.append(chunk);
        for (const message of decoder.drain()) {
          dispatcher.handleMessage(message);
        }
      } catch (err) {
        process.stderr.write(`lsp-oracle: frame decoding failed: ${(err as Error).message}\n`);
      }
    });

    proc.stderr.setEncoding("utf-8");
    proc.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line) continue;
        const lower = line.toLowerCase();
        if (lower.includes("error") || lower.includes("warn")) {
          process.stderr.write(`${this.clientName()}.stderr: ${line.slice(0, 300)}\n`);
        }
      }
    });

    proc.on("exit", () => {
      dispatcher.close(`${this.clientName()} subprocess exited`);
    });

    const rootUri = toFileUri(this.workspaceRoot);
    const initParams = {
      processId: process.pid,
      clientInfo: { name: "opencodehub-lsp-oracle", version: "0.1.0" },
      rootUri,
      rootPath: this.workspaceRoot,
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.workspaceRoot) }],
      capabilities: {
        workspace: {
          configuration: true,
          workspaceFolders: true,
          didChangeConfiguration: { dynamicRegistration: false },
        },
        textDocument: {
          references: { dynamicRegistration: false },
          implementation: { dynamicRegistration: false, linkSupport: false },
          callHierarchy: { dynamicRegistration: false },
          synchronization: {
            dynamicRegistration: false,
            didSave: true,
            willSave: false,
            willSaveWaitUntil: false,
          },
          publishDiagnostics: { relatedInformation: false },
        },
        window: { workDoneProgress: true },
      },
      initializationOptions: this.initializationOptions(),
    };

    await dispatcher.request("initialize", initParams);
    dispatcher.notify("initialized", {});
    await this.onInitialized(dispatcher);

    await this.waitForIndexingEnd(this.indexWaitMs);

    this.coldStartMs = performance.now() - t0;
  }

  async stop(): Promise<void> {
    if (!this.started || this.stopping) {
      return;
    }
    this.stopping = true;
    const dispatcher = this.dispatcher;
    const proc = this.proc;

    if (dispatcher !== null) {
      try {
        await Promise.race([
          dispatcher.request("shutdown", null),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("shutdown timeout")), SHUTDOWN_GRACE_MS).unref(),
          ),
        ]);
      } catch {
        // server hangs on shutdown occasionally; we'll force-kill below.
      }
      try {
        dispatcher.notify("exit", null);
      } catch {
        // ignore
      }
      dispatcher.close("client stopped");
    }

    if (proc !== null && proc.exitCode === null && proc.signalCode === null) {
      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // ignore
          }
          resolve();
        }, SHUTDOWN_GRACE_MS);
        killTimer.unref();
        proc.once("exit", () => {
          clearTimeout(killTimer);
          resolve();
        });
      });
    }

    this.dispatcher = null;
    this.proc = null;
  }

  getStatus(): BaseClientStatus {
    return {
      started: this.started,
      indexingComplete: this.indexingComplete,
      workspaceRoot: this.workspaceRoot,
      coldStartMs: this.coldStartMs,
      serverCommand: this.resolvedServerCommand(),
    };
  }

  async queryCallers(input: QueryCallersInput): Promise<readonly CallerSite[]> {
    await this.ensureOpen(input.filePath);

    const primary = await this.callHierarchyIncoming(input.filePath, input.line, input.character);
    if (primary.length > 0) {
      return primary;
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

  async queryReferences(input: FilePosition): Promise<readonly ReferenceSite[]> {
    await this.ensureOpen(input.filePath);
    const pos = makeTextDocumentPosition(
      this.workspaceRoot,
      input.filePath,
      input.line,
      input.character,
    );
    const response = await this.request<readonly LspLocation[] | null>("textDocument/references", {
      context: { includeDeclaration: false },
      ...pos,
    });
    if (!response) return [];
    const sites: ReferenceSite[] = [];
    for (const loc of response) {
      const rel = toRelativeFilePath(this.workspaceRoot, uriToFsPath(loc.uri));
      sites.push({
        file: rel,
        line: loc.range.start.line + 1,
        character: loc.range.start.character + 1,
      });
    }
    return sites;
  }

  async queryImplementations(input: FilePosition): Promise<readonly ImplementationSite[]> {
    await this.ensureOpen(input.filePath);
    const pos = makeTextDocumentPosition(
      this.workspaceRoot,
      input.filePath,
      input.line,
      input.character,
    );
    let response: readonly LspLocation[] | null = null;
    try {
      response = await this.request<readonly LspLocation[] | null>(
        "textDocument/implementation",
        pos,
      );
    } catch (err) {
      if (err instanceof Error && /Unhandled method|method not found|-32601/i.test(err.message)) {
        return [];
      }
      throw err;
    }
    if (!response) return [];
    const sites: ImplementationSite[] = [];
    for (const loc of response) {
      const rel = toRelativeFilePath(this.workspaceRoot, uriToFsPath(loc.uri));
      sites.push({
        file: rel,
        line: loc.range.start.line + 1,
        character: loc.range.start.character + 1,
      });
    }
    return sites;
  }

  protected async callHierarchyIncoming(
    filePath: string,
    line: number,
    character: number,
  ): Promise<CallerSite[]> {
    const pos = makeTextDocumentPosition(this.workspaceRoot, filePath, line, character);
    const items = await this.request<readonly LspCallHierarchyItem[] | null>(
      "textDocument/prepareCallHierarchy",
      pos,
    );
    if (!items || items.length === 0) {
      return [];
    }
    const first = items[0];
    if (first === undefined) {
      return [];
    }
    const incoming = await this.request<readonly LspCallHierarchyIncomingCall[] | null>(
      "callHierarchy/incomingCalls",
      { item: first },
    );
    if (!incoming) return [];
    const out: CallerSite[] = [];
    for (const call of incoming) {
      const from = call.from;
      if (from === undefined) continue;
      const rel = toRelativeFilePath(this.workspaceRoot, uriToFsPath(from.uri));
      // LSP `callHierarchy/incomingCalls` returns one `fromRanges[]` per
      // incoming call: each range is the exact call-site inside `from`.
      // Emit one CallerSite per call-site so the oracle surfaces the same
      // shape gopls / rust-analyzer / tsserver do when asked directly.
      // Fall back to the caller's selectionRange only when fromRanges is
      // missing, which happens for a handful of older LSP servers.
      const ranges =
        call.fromRanges.length > 0 ? call.fromRanges : [from.selectionRange ?? from.range];
      for (const r of ranges) {
        out.push({
          file: rel,
          line: r.start.line + 1,
          character: r.start.character + 1,
          enclosingSymbolName: from.name,
          source: "callHierarchy",
        });
      }
    }
    return out;
  }

  protected async ensureOpen(filePath: string): Promise<void> {
    const abs = path.isAbsolute(filePath) ? filePath : path.join(this.workspaceRoot, filePath);
    if (this.openedFiles.has(abs)) return;
    const { readFile } = await import("node:fs/promises");
    let text: string;
    try {
      text = await readFile(abs, "utf-8");
    } catch (err) {
      throw new Error(`lsp-oracle: cannot read ${abs} for didOpen: ${(err as Error).message}`);
    }
    this.dispatcher?.notify("textDocument/didOpen", {
      textDocument: {
        uri: toFileUri(abs),
        languageId: this.languageId(),
        version: 1,
        text,
      },
    });
    this.openedFiles.add(abs);
  }

  protected async request<T>(method: string, params: unknown): Promise<T> {
    const dispatcher = this.dispatcher;
    if (dispatcher === null) {
      throw new Error(`lsp-oracle: cannot send ${method} — dispatcher is not started`);
    }
    return dispatcher.request<T>(method, params);
  }

  protected resolvedServerCommand(): readonly string[] {
    const { cmd, args } = this.serverCommand();
    return [cmd, ...args];
  }

  private async waitForIndexingEnd(timeoutMs: number): Promise<void> {
    if (this.indexingComplete) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.progressWaiters = this.progressWaiters.filter((fn) => fn !== done);
        process.stderr.write(
          `lsp-oracle: ${this.clientName()} did not emit $/progress end within ${timeoutMs}ms; proceeding\n`,
        );
        resolve();
      }, timeoutMs);
      timer.unref?.();
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.progressWaiters.push(done);
    });
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "$/progress") {
      try {
        this.onProgress(params);
      } catch {
        // onProgress is a non-critical extension hook; never let a
        // subclass throw break the base dispatcher loop.
      }
      const p = (params ?? {}) as { value?: { kind?: string } };
      if (p.value?.kind === "end") {
        this.indexingComplete = true;
        const waiters = this.progressWaiters;
        this.progressWaiters = [];
        for (const fn of waiters) {
          try {
            fn();
          } catch {
            // ignore
          }
        }
      }
    }
  }
}
