/**
 * JSON-RPC 2.0 dispatcher over an LSP stdio stream.
 *
 * Owns the two things that belong at the protocol layer and nowhere else:
 *
 *   1. ID correlation — every request gets a monotonic integer ID and a
 *      pending-promise entry in the map; responses pop the matching entry
 *      and settle it. Out-of-order responses and concurrent requests work.
 *   2. Notification / server-request routing — non-response messages are
 *      fanned out to handlers the higher layer registers (we don't own
 *      what to do with `$/progress` or `workspace/configuration`, but we
 *      know how to route them).
 *
 * This is deliberately thin. The `PyrightClient` layer in `client.ts`
 * encodes LSP semantics (initialize handshake, didOpen, callHierarchy);
 * this layer is pure JSON-RPC.
 */

import type { Writable } from "node:stream";
import { encodeFrame } from "./framing.js";

export interface JsonRpcRequestMessage {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcResponseMessage {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotificationMessage {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

/** A message that was dispatched by the server and needs no reply. */
export type NotificationHandler = (method: string, params: unknown) => void;

/**
 * A request initiated by the server. The handler MUST return the `result`
 * value (or throw to surface an error back to the server). The dispatcher
 * then formats the JSON-RPC response.
 */
export type ServerRequestHandler = (method: string, params: unknown) => Promise<unknown> | unknown;

export interface JsonRpcDispatcherOptions {
  /** Stream to write LSP frames to (pyright stdin). */
  readonly stdout: Writable;
  /** Called for every JSON-RPC notification from the server. */
  readonly onNotification?: NotificationHandler;
  /** Called for every JSON-RPC request from the server. Defaults to a no-op that returns null. */
  readonly onServerRequest?: ServerRequestHandler;
  /** Request timeout in milliseconds. Defaults to 60,000 ms. */
  readonly requestTimeoutMs?: number;
}

interface PendingEntry {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timer: NodeJS.Timeout;
  readonly method: string;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export class JsonRpcDispatcher {
  private nextId = 0;
  private readonly pending = new Map<number, PendingEntry>();
  private readonly stdout: Writable;
  private readonly notificationHandler: NotificationHandler;
  private readonly serverRequestHandler: ServerRequestHandler;
  private readonly requestTimeoutMs: number;
  private closed = false;

  constructor(options: JsonRpcDispatcherOptions) {
    this.stdout = options.stdout;
    this.notificationHandler = options.onNotification ?? (() => {});
    this.serverRequestHandler = options.onServerRequest ?? (() => null);
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /**
   * Send a JSON-RPC request and resolve with its `result`. Rejects if the
   * server returns an `error`, if the transport is torn down, or if no
   * response arrives within `requestTimeoutMs`.
   */
  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(`lsp-oracle: dispatcher is closed; cannot send ${method}`));
    }
    this.nextId += 1;
    const id = this.nextId;
    const payload: JsonRpcRequestMessage = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`lsp-oracle: request ${method} (id=${id}) timed out`));
        }
      }, this.requestTimeoutMs);
      // Node's setTimeout returns a Timeout we can unref so pending LSP
      // requests don't hold the process open during graceful shutdown.
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as { unref: () => void }).unref();
      }
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        method,
      });
      this.write(payload);
    });
  }

  /** Send a JSON-RPC notification (fire-and-forget, no response expected). */
  notify(method: string, params: unknown): void {
    if (this.closed) {
      return;
    }
    const payload: JsonRpcNotificationMessage = {
      jsonrpc: "2.0",
      method,
      params,
    };
    this.write(payload);
  }

  /**
   * Feed a parsed JSON-RPC message into the dispatcher. Normally called by
   * the transport's frame decoder loop, but exposed for tests that want to
   * inject messages directly.
   */
  handleMessage(message: unknown): void {
    if (typeof message !== "object" || message === null) {
      return;
    }
    const m = message as Record<string, unknown>;
    const hasId = "id" in m && (typeof m["id"] === "number" || typeof m["id"] === "string");
    const hasMethod = "method" in m && typeof m["method"] === "string";

    if (hasId && !hasMethod) {
      // Response
      const id = m["id"] as number;
      const entry = this.pending.get(id);
      if (!entry) {
        return;
      }
      this.pending.delete(id);
      clearTimeout(entry.timer);
      if ("error" in m && m["error"] !== undefined) {
        const err = m["error"] as { code?: number; message?: string };
        entry.reject(
          new Error(
            `lsp-oracle: ${entry.method} failed: ${err.message ?? "unknown"} (code=${err.code ?? "?"})`,
          ),
        );
      } else {
        entry.resolve(m["result"]);
      }
      return;
    }

    if (hasId && hasMethod) {
      // Server-initiated request — requires a response.
      const id = m["id"];
      const method = m["method"] as string;
      const params = m["params"];
      Promise.resolve()
        .then(() => this.serverRequestHandler(method, params))
        .then(
          (result) => {
            this.write({
              jsonrpc: "2.0",
              id,
              result: result ?? null,
            } as unknown as JsonRpcResponseMessage);
          },
          (err: unknown) => {
            const message_ = err instanceof Error ? err.message : String(err);
            this.write({
              jsonrpc: "2.0",
              id,
              error: { code: -32603, message: message_ },
            } as unknown as JsonRpcResponseMessage);
          },
        );
      return;
    }

    if (hasMethod) {
      // Notification
      try {
        this.notificationHandler(m["method"] as string, m["params"]);
      } catch {
        // Never let a handler throw break the dispatcher.
      }
    }
  }

  /**
   * Tear down the dispatcher. Pending requests are rejected with a closed-
   * transport error so callers don't hang forever.
   */
  close(reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`lsp-oracle: ${entry.method} aborted: ${reason}`));
    }
    this.pending.clear();
  }

  private write(payload: unknown): void {
    const frame = encodeFrame(payload);
    // Writable#write can return false under backpressure but we don't have
    // anything useful to do; LSP traffic volume is low.
    this.stdout.write(frame);
  }
}
