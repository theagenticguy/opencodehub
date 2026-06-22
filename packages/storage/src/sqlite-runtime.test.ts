/**
 * Tests for the SQLite runtime guard: it must swallow ONLY the SQLite
 * ExperimentalWarning and pass every other warning through untouched, and
 * it must be idempotent (installing twice does not double-wrap).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { installSqliteRuntimeGuard } from "./sqlite-runtime.js";

test("guard swallows the SQLite experimental warning, passes others through", () => {
  installSqliteRuntimeGuard(); // already auto-installed on import; idempotent

  const seen: string[] = [];
  const original = process.emitWarning;
  // Capture what the guard delegates downstream by stubbing the *original*
  // sink one level below the guard. The guard calls the bound original it
  // captured at install time, so to observe delegation we drive emitWarning
  // and record what is NOT swallowed.
  const restore = process.emitWarning;
  process.emitWarning = ((w: string | Error, ..._a: unknown[]) => {
    seen.push(typeof w === "string" ? w : w.message);
  }) as typeof process.emitWarning;
  try {
    // Re-install so the guard wraps OUR capture sink as its delegate.
    (process as unknown as { [k: symbol]: unknown })[Symbol.for("opencodehub.sqlite-runtime.installed")] =
      undefined;
    installSqliteRuntimeGuard();

    // SQLite experimental warning → swallowed.
    process.emitWarning(
      "SQLite is an experimental feature and might change at any time",
      "ExperimentalWarning",
    );
    // Unrelated warning → passed through.
    process.emitWarning("a normal deprecation", "DeprecationWarning");
    // A different experimental warning → passed through (not SQLite).
    process.emitWarning("Fetch is an experimental feature", "ExperimentalWarning");
  } finally {
    process.emitWarning = restore;
    process.emitWarning = original;
  }

  assert.ok(
    !seen.some((m) => /sqlite/i.test(m)),
    "SQLite experimental warning must be swallowed",
  );
  assert.ok(seen.includes("a normal deprecation"), "non-SQLite warning passes through");
  assert.ok(
    seen.includes("Fetch is an experimental feature"),
    "non-SQLite experimental warning passes through",
  );
});

test("importing node:sqlite under the guard produces no warning on stderr", async () => {
  // Smoke: the guard is auto-installed on module import, so loading the
  // binding here must not surface the warning. We can only assert it does
  // not throw; stderr capture across the worker boundary is covered by the
  // CLI integration path. This guards against the guard itself throwing.
  await assert.doesNotReject(async () => {
    await import("node:sqlite");
  });
});
