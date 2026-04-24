import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpInvocation } from "./types.js";
import { maybeWrapForWindows } from "./windows-wrap.js";

const NODE_INVOCATION: McpInvocation = { command: "node", args: ["x.js"], env: {} };
const NPX_INVOCATION: McpInvocation = { command: "npx", args: ["codehub", "mcp"], env: {} };

test("maybeWrapForWindows is a no-op on non-Windows platforms", () => {
  const out = maybeWrapForWindows(NPX_INVOCATION, { platform: "darwin" });
  assert.equal(out, NPX_INVOCATION);
});

test("maybeWrapForWindows wraps npx on win32", () => {
  const out = maybeWrapForWindows(NPX_INVOCATION, { platform: "win32" });
  assert.equal(out.command, "cmd");
  assert.deepEqual(out.args, ["/c", "npx", "codehub", "mcp"]);
});

test("maybeWrapForWindows leaves node invocations alone on win32", () => {
  const out = maybeWrapForWindows(NODE_INVOCATION, { platform: "win32" });
  assert.equal(out.command, "node");
});

test("maybeWrapForWindows wraps .cmd and .bat shims on win32", () => {
  const shim = { command: "codehub.cmd", args: ["mcp"], env: {} };
  const out = maybeWrapForWindows(shim, { platform: "win32" });
  assert.equal(out.command, "cmd");
  assert.deepEqual(out.args, ["/c", "codehub.cmd", "mcp"]);
});
