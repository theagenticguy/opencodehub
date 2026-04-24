/**
 * `codehub eval-server` — persistent HTTP daemon for SWE-bench-style
 * agent loops.
 *
 * Wraps the pure `run*` tool handlers with a thin HTTP adapter that
 * returns terse, agent-friendly text plus next-step hints. Bound to
 * 127.0.0.1 only; authentication is not provided (loopback-only is the
 * security boundary).
 *
 * Usage:
 *   codehub eval-server                        # default port 4848, 15-min idle
 *   codehub eval-server --port 4848
 *   codehub eval-server --idle-timeout 600     # seconds
 *
 * The startup banner and the READY line are emitted after the listener
 * binds so launcher processes can block on "READY:<port>" via stdout
 * without waiting on the first request.
 */

import { writeSync } from "node:fs";
import { startEvalServer } from "../eval-server/http-server.js";

export interface EvalServerCommandOptions {
  readonly port?: number;
  readonly idleTimeoutSec?: number;
}

export async function runEvalServer(opts: EvalServerCommandOptions = {}): Promise<void> {
  const idleTimeoutMs =
    typeof opts.idleTimeoutSec === "number" && opts.idleTimeoutSec > 0
      ? opts.idleTimeoutSec * 1000
      : 900_000;

  const handle = await startEvalServer({
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    idleTimeoutMs,
    onReady: (port) => {
      try {
        writeSync(1, `CODEHUB_EVAL_SERVER_READY:${port}\n`);
      } catch {
        // stdout may be closed in some launcher harnesses — safe to ignore.
      }
    },
  });

  // Keep the process alive until the server closes (idle timeout, SIGINT,
  // or POST /shutdown all route through `handle.shutdown()`).
  await new Promise<void>((resolve) => {
    handle.server.once("close", () => resolve());
  });
}
