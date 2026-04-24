import assert from "node:assert/strict";
import { test } from "node:test";
import type { SarifLog } from "@opencodehub/sarif";
import { runScanners } from "./runner.js";
import {
  emptySarifFor,
  type ScannerRunContext,
  type ScannerRunResult,
  type ScannerSpec,
  type ScannerWrapper,
} from "./spec.js";

function makeSpec(id: string): ScannerSpec {
  return {
    id,
    name: id,
    languages: "all",
    iacTypes: [],
    sarifNative: true,
    installCmd: `install ${id}`,
    version: "0.0.0",
    offlineCapable: true,
    priority: 1,
    license: "MIT",
  };
}

function okWrapper(id: string): ScannerWrapper {
  const spec = makeSpec(id);
  const sarif: SarifLog = {
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: id, version: "1.0.0" } },
        results: [{ ruleId: `${id}.rule1`, message: { text: `finding from ${id}` } }],
      },
    ],
  };
  return {
    spec,
    run: async (_ctx: ScannerRunContext): Promise<ScannerRunResult> => ({
      spec,
      sarif,
      durationMs: 1,
    }),
  };
}

function throwingWrapper(id: string): ScannerWrapper {
  const spec = makeSpec(id);
  return {
    spec,
    run: async (): Promise<ScannerRunResult> => {
      throw new Error("kaboom");
    },
  };
}

test("runScanners merges SARIF from every wrapper that succeeded", async () => {
  const wrappers = [okWrapper("a"), okWrapper("b"), okWrapper("c")];
  const result = await runScanners("/tmp/repo", wrappers, { concurrency: 2 });
  assert.equal(result.sarif.version, "2.1.0");
  assert.equal(result.sarif.runs.length, 3);
  const names = result.sarif.runs.map((r) => r.tool.driver.name).sort();
  assert.deepEqual(names, ["a", "b", "c"]);
  assert.equal(result.errored.length, 0);
});

test("runScanners tolerates one failing wrapper — others still present", async () => {
  const wrappers = [okWrapper("a"), throwingWrapper("b"), okWrapper("c")];
  const result = await runScanners("/tmp/repo", wrappers, { concurrency: 2 });
  assert.equal(result.errored.length, 1);
  assert.equal(result.errored[0]?.spec.id, "b");
  assert.ok(result.errored[0]?.error.includes("kaboom"));
  // 3 runs in merged SARIF (including b's empty run).
  assert.equal(result.sarif.runs.length, 3);
  const b = result.sarif.runs.find((r) => r.tool.driver.name === "b");
  assert.ok(b);
  assert.equal(b.results?.length, 0);
});

test("runScanners invokes onProgress lifecycle for each scanner", async () => {
  const wrappers = [okWrapper("a"), okWrapper("b")];
  const events: Array<{ id: string; status: string }> = [];
  await runScanners("/tmp/repo", wrappers, {
    concurrency: 1,
    onProgress: (spec, status) => {
      events.push({ id: spec.id, status });
    },
  });
  // Each scanner emits at least start + done.
  const aEvents = events.filter((e) => e.id === "a");
  const bEvents = events.filter((e) => e.id === "b");
  assert.ok(aEvents.some((e) => e.status === "start"));
  assert.ok(aEvents.some((e) => e.status === "done"));
  assert.ok(bEvents.some((e) => e.status === "start"));
  assert.ok(bEvents.some((e) => e.status === "done"));
});

test("runScanners respects concurrency cap", async () => {
  let inFlight = 0;
  let peak = 0;
  const slowWrapper = (id: string): ScannerWrapper => {
    const spec = makeSpec(id);
    return {
      spec,
      run: async (): Promise<ScannerRunResult> => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight -= 1;
        return { spec, sarif: emptySarifFor(spec), durationMs: 20 };
      },
    };
  };
  const wrappers = [slowWrapper("a"), slowWrapper("b"), slowWrapper("c"), slowWrapper("d")];
  await runScanners("/tmp/repo", wrappers, { concurrency: 2 });
  assert.ok(peak <= 2, `peak in-flight should be ≤ 2 but was ${peak}`);
});

test("runScanners with empty input emits an empty SARIF log", async () => {
  const result = await runScanners("/tmp/repo", []);
  assert.equal(result.sarif.runs.length, 0);
  assert.equal(result.errored.length, 0);
  assert.equal(result.runs.length, 0);
});
