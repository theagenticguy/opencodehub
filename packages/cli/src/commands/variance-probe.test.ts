/**
 * Tests for `runVarianceProbe` (the `codehub code-pack --variance-probe`
 * handler) and `assemblePackContext`.
 *
 * Strategy: inject the `_assemblePackContext` + `_runnerFor` test seams so the
 * probe runs against a fake agent and a stub pack context — no real analyzed
 * repo, no `claude`/`codex` spawn, no Bedrock. `assemblePackContext` is tested
 * against a real on-disk pack directory.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { AgentRunner, Harness, RunOutcome, RunRequest } from "@opencodehub/eval";
import { assemblePackContext, runVarianceProbe } from "./variance-probe.js";

/** A fake runner: stable answer with-pack, distinct answer per run without. */
class FakeRunner implements AgentRunner {
  readonly name: string;
  private i = 0;
  constructor(harness: Harness) {
    this.name = `fake:${harness}`;
  }
  run(request: RunRequest): Promise<RunOutcome> {
    this.i += 1;
    return Promise.resolve({
      finalText: request.withPack ? "stable" : `wander-${this.i}`,
      diff: "",
      tokens: {
        inputTokens: request.withPack ? 110 : 100,
        outputTokens: 10,
        cacheTokens: 0,
        costUsd: null,
      },
      errored: false,
    });
  }
}

describe("runVarianceProbe (seamed)", () => {
  let dir: string;
  let taskFile: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "och-vp-cmd-"));
    taskFile = join(dir, "task.yaml");
    await writeFile(
      taskFile,
      [
        "id: cmd-task",
        `repo: ${dir}`,
        "commit: abc",
        "instruction: Add a flag.",
        "oracle:",
        "  type: output_hash",
        "",
      ].join("\n"),
      "utf8",
    );
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads the task, injects the stub pack, and reports a positive delta", async () => {
    const report = await runVarianceProbe({
      taskFile,
      runs: 3,
      harness: "claude",
      _assemblePackContext: async () => "STUB PACK CONTEXT",
      _runnerFor: (h) => new FakeRunner(h),
    });
    assert.equal(report.taskId, "cmd-task");
    assert.equal(report.harnesses.length, 1);
    const h = report.harnesses[0];
    assert.ok(h !== undefined);
    assert.equal(h.harness, "claude");
    assert.ok(h.dispersionDelta > 0, "the stabilizing pack drives a positive delta");
  });

  it("passes the assembled pack context into the with-pack arm", async () => {
    let withPackPrompts = 0;
    const capturing: AgentRunner = {
      name: "capture",
      run(req: RunRequest): Promise<RunOutcome> {
        if (req.withPack) {
          assert.equal(req.packContext, "ASSEMBLED-PACK");
          withPackPrompts += 1;
        } else {
          assert.equal(req.packContext, undefined, "no pack in the without arm");
        }
        return Promise.resolve({
          finalText: req.withPack ? "s" : `${Math.random()}`,
          diff: "",
          tokens: { inputTokens: 1, outputTokens: 1, cacheTokens: 0, costUsd: null },
          errored: false,
        });
      },
    };
    await runVarianceProbe({
      taskFile,
      runs: 2,
      harness: "codex",
      _assemblePackContext: async () => "ASSEMBLED-PACK",
      _runnerFor: () => capturing,
    });
    assert.equal(withPackPrompts, 2, "both with-pack runs saw the assembled context");
  });

  it("builds a per-harness runner for each agent in the default set (Bug-2 routing)", async () => {
    // With no --harness pin, the probe visits both agents; the default factory
    // maps args.models[harness] to each. We assert the factory is invoked once
    // per harness so a per-harness model would reach the right runner.
    const seen: string[] = [];
    await runVarianceProbe({
      taskFile,
      runs: 1,
      _assemblePackContext: async () => "PACK",
      _runnerFor: (h) => {
        seen.push(h);
        return {
          name: `fake:${h}`,
          run: () =>
            Promise.resolve({
              finalText: "x",
              diff: "",
              tokens: { inputTokens: 1, outputTokens: 1, cacheTokens: 0, costUsd: null },
              errored: false,
            }),
        };
      },
    });
    assert.deepEqual([...seen].sort(), ["claude", "codex"], "one runner built per harness");
  });
});

describe("assemblePackContext", () => {
  let packDir: string;
  before(async () => {
    packDir = await mkdtemp(join(tmpdir(), "och-vp-pack-"));
    await writeFile(join(packDir, "readme.md"), "# Pack readme\nhello", "utf8");
    await writeFile(join(packDir, "skeleton.jsonl"), '{"sym":"foo"}', "utf8");
    await writeFile(join(packDir, "manifest.json"), '{"packHash":"x"}', "utf8");
    await writeFile(join(packDir, "context-bom.json"), '{"components":[]}', "utf8");
  });
  after(async () => {
    await rm(packDir, { recursive: true, force: true });
  });

  it("includes the body files in sorted order and excludes manifest + context-bom", async () => {
    const ctx = await assemblePackContext(packDir);
    assert.ok(ctx.includes("### readme.md"));
    assert.ok(ctx.includes("### skeleton.jsonl"));
    assert.ok(ctx.includes("# Pack readme"));
    assert.ok(!ctx.includes("manifest.json"), "manifest excluded (provenance, not content)");
    assert.ok(!ctx.includes("context-bom.json"), "context-bom excluded");
    // sorted: readme.md before skeleton.jsonl
    assert.ok(ctx.indexOf("### readme.md") < ctx.indexOf("### skeleton.jsonl"));
  });

  it("Move 4: the auto default is byte-identical to the no-channel call (no marker)", async () => {
    const bare = await assemblePackContext(packDir);
    const auto = await assemblePackContext(packDir, "auto");
    assert.equal(auto, bare, "auto must not perturb the default output");
    assert.ok(!auto.includes("opencodehub:cachePoint"), "auto emits no cache marker");
  });

  it("Move 4: an automatic channel emits no marker", async () => {
    const ctx = await assemblePackContext(packDir, "anthropic");
    assert.ok(!ctx.includes("opencodehub:cachePoint"), "anthropic caches automatically");
    assert.equal(ctx, await assemblePackContext(packDir), "identical to the marker-free default");
  });

  it("Move 4: bedrock inserts one cache-breakpoint sentinel at the prefix boundary", async () => {
    const ctx = await assemblePackContext(packDir, "bedrock");
    const marker =
      '<!-- opencodehub:cachePoint channel=bedrock {"cachePoint":{"type":"default"}} -->';
    assert.ok(ctx.includes(marker), "bedrock sentinel present");
    assert.equal(ctx.split(marker).length - 1, 1, "exactly one marker");
    // skeleton.jsonl is the sole stable-prefix file present, so the boundary
    // sits immediately after it (before the volatile tail would begin).
    assert.ok(
      ctx.indexOf("### skeleton.jsonl") < ctx.indexOf(marker),
      "marker follows the stable skeleton prefix",
    );
  });

  it("Move 4: same channel twice is byte-identical (deterministic)", async () => {
    assert.equal(
      await assemblePackContext(packDir, "bedrock"),
      await assemblePackContext(packDir, "bedrock"),
    );
  });
});
