/**
 * rust-analyzer LSP adapter.
 *
 * `RustAnalyzerClient` spawns rust-analyzer (installed via
 * `rustup component add rust-analyzer`) as a stdio subprocess and
 * exposes the same three query shapes as `PyrightClient`
 * (`queryReferences`, `queryImplementations`, `queryCallers`) via the
 * shared `BaseLspClient` machinery.
 *
 * Why the batch-oriented `initializationOptions` block below matters:
 *
 *   - `cargo.buildScripts.enable = false` and `cargo.noDeps = true`
 *     prevent rust-analyzer from running the cargo metadata + build
 *     script dance on startup. Essential in CI — with build scripts on,
 *     cold-start on a medium crate blows past 60s and is flaky.
 *   - `procMacro.enable = false` disables the proc-macro server.
 *     See the one-line tradeoff comment inline — this is the critical
 *     correctness caveat.
 *   - `checkOnSave = false` + `diagnostics.enable = false` — we're
 *     a batch oracle, not an editor; diagnostics are noise.
 *   - `cachePriming.enable = true` — we DO want the symbol cache
 *     primed so reference queries hit a warm index. The `warmup()`
 *     method below waits for the priming-end progress notification.
 *
 * PATH diagnostic: `onBeforeStart()` probes for `rust-analyzer` on PATH
 * when no explicit `serverCommand` override is given, and throws a
 * clear, actionable error if it is missing, pointing the user at
 * `rustup component add rust-analyzer`.
 *
 * Version probe: `start()` runs `rust-analyzer --version` once after
 * the base-class handshake completes, parses the semver-ish tail, and
 * caches it on the instance — exposed via
 * `getStatus().rustAnalyzerVersion`. The probe is skipped when the
 * caller passes a `serverCommand` override (typically a test mock that
 * does not implement `--version`).
 */

import { spawn, spawnSync } from "node:child_process";

import { type BaseClientStatus, BaseLspClient, type BaseLspClientOptions } from "./base-client.js";

export interface RustAnalyzerClientOptions extends BaseLspClientOptions {
  /**
   * Override the rust-analyzer invocation. When set, the PATH probe and
   * `--version` probe are skipped — primarily for tests that point at a
   * mock server. Production callers should rely on PATH resolution.
   */
  readonly serverCommand?: readonly string[] | undefined;
  /**
   * Enable rust-analyzer's proc-macro server. Default is `false`.
   *
   * Tradeoff: with proc-macro disabled, derive- and attribute-macro
   * bodies are opaque to rust-analyzer, so references to serde-
   * generated `Serialize::serialize` impls, tokio `#[tokio::main]`
   * wrappers, and similar derive-synthesized code will be missing
   * from `queryReferences` / `queryCallers`. Flipping this to `true`
   * requires toolchain pin discipline — rust-analyzer will compile
   * proc-macro crates with the active rustc, and version skew between
   * the ingestion host and the project's `rust-toolchain` manifest
   * surfaces as cryptic proc-macro build failures. For repo-wide batch
   * ingestion we accept the lossy-but-stable default; flip to `true`
   * only in environments where the rust toolchain is known to match
   * the project's pin.
   */
  readonly enableProcMacro?: boolean | undefined;
}

export interface RustAnalyzerClientStatus extends BaseClientStatus {
  readonly rustAnalyzerVersion: string | null;
  readonly procMacroEnabled: boolean;
}

const VERSION_RE = /rust-analyzer\s+(\S+)/;

/** Parse `rust-analyzer --version` stdout. Exported for unit testing. */
export function parseRustAnalyzerVersion(stdout: string): string | null {
  const match = VERSION_RE.exec(stdout);
  return match?.[1] ?? null;
}

export class RustAnalyzerClient extends BaseLspClient {
  private readonly resolvedCommand: readonly string[];
  private readonly procMacroEnabled: boolean;
  private readonly isOverride: boolean;
  private rustAnalyzerVersion: string | null = null;
  private cachePrimingComplete = false;
  private primingWaiters: Array<() => void> = [];

