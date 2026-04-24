/**
 * Minimal loopback HTTP server for `codehub eval-server`.
 *
 * Bound to 127.0.0.1 only — never LAN. Authentication is out of scope:
 * the loopback restriction is the security boundary. The server reuses
 * a shared `ConnectionPool` so DuckDB handles stay warm across requests.
 *
 * HTTP surface:
 *   POST /tool/:name — JSON body = args. Returns `text/plain`.
 *                       400 on invalid JSON, 413 on body > 1MB,
 *                       404 on unknown tool, 500 on handler throw.
 *   GET  /health    — JSON `{status, repos}`.
 *   POST /shutdown  — graceful drain + exit.
 *
 * Invariants:
 *   - Body size capped at MAX_BODY_SIZE (1 MB). Exceeded requests are
 *     destroyed with a 413 before reaching the handler.
 *   - Idle timeout resets on every accepted request. When the server is
 *     idle for `idleTimeoutMs`, it drains the pool and exits.
 *   - SIGINT / SIGTERM drain the pool and exit cleanly.
 *   - The optional `readySignal` callback fires once the listener is
 *     bound — the command entrypoint uses this to emit a `READY:<port>`
 *     line on fd 1 so eval harnesses can block on startup.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ConnectionPool, readRegistry, type ToolContext } from "@opencodehub/mcp";
import { runDispatch } from "./dispatch.js";
import { formatToolResult } from "./formatters.js";
import { getNextStepHint } from "./next-steps.js";

export const MAX_BODY_SIZE = 1024 * 1024; // 1 MB
const DEFAULT_IDLE_TIMEOUT_MS = 900_000; // 15 min
const DEFAULT_PORT = 4848;

export interface EvalServerOptions {
  readonly port?: number;
  readonly idleTimeoutMs?: number;
  /** Override `~/.codehub/` lookup (tests only). */
  readonly home?: string;
  /** Called with the bound port once the listener is ready. */
  readonly onReady?: (port: number) => void;
  /** Suppress stderr banner (used by tests). */
  readonly silent?: boolean;
  /**
   * When true, SIGINT / SIGTERM do NOT call `process.exit`; the server
   * simply drains. Tests flip this so they can assert on post-shutdown
   * pool state without tearing down node.
   */
  readonly testMode?: boolean;
}

export interface EvalServerHandle {
  readonly server: Server;
  readonly pool: ConnectionPool;
  readonly port: number;
  /** Resolve when the server has fully stopped listening and the pool drained. */
  shutdown(): Promise<void>;
}

interface RequestTracker {
  inflight: number;
  draining: boolean;
}

class PayloadTooLargeError extends Error {
  readonly code = "PAYLOAD_TOO_LARGE" as const;
  constructor() {
    super("PAYLOAD_TOO_LARGE");
  }
}

/**
 * Read the request body with a 1 MB cap. Rather than destroying the
 * socket when the limit is exceeded — which causes the client to see a
 * generic connection reset — we drain the remaining bytes, discard
 * them, and reject with a typed error so the caller can send a clean
 * 413 response. The drain is bounded: each discarded chunk fires a
 * `data` event, so Node still applies its own highWaterMark.
 */
async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let overflow = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_SIZE) {
        overflow = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (overflow) {
        reject(new PayloadTooLargeError());
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    req.on("error", (err) => reject(err));
  });
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.writeHead(status);
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.writeHead(status);
  res.end(JSON.stringify(payload));
}

/**
 * Compose the final response body from a ToolResult — formatted content
 * plus an optional trailing next-step hint. Exported for tests so they
 * can assert on the combined shape without spinning up an HTTP client.
 */
export function buildResponseBody(
  toolName: string,
  result: Awaited<ReturnType<typeof runDispatch>>,
): string {
  if (!result) return `Unknown tool: ${toolName}`;
  const text = formatToolResult(toolName, result);
  const hint = getNextStepHint(toolName, result);
  if (hint.length === 0) return text;
  return `${text}\n\n${hint}`;
}

async function loadRepoNames(home: string | undefined): Promise<readonly string[]> {
  try {
    const reg = home !== undefined ? await readRegistry({ home }) : await readRegistry();
    return Object.keys(reg).sort();
  } catch {
    return [];
  }
}

/**
 * Construct the eval-server handle. The server is already listening by
 * the time this resolves. Callers MUST await `shutdown()` during teardown
 * to drain the pool and close any persistent connections.
 */
