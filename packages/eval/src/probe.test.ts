import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { DEFAULT_RUNS, resolveHarnesses, runProbe } from "./probe.js";
import { serializeReport } from "./report.js";
import type { AgentRunner, Harness, RunOutcome, RunRequest } from "./runner.js";
import type { Task } from "./task.js";

const TASK: Task = {
  id: "demo",
  repo: "/tmp/repo",
  commit: "c0ffee",
  instruction: "Add a --json flag.",
  oracle: { type: "output_hash", field: "final_text" },
};

/**
 * A deterministic fake runner: in the with-pack arm it returns a constant
 * answer (perfectly stable); in the without-pack arm it returns a per-run
 * distinct answer (maximally unstable). This is the canonical Move-2 shape —
 * the pack should drive the dispersion delta strongly positive.
 */
class FakeRunner implements AgentRunner {
  readonly name: string;
  private i = 0;
  constructor(public readonly harness: Harness) {
    this.name = `fake:${harness}`;
  }
  run(request: RunRequest): Promise<RunOutcome> {
    this.i += 1;
    const finalText = request.withPack ? "stable answer" : `wandering answer ${this.i}`;
    return Promise.resolve({
      finalText,
      diff: "",
      tokens: {
        inputTokens: request.withPack ? 1100 : 1000,
        outputTokens: 100,
        cacheTokens: 0,
        costUsd: null,
      },
      errored: false,
    });
  }
}

describe("resolveHarnesses", () => {
  it("defaults to both agents when the task pins none", () => {
    assert.deepEqual(resolveHarnesses(TASK, { packContext: "" }), ["claude", "codex"]);
  });
  it("uses the task's pinned harness", () => {
    assert.deepEqual(resolveHarnesses({ ...TASK, harness: "codex" }, { packContext: "" }), [
      "codex",
    ]);
  });
  it("honors an explicit options.harnesses override", () => {
    assert.deepEqual(resolveHarnesses(TASK, { packContext: "", harnesses: ["claude"] }), [
      "claude",
    ]);
  });
});

describe("runProbe (end-to-end with a fake runner)", () => {
  it("measures a strong positive dispersion delta when the pack stabilizes answers", async () => {
    const report = await runProbe(TASK, (h) => new FakeRunner(h), {
      runs: 4,
      packContext: "PACK BODY",
      harnesses: ["claude"],
    });
    assert.equal(report.schema, 1);
    assert.equal(report.taskId, "demo");
    assert.equal(report.harnesses.length, 1);
    const h = report.harnesses[0];
    assert.ok(h !== undefined);
    // without-pack: 4 distinct answers → distinctRatio 1.0
    // with-pack:    1 distinct answer  → distinctRatio 0.25
    if (h.without.dispersion.kind === "output_hash") {
      assert.equal(h.without.dispersion.distinctRatio, 1);
    }
    if (h.with.dispersion.kind === "output_hash") {
      assert.equal(h.with.dispersion.distinctRatio, 0.25);
    }
    assert.ok(Math.abs(h.dispersionDelta - 0.75) < 1e-9, "delta = 1.0 − 0.25");
    // token overhead: with=1200/run, without=1100/run → 1.0909...
    assert.ok(h.tokenOverhead > 1 && h.tokenOverhead < 1.3);
    assert.equal(h.tokenOverheadFlagged, false);
  });

  it("runs both harnesses by default", async () => {
    const report = await runProbe(TASK, (h) => new FakeRunner(h), {
      runs: 2,
      packContext: "PACK",
    });
    assert.deepEqual(
      report.harnesses.map((h) => h.harness),
      ["claude", "codex"],
    );
  });

  it("emits a byte-identical report across two identical probe runs (R6)", async () => {
    const opts = { runs: 3, packContext: "PACK", harnesses: ["codex"] as Harness[] };
    const a = await runProbe(TASK, (h) => new FakeRunner(h), opts);
    const b = await runProbe(TASK, (h) => new FakeRunner(h), opts);
    assert.equal(serializeReport(a), serializeReport(b));
  });

  it("defaults to DEFAULT_RUNS when runs is omitted", async () => {
    const report = await runProbe(TASK, (h) => new FakeRunner(h), {
      packContext: "PACK",
      harnesses: ["claude"],
    });
    assert.equal(report.harnesses[0]?.runs, DEFAULT_RUNS);
  });

  it("invokes the per-run progress callback for both arms", async () => {
    const events: string[] = [];
    await runProbe(TASK, (h) => new FakeRunner(h), {
      runs: 2,
      packContext: "PACK",
      harnesses: ["claude"],
      onRun: (e) => events.push(`${e.harness}:${e.arm}:${e.index}/${e.runs}`),
    });
    assert.deepEqual(events, [
      "claude:without:1/2",
      "claude:without:2/2",
      "claude:with:1/2",
      "claude:with:2/2",
    ]);
  });
});
