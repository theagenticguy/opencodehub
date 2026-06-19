/**
 * Unit tests for the Tier-3 runner.
 *
 * Mirrors `scip-ingest`'s `ruby.test.ts` discipline: assert the spawn plan +
 * opt-in / warmup / hard-fail semantics with FIXTURES, WITHOUT spawning any
 * real LSP server (agent-lsp + servers are absent — live e2e is BLOCKED-ON-ENV).
 * The live spawn/RPC layer is injected via `LspBackend`; a `SpyBackend` records
 * whether it was ever invoked so we can prove O-A7's "no spawn when opt-in off".
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { BlastRadiusResult, LspBackend } from "./runner.js";
import {
  buildSpawnPlan,
  DEFAULT_WARMUP_TIMEOUT_MS,
  LspTierHardFailure,
  runLspTier,
} from "./runner.js";
import type { LspServerPin } from "./servers.js";
import { LSP_SERVER_REGISTRY } from "./servers.js";

/** A backend that records calls and returns a scripted result. */
class SpyBackend implements LspBackend {
  calls = 0;
  constructor(private readonly scripted: (pin: LspServerPin) => BlastRadiusResult) {}
  async warmupAndBlastRadius(pin: LspServerPin): Promise<BlastRadiusResult> {
    this.calls += 1;
    return this.scripted(pin);
  }
}

function warmResult(pin: LspServerPin): BlastRadiusResult {
  return {
    serverVersion: pin.pinnedVersion,
    warm: true,
    partial: false,
    symbols: [
      { symbol: "B.beta", edges: ["A.alpha"] },
      { symbol: "A.alpha", edges: [] },
    ],
  };
}

// ---- O-A7: opt-in gate --------------------------------------------------

test("O-A7: optIn=false → ZERO spawns, empty result (silent Tree-sitter degrade)", async () => {
  const backend = new SpyBackend(warmResult);
  const facts = await runLspTier(
    { projectRoot: "/repo", language: "swift", files: ["a.swift"], optIn: false },
    backend,
  );
  assert.equal(backend.calls, 0, "no warmup/spawn when opt-in is off");
  assert.deepEqual(facts, []);
});

test("O-A7: optIn=true → backend IS invoked", async () => {
  const backend = new SpyBackend(warmResult);
  await runLspTier(
    { projectRoot: "/repo", language: "swift", files: ["a.swift"], optIn: true },
    backend,
  );
  assert.equal(backend.calls, 1);
});

// ---- happy path: tagged + re-sorted facts -------------------------------

test("optIn + warm + complete → tagged, canonically re-sorted facts", async () => {
  const backend = new SpyBackend(warmResult);
  const facts = await runLspTier(
    { projectRoot: "/repo", language: "swift", files: ["a.swift", "b.swift"], optIn: true },
    backend,
  );
  // Sorted by symbol; every fact tagged source=lsp + server=sourcekit-lsp@<pin>.
  assert.deepEqual(
    facts.map((f) => f.symbol),
    ["A.alpha", "B.beta"],
  );
  for (const f of facts) {
    assert.equal(f.source, "lsp");
    assert.equal(f.server, "sourcekit-lsp@6.0.3");
  }
});

// ---- S-A4b: warmup hard-fail; never write a partial ---------------------

test("S-A4b: not-warm result → LspTierHardFailure (no facts returned)", async () => {
  const backend = new SpyBackend((pin) => ({ ...warmResult(pin), warm: false }));
  await assert.rejects(
    runLspTier({ projectRoot: "/repo", language: "zig", files: ["a.zig"], optIn: true }, backend),
    (err: unknown) =>
      err instanceof LspTierHardFailure && /warmup readiness/.test((err as Error).message),
  );
});

test("S-A4b: partial result → LspTierHardFailure (hard failure, never cached)", async () => {
  const backend = new SpyBackend((pin) => ({ ...warmResult(pin), partial: true }));
  await assert.rejects(
    runLspTier({ projectRoot: "/repo", language: "elixir", files: ["a.ex"], optIn: true }, backend),
    (err: unknown) => err instanceof LspTierHardFailure && /partial/.test((err as Error).message),
  );
});

test("server-version mismatch against the pin → LspTierHardFailure", async () => {
  const backend = new SpyBackend((pin) => ({ ...warmResult(pin), serverVersion: "9.9.9" }));
  await assert.rejects(
    runLspTier(
      { projectRoot: "/repo", language: "swift", files: ["a.swift"], optIn: true },
      backend,
    ),
    (err: unknown) =>
      err instanceof LspTierHardFailure && /9\.9\.9 != pinned 6\.0\.3/.test((err as Error).message),
  );
});

test("custom warmupTimeoutMs is forwarded; default is the 5-min ceiling", async () => {
  assert.equal(DEFAULT_WARMUP_TIMEOUT_MS, 5 * 60 * 1000);
  let seen = -1;
  const backend: LspBackend = {
    async warmupAndBlastRadius(pin, _root, _files, timeout) {
      seen = timeout;
      return warmResult(pin);
    },
  };
  await runLspTier(
    { projectRoot: "/repo", language: "swift", files: [], optIn: true, warmupTimeoutMs: 1234 },
    backend,
  );
  assert.equal(seen, 1234);
});

// ---- spawn plan: allowlist + shell:false, no live spawn -----------------

test("buildSpawnPlan recovers the canonical allowlisted binary with shell:false", () => {
  for (const lang of Object.keys(LSP_SERVER_REGISTRY) as (keyof typeof LSP_SERVER_REGISTRY)[]) {
    const plan = buildSpawnPlan(lang);
    assert.equal(plan.refuseReason, undefined, `${lang} should plan cleanly`);
    assert.equal(plan.cmd, LSP_SERVER_REGISTRY[lang].binary);
    assert.equal(plan.shell, false);
    assert.deepEqual(plan.versionArgs, ["--version"]);
  }
});