  constructor(options: RustAnalyzerClientOptions) {
    super({
      workspaceRoot: options.workspaceRoot,
      ...(options.indexWaitMs !== undefined ? { indexWaitMs: options.indexWaitMs } : {}),
      ...(options.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: options.requestTimeoutMs }
        : {}),
    });
    this.isOverride = options.serverCommand !== undefined && options.serverCommand.length > 0;
    this.resolvedCommand = this.isOverride
      ? (options.serverCommand as readonly string[])
      : ["rust-analyzer"];
    this.procMacroEnabled = options.enableProcMacro ?? false;
  }

  protected override serverCommand(): { cmd: string; args: readonly string[] } {
    const [cmd, ...args] = this.resolvedCommand;
    return { cmd: cmd ?? "", args };
  }

  protected override serverEnv(): NodeJS.ProcessEnv {
    return { ...process.env };
  }

  protected override clientName(): string {
    return "rust-analyzer";
  }

  protected override languageId(): string {
    return "rust";
  }

  protected override initializationOptions(): Record<string, unknown> {
    const procMacroEnabled = this.procMacroEnabled;
    return {
      cargo: { buildScripts: { enable: false }, noDeps: true },
      // Proc-macro off: serde/tokio derive-generated refs will be opaque — see class doc.
      procMacro: { enable: procMacroEnabled, attributes: { enable: procMacroEnabled } },
      checkOnSave: false,
      diagnostics: { enable: false },
      cachePriming: { enable: true },
    };
  }

  protected override onBeforeStart(): void {
    // Skip the PATH probe when the caller supplied an explicit command
    // (typically a test harness pointing at a mock server).
    if (this.isOverride) {
      return;
    }
    const probe = spawnSync("which", ["rust-analyzer"], { encoding: "utf-8" });
    if (probe.status !== 0 || !probe.stdout.trim()) {
      throw new Error(
        "rust-analyzer not on PATH. Install with: rustup component add rust-analyzer",
      );
    }
  }

  protected override onProgress(params: unknown): void {
    const p = (params ?? {}) as {
      token?: unknown;
      value?: { kind?: string };
    };
    const token = typeof p.token === "string" ? p.token.toLowerCase() : "";
    const looksLikePriming = token.includes("priming") || token.includes("cache");
    if (!looksLikePriming) {
      return;
    }
    if (p.value?.kind === "end") {
      this.cachePrimingComplete = true;
      const waiters = this.primingWaiters;
      this.primingWaiters = [];
      for (const fn of waiters) {
        try {
          fn();
        } catch {
          // ignore
        }
      }
    }
  }

  override async start(): Promise<void> {
    await super.start();
    await this.probeRustAnalyzerVersion();
  }

  override getStatus(): RustAnalyzerClientStatus {
    return {
      ...super.getStatus(),
      rustAnalyzerVersion: this.rustAnalyzerVersion,
      procMacroEnabled: this.procMacroEnabled,
    };
  }

  /**
   * Block until rust-analyzer finishes cache priming.
   *
   * rust-analyzer's `initialize` response arrives long before the
   * symbol cache is populated — issuing a `textDocument/references`
   * query against a cold cache either returns empty or returns
   * partial results. The reliable signal is a `$/progress` END
   * notification carrying a priming-related token (currently
   * `rustAnalyzer/cachePriming`; we match defensively on any token
   * containing `priming` or `cache`).
   *
   * Resolves as soon as the END notification arrives (or immediately
   * if it already has). Rejects with an actionable error after
   * `timeoutMs` when rust-analyzer never emits the signal — the caller
   * should investigate (misconfigured cargo, firewall blocking
   * crates.io, etc.) rather than proceed against a cold index.
   */
  async warmup(timeoutMs: number = 120_000): Promise<void> {
    if (this.cachePrimingComplete) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.primingWaiters = this.primingWaiters.filter((fn) => fn !== done);
        reject(
          new Error(
            `lsp-oracle: rust-analyzer cache priming did not complete within ${timeoutMs}ms. ` +
              "Check cargo metadata / network availability.",
          ),
        );
      }, timeoutMs);
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as { unref: () => void }).unref();
      }
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.primingWaiters.push(done);
    });
  }

  private probeRustAnalyzerVersion(): Promise<void> {
    if (this.isOverride) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let stdout = "";
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        const parsed = parseRustAnalyzerVersion(stdout);
        if (parsed !== null) {
          this.rustAnalyzerVersion = parsed;
        }
        resolve();
      };
      try {
        const child = spawn("rust-analyzer", ["--version"], {
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
