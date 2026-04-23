/**
 * On native Windows, stdio servers launched via `npx` or an unwrapped
 * `node`/binary shim fail with ENOENT because Node does not route through
 * `cmd.exe` by default. The standard workaround in MCP client docs is to wrap
 * the command in `cmd /c <original>`.
 *
 * We apply the wrap when:
 *   - we are running on `win32`, AND
 *   - the command is `npx`, `npm`, `yarn`, `pnpm`, or a `.cmd`/`.bat` file.
 *
 * Pure function; no IO.
 */

import type { McpInvocation } from "./types.js";

const WRAPPABLE_COMMANDS = new Set(["npx", "npm", "yarn", "pnpm"]);

export interface WrapOptions {
  /** Override the detected platform. Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
}

export function maybeWrapForWindows(
  invocation: McpInvocation,
  opts: WrapOptions = {},
): McpInvocation {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return invocation;

  const base = invocation.command.toLowerCase();
  const needsWrap = WRAPPABLE_COMMANDS.has(base) || base.endsWith(".cmd") || base.endsWith(".bat");
  if (!needsWrap) return invocation;

  return {
    command: "cmd",
    args: ["/c", invocation.command, ...invocation.args],
    env: invocation.env,
  };
}
