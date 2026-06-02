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
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hostedScipBinDirs, withCodehubBinOnPath } from "./index.js";

const BIN_DIR = join(homedir(), ".codehub", "bin");
const SEP = process.platform === "win32" ? ";" : ":";

// Most assertions pin the exact PATH string, so they inject an empty hosted-
// dirs resolver to isolate the `~/.codehub/bin` behavior from whichever
// hard-dep shims happen to be installed in the test environment. A dedicated
// block below covers the hosted-dir prepend.
const noHosted = (): readonly string[] => [];

test("prepends ~/.codehub/bin ahead of the existing PATH", () => {
  const out = withCodehubBinOnPath({ PATH: `/usr/bin${SEP}/bin` }, noHosted);
  assert.equal(out["PATH"], `${BIN_DIR}${SEP}/usr/bin${SEP}/bin`);
});

test("is idempotent — does not double-prepend when bin dir is already first", () => {
  const already = `${BIN_DIR}${SEP}/usr/bin`;
  const out = withCodehubBinOnPath({ PATH: already }, noHosted);
  assert.equal(out["PATH"], already, "PATH should be unchanged when bin dir leads");
});

test("sets PATH to just the bin dir when PATH is empty", () => {
  const out = withCodehubBinOnPath({ PATH: "" }, noHosted);
  assert.equal(out["PATH"], BIN_DIR);
});

test("sets PATH to just the bin dir when PATH is absent entirely", () => {
  const out = withCodehubBinOnPath({}, noHosted);
  assert.equal(out["PATH"], BIN_DIR);
});

test("honors a caller-supplied PATH (envOverlay value), not just process.env", () => {
  // The runner merges `{ ...process.env, ...envOverlay }` BEFORE calling this
  // helper, so a caller PATH override is already the resolved value here.
  const out = withCodehubBinOnPath({ PATH: "/caller/supplied" }, noHosted);
  assert.equal(out["PATH"], `${BIN_DIR}${SEP}/caller/supplied`);
});

test("preserves other env vars untouched", () => {
  const out = withCodehubBinOnPath({ PATH: "/bin", HOME: "/home/x", FOO: "bar" }, noHosted);
  assert.equal(out["HOME"], "/home/x");
  assert.equal(out["FOO"], "bar");
});

test("does not mutate the input env object", () => {
  const input = { PATH: "/bin" };
  const out = withCodehubBinOnPath(input, noHosted);
  assert.equal(input["PATH"], "/bin", "input must be left unmodified");
  assert.notEqual(out, input, "should return a new object");
});

test("prepends hosted hard-dep .bin dirs after ~/.codehub/bin, before existing PATH", () => {
  const hosted = ["/pkg/node_modules/.bin"];
  const out = withCodehubBinOnPath({ PATH: "/usr/bin" }, () => hosted);
  assert.equal(out["PATH"], `${BIN_DIR}${SEP}/pkg/node_modules/.bin${SEP}/usr/bin`);
});

test("dedupes a hosted dir already present on PATH (no duplicate, no reorder)", () => {
  const hosted = ["/pkg/node_modules/.bin"];
  const already = `${BIN_DIR}${SEP}/pkg/node_modules/.bin${SEP}/usr/bin`;
  const out = withCodehubBinOnPath({ PATH: already }, () => hosted);
  assert.equal(out["PATH"], already, "already-present dirs are not re-prepended");
});

test("orders multiple hosted dirs deterministically after the codehub bin dir", () => {
  const hosted = ["/a/node_modules/.bin", "/b/node_modules/.bin"];
  const out = withCodehubBinOnPath({ PATH: "/usr/bin" }, () => hosted);
  assert.equal(
    out["PATH"],
    `${BIN_DIR}${SEP}/a/node_modules/.bin${SEP}/b/node_modules/.bin${SEP}/usr/bin`,
  );
});

test("hostedScipBinDirs resolves a .bin holding the scip-python / scip-typescript shims", () => {
  // The two pure-JS indexers are hard `dependencies` of this package, so a
  // built/installed tree must expose their bin shims via at least one resolved
  // dir. Each returned dir must actually exist and at least one must carry a
  // scip-* shim (the dead-dir filter guarantees no empty dirs leak through).
  const dirs = hostedScipBinDirs();
  assert.ok(Array.isArray(dirs), "returns an array");
  for (const d of dirs) {
    assert.ok(existsSync(d), `resolved bin dir should exist: ${d}`);
  }
  const hasAShim = dirs.some(
    (d) => existsSync(join(d, "scip-python")) || existsSync(join(d, "scip-typescript")),
  );
  assert.ok(hasAShim, "at least one resolved dir must hold a scip-python/scip-typescript shim");
});