export async function startEvalServer(opts: EvalServerOptions = {}): Promise<EvalServerHandle> {
  const port = opts.port ?? DEFAULT_PORT;
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const pool = new ConnectionPool();
  const ctx: ToolContext = opts.home !== undefined ? { pool, home: opts.home } : { pool };
  const tracker: RequestTracker = { inflight: 0, draining: false };

  let idleTimer: NodeJS.Timeout | null = null;
  let shutdownPromise: Promise<void> | null = null;

  const resetIdleTimer = (): void => {
    if (idleTimeoutMs <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!opts.silent) {
        process.stderr.write("codehub eval-server: idle timeout reached, shutting down\n");
      }
      void doShutdown();
    }, idleTimeoutMs);
  };

  const doShutdown = async (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      tracker.draining = true;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      // Stop accepting new connections; wait for in-flight requests to
      // finish before closing the pool.
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      // Wait for any straggling in-flight requests (close() already
      // rejects new connections, but active ones finish first).
      const deadline = Date.now() + 5_000;
      while (tracker.inflight > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      await pool.shutdown();
    })();
    return shutdownPromise;
  };

  const server = createServer((req, res) => {
    if (tracker.draining) {
      sendText(res, 503, "Server is shutting down");
      return;
    }
    resetIdleTimer();
    tracker.inflight += 1;
    handle(req, res, ctx, opts, doShutdown)
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (!res.headersSent) {
          try {
            sendText(res, 500, `Error: ${message}`);
          } catch {
            // response already destroyed
          }
        }
      })
      .finally(() => {
        tracker.inflight -= 1;
      });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve();
    });
  });

  const actualPort = (server.address() as AddressInfo | null)?.port ?? port;

  if (!opts.silent) {
    const repoNames = await loadRepoNames(opts.home);
    process.stderr.write(
      `codehub eval-server: listening on http://127.0.0.1:${actualPort} — ${repoNames.length} repo(s)\n`,
    );
  }
  opts.onReady?.(actualPort);
  resetIdleTimer();

  if (!opts.testMode) {
    const signalShutdown = (): void => {
      void doShutdown().finally(() => process.exit(0));
    };
    process.once("SIGINT", signalShutdown);
    process.once("SIGTERM", signalShutdown);
  }

  return {
    server,
    pool,
    port: actualPort,
    shutdown: doShutdown,
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ToolContext,
  opts: EvalServerOptions,
  doShutdown: () => Promise<void>,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";

  // /health
  if (method === "GET" && url === "/health") {
    const repos = await loadRepoNames(opts.home);
    sendJson(res, 200, { status: "ok", repos });
    return;
  }

  // /shutdown
  if (method === "POST" && url === "/shutdown") {
    sendJson(res, 200, { status: "shutting_down" });
    res.once("close", () => {
      void doShutdown();
    });
    return;
  }

  // /tool/:name
  const toolMatch = url.match(/^\/tool\/([A-Za-z0-9_]+)$/);
  if (method === "POST" && toolMatch) {
    const toolName = toolMatch[1] ?? "";
    let bodyRaw: string;
    try {
      bodyRaw = await readBody(req);
    } catch (err) {
      if ((err as { code?: string } | null)?.code === "PAYLOAD_TOO_LARGE") {
        sendText(res, 413, "Error: request body exceeds 1 MB limit");
        return;
      }
      sendText(res, 400, `Error: ${(err as Error).message}`);
      return;
    }

    let args: unknown = {};
    if (bodyRaw.trim().length > 0) {
      try {
        args = JSON.parse(bodyRaw);
      } catch (err) {
        sendText(res, 400, `Error: invalid JSON body: ${(err as Error).message}`);
        return;
      }
      if (args === null || typeof args !== "object" || Array.isArray(args)) {
        sendText(res, 400, "Error: JSON body must be an object");
        return;
      }
    }

    const result = await runDispatch(toolName, ctx, args);
    if (!result) {
      sendText(res, 404, `Unknown tool: ${toolName}`);
      return;
    }
    const body = buildResponseBody(toolName, result);
    const status = result.isError ? 500 : 200;
    sendText(res, status, body);
    return;
  }

  sendText(res, 404, "Not found. Use POST /tool/:name, GET /health, or POST /shutdown.");
}
