/**
 * Tests for `withCodehubBinOnPath` — the spawn-env PATH shim that makes
 * `codehub setup --scip` installed indexers (under ~/.codehub/bin) win over
 * an ambient version-manager shim that resolves on PATH but can't pick a
 * version. See `runCommand` in ./index.ts.
 *
 * The helper reads `homedir()` and `process.platform`, so we compute the
 * expected bin dir + delimiter the same way rather than hard-coding a
 * platform — these assertions hold on Linux, macOS, and Windows CI legs.
 */

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withCodehubBinOnPath } from "./index.js";

const BIN_DIR = join(homedir(), ".codehub", "bin");
const SEP = process.platform === "win32" ? ";" : ":";

test("prepends ~/.codehub/bin ahead of the existing PATH", () => {
  const out = withCodehubBinOnPath({ PATH: `/usr/bin${SEP}/bin` });
  assert.equal(out["PATH"], `${BIN_DIR}${SEP}/usr/bin${SEP}/bin`);
});

test("is idempotent — does not double-prepend when bin dir is already first", () => {
  const already = `${BIN_DIR}${SEP}/usr/bin`;
  const out = withCodehubBinOnPath({ PATH: already });
  assert.equal(out["PATH"], already, "PATH should be unchanged when bin dir leads");
});

test("sets PATH to just the bin dir when PATH is empty", () => {
  const out = withCodehubBinOnPath({ PATH: "" });
  assert.equal(out["PATH"], BIN_DIR);
});

test("sets PATH to just the bin dir when PATH is absent entirely", () => {
  const out = withCodehubBinOnPath({});
  assert.equal(out["PATH"], BIN_DIR);
});

test("honors a caller-supplied PATH (envOverlay value), not just process.env", () => {
  // The runner merges `{ ...process.env, ...envOverlay }` BEFORE calling this
  // helper, so a caller PATH override is already the resolved value here.
  const out = withCodehubBinOnPath({ PATH: "/caller/supplied" });
  assert.equal(out["PATH"], `${BIN_DIR}${SEP}/caller/supplied`);
});

test("preserves other env vars untouched", () => {
  const out = withCodehubBinOnPath({ PATH: "/bin", HOME: "/home/x", FOO: "bar" });
  assert.equal(out["HOME"], "/home/x");
  assert.equal(out["FOO"], "bar");
});

test("does not mutate the input env object", () => {
  const input = { PATH: "/bin" };
  const out = withCodehubBinOnPath(input);
  assert.equal(input["PATH"], "/bin", "input must be left unmodified");
  assert.notEqual(out, input, "should return a new object");
});
