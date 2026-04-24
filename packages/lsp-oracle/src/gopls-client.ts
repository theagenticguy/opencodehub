/**
 * High-level gopls adapter.
 *
 * Spawns `gopls -mode=stdio` from PATH. Unlike pyright, gopls is not
 * distributed as an npm package — it is installed out-of-band via
 * `go install golang.org/x/tools/gopls@latest`. We resolve it on PATH at
 * `start()` time and surface a clear install hint if it is missing.
 *
 * Gopls auto-discovers `go.work` / `go.mod` via the `workspaceFolders`
 * init param supplied by `BaseLspClient`, so no extra init options are
 * needed for reference-only work.
 *
 * Known gopls quirks (kept here as doc-only; no workaround code):
 *   - `textDocument/references` is scoped to the build config of the
 *     selected file (e.g. querying inside `foo_windows.go` won't return
 *     sites in `bar_linux.go`). Upstream: go.dev/issue/65755.
 *   - `callHierarchy` excludes dynamic/interface-dispatched calls.
 */

import { spawn, spawnSync } from "node:child_process";

import { type BaseClientStatus, BaseLspClient, type BaseLspClientOptions } from "./base-client.js";

export interface GoplsClientOptions extends BaseLspClientOptions {
  /**
   * Override the gopls binary invocation. When set, we use it verbatim
   * instead of resolving `gopls` on PATH. Primarily for tests; production
   * callers should rely on the PATH resolution.
   */
  readonly serverCommand?: readonly string[];
}

export interface GoplsClientStatus extends BaseClientStatus {
  /**
   * Parsed semver string from `gopls version` (e.g. `"0.21.0"`), or `null`
   * if the probe hasn't run yet or couldn't be parsed.
   */
  readonly goplsVersion: string | null;
}

const GOPLS_VERSION_RE = /v(\d+\.\d+\.\d+[^\s]*)/;

export class GoplsClient extends BaseLspClient {
  private readonly resolvedCommand: readonly string[];
  private goplsVersion: string | null = null;

  constructor(options: GoplsClientOptions) {
    super({
      workspaceRoot: options.workspaceRoot,
      ...(options.indexWaitMs !== undefined ? { indexWaitMs: options.indexWaitMs } : {}),
      ...(options.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: options.requestTimeoutMs }
        : {}),
    });
    this.resolvedCommand =
      options.serverCommand && options.serverCommand.length > 0
        ? options.serverCommand
        : ["gopls", "-mode=stdio"];
  }

  protected override serverCommand(): { cmd: string; args: readonly string[] } {
    const [cmd, ...args] = this.resolvedCommand;
    return { cmd: cmd ?? "", args };
  }

  protected override serverEnv(): NodeJS.ProcessEnv {
    return { ...process.env };
  }

  protected override clientName(): string {
    return "gopls";
  }

  protected override languageId(): string {
    return "go";
  }

  protected override initializationOptions(): Record<string, unknown> {
    return {};
  }

  protected override async onBeforeStart(): Promise<void> {
    // Skip the PATH probe when the caller provided an explicit command
    // (typically a test harness pointing at a mock server).
    const [cmd] = this.resolvedCommand;
    if (cmd !== undefined && cmd !== "gopls") {
      return;
    }
    const probe = spawnSync("which", ["gopls"], { encoding: "utf-8" });
    if (probe.status !== 0 || !probe.stdout.trim()) {
      throw new Error(
        "lsp-oracle: gopls not on PATH. Install with: go install golang.org/x/tools/gopls@latest",
      );
    }
  }

  override async start(): Promise<void> {
    await super.start();
    await this.probeGoplsVersion();
  }

  override getStatus(): GoplsClientStatus {
    return {
      ...super.getStatus(),
      goplsVersion: this.goplsVersion,
    };
  }

  private probeGoplsVersion(): Promise<void> {
    const [cmd] = this.resolvedCommand;
    // When a mock-server override is in use, we can't meaningfully probe
    // a gopls version — the override is a Node script, not a gopls binary.
    if (cmd === undefined || cmd === "" || cmd !== "gopls") {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let stdout = "";
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        const match = GOPLS_VERSION_RE.exec(stdout);
        if (match?.[1] !== undefined) {
          this.goplsVersion = match[1];
        }
        resolve();
      };
      try {
        const child = spawn("gopls", ["version"], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout?.setEncoding("utf-8");
        child.stdout?.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.on("error", done);
        child.on("exit", done);
      } catch {
        done();
      }
    });
  }
}
