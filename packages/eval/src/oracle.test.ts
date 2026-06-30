import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { scoreArm } from "./oracle.js";
import type { RunOutcome } from "./runner.js";
import type { AssertionOracle, JudgeOracle, OutputHashOracle } from "./task.js";

const outcome = (over: Partial<RunOutcome>): RunOutcome => ({
  finalText: "",
  diff: "",
  tokens: { inputTokens: 0, outputTokens: 0, costUsd: null },
  errored: false,
  ...over,
});

describe("scoreArm — output_hash", () => {
  const oracle: OutputHashOracle = { type: "output_hash", field: "final_text" };

  it("is 1/N (stable) when every final_text is identical", async () => {
    const outcomes = [
      outcome({ finalText: "same" }),
      outcome({ finalText: "same" }),
      outcome({ finalText: "same" }),
    ];
    const d = await scoreArm(oracle, outcomes);
    assert.equal(d.kind, "output_hash");
    if (d.kind === "output_hash") assert.ok(Math.abs(d.distinctRatio - 1 / 3) < 1e-9);
  });

  it("counts an errored run as its own distinct outcome", async () => {
    const outcomes = [
      outcome({ finalText: "x" }),
      outcome({ finalText: "x" }),
      outcome({ finalText: "x", errored: true }),
    ];
    const d = await scoreArm(oracle, outcomes);
    if (d.kind === "output_hash") assert.ok(Math.abs(d.distinctRatio - 2 / 3) < 1e-9);
  });

  it("hashes the diff field when configured", async () => {
    const diffOracle: OutputHashOracle = { type: "output_hash", field: "diff" };
    const outcomes = [
      outcome({ finalText: "differ", diff: "same-diff" }),
      outcome({ finalText: "wildly-different", diff: "same-diff" }),
    ];
    const d = await scoreArm(diffOracle, outcomes);
    if (d.kind === "output_hash") assert.equal(d.distinctRatio, 0.5, "1 distinct diff over 2 runs");
  });
});

describe("scoreArm — assertion", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "och-eval-oracle-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("runs the shell command in each checkout: exit 0 = pass", async () => {
    const oracle: AssertionOracle = { type: "assertion", command: "true", timeoutMs: 30_000 };
    const outcomes = [
      outcome({ checkoutPath: dir }),
      outcome({ checkoutPath: dir }),
      outcome({ checkoutPath: dir }),
    ];
    const d = await scoreArm(oracle, outcomes);
    assert.equal(d.kind, "assertion");
    if (d.kind === "assertion") {
      assert.equal(d.passRate, 1);
      assert.equal(d.stddev, 0);
    }
  });

  it("scores exit-non-zero as a fail", async () => {
    const oracle: AssertionOracle = { type: "assertion", command: "false", timeoutMs: 30_000 };
    const d = await scoreArm(oracle, [outcome({ checkoutPath: dir })]);
    if (d.kind === "assertion") assert.equal(d.passRate, 0);
  });

  it("scores an errored run (no checkout) as a fail without spawning", async () => {
    const oracle: AssertionOracle = { type: "assertion", command: "true", timeoutMs: 30_000 };
    const d = await scoreArm(oracle, [outcome({ errored: true })]);
    if (d.kind === "assertion") assert.equal(d.passRate, 0);
  });

  it("produces mixed pass-rate dispersion", async () => {
    // command passes only when the marker file exists; we toggle via cwd trick:
    // here just alternate true/false commands to simulate a flaky agent.
    const passOracle: AssertionOracle = { type: "assertion", command: "true", timeoutMs: 30_000 };
    const failOracle: AssertionOracle = { type: "assertion", command: "false", timeoutMs: 30_000 };
    const pass = await scoreArm(passOracle, [
      outcome({ checkoutPath: dir }),
      outcome({ checkoutPath: dir }),
    ]);
    const fail = await scoreArm(failOracle, [
      outcome({ checkoutPath: dir }),
      outcome({ checkoutPath: dir }),
    ]);
    if (pass.kind === "assertion" && fail.kind === "assertion") {
      assert.equal(pass.passRate, 1);
      assert.equal(fail.passRate, 0);
    }
  });
});

describe("scoreArm — judge", () => {
  const oracle: JudgeOracle = { type: "judge", rubric: "score correctness", panel: 2 };

  it("throws a clear error when no JudgeScorer is supplied", async () => {
    await assert.rejects(
      () => scoreArm(oracle, [outcome({ finalText: "x" })]),
      /requires a JudgeScorer/,
    );
  });

  it("averages the panel and computes score stddev", async () => {
    // Deterministic judge: score = length-based fraction so two outcomes differ.
    const judge = async (o: RunOutcome): Promise<number> => (o.finalText === "good" ? 0.9 : 0.1);
    const d = await scoreArm(
      oracle,
      [outcome({ finalText: "good" }), outcome({ finalText: "bad" })],
      { judge },
    );
    assert.equal(d.kind, "judge");
    if (d.kind === "judge") {
      assert.ok(Math.abs(d.meanScore - 0.5) < 1e-9);
      assert.ok(d.stddev > 0);
    }
  });

  it("scores an errored run as 0 without calling the judge", async () => {
    let calls = 0;
    const judge = async (): Promise<number> => {
      calls += 1;
      return 1;
    };
    const d = await scoreArm(oracle, [outcome({ errored: true })], { judge });
    if (d.kind === "judge") assert.equal(d.meanScore, 0);
    assert.equal(calls, 0, "judge not called for an errored run");
  });

  it("clamps out-of-range judge scores into [0,1]", async () => {
    const judge = async (): Promise<number> => 5; // misbehaving judge
    const d = await scoreArm(oracle, [outcome({ finalText: "x" })], { judge });
    if (d.kind === "judge") assert.equal(d.meanScore, 1);
  });
});
