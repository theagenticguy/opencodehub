import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { KnowledgeGraph } from "@opencodehub/core-types";
import { PipelineGraphError, runPipeline, topologicalSort, validatePipeline } from "./runner.js";
import type { PipelineContext, PipelinePhase } from "./types.js";

function phase<T>(
  name: string,
  deps: readonly string[],
  fn?: (ctx: PipelineContext, deps: ReadonlyMap<string, unknown>) => Promise<T>,
): PipelinePhase<T> {
  return {
    name,
    deps,
    async run(ctx, depMap) {
      if (fn !== undefined) return fn(ctx, depMap);
      return undefined as unknown as T;
    },
  };
}

function makeCtx(): PipelineContext {
  return {
    repoPath: "/tmp/fake",
    options: {},
    graph: new KnowledgeGraph(),
    phaseOutputs: new Map(),
  };
}

describe("validatePipeline", () => {
  it("accepts a valid linear chain", () => {
    const A = phase("A", []);
    const B = phase("B", ["A"]);
    const C = phase("C", ["B"]);
    validatePipeline([A, B, C]);
  });

  it("throws on duplicate names", () => {
    const A = phase("A", []);
    const A2 = phase("A", []);
    assert.throws(
      () => validatePipeline([A, A2]),
      (err: unknown) => {
        assert.ok(err instanceof PipelineGraphError);
        assert.deepEqual(err.duplicate, ["A"]);
        assert.match(err.message, /A/);
        return true;
      },
    );
  });

  it("throws on missing dependency", () => {
    const B = phase("B", ["ghost"]);
    assert.throws(
      () => validatePipeline([B]),
      (err: unknown) => {
        assert.ok(err instanceof PipelineGraphError);
        assert.ok(err.missing !== undefined && err.missing.length > 0);
        assert.match(err.message, /ghost/);
        return true;
      },
    );
  });

  it("throws on cycle with a concrete path", () => {
    const A = phase("A", ["C"]);
    const B = phase("B", ["A"]);
    const C = phase("C", ["B"]);
    assert.throws(
      () => validatePipeline([A, B, C]),
      (err: unknown) => {
        assert.ok(err instanceof PipelineGraphError);
        assert.ok(err.cyclePath !== undefined);
        const path = err.cyclePath as readonly string[];
        // Path closes on its start element.
        assert.equal(path[0], path[path.length - 1]);
        assert.ok(path.length >= 3);
        assert.match(err.message, / -> /);
        return true;
      },
    );
  });
});

describe("topologicalSort", () => {
  it("orders a valid linear chain", () => {
    const A = phase("A", []);
    const B = phase("B", ["A"]);
    const C = phase("C", ["B"]);
    const order = topologicalSort([C, A, B]).map((p) => p.name);
    assert.deepEqual(order, ["A", "B", "C"]);
  });

  it("orders a fork-join DAG deterministically", () => {
    const A = phase("A", []);
    const B = phase("B", ["A"]);
    const C = phase("C", ["A"]);
    const D = phase("D", ["B", "C"]);
    const order = topologicalSort([D, C, B, A]).map((p) => p.name);
    // B before C by alphabetic tiebreak when both are ready after A.
    assert.deepEqual(order, ["A", "B", "C", "D"]);
  });
});

describe("runPipeline", () => {
  it("runs phases in topo order and threads outputs through dependencies", async () => {
    const trace: string[] = [];
    const A = phase("A", [], async () => {
      trace.push("A");
      return { a: 1 };
    });
    const B = phase("B", ["A"], async (_ctx, deps) => {
      trace.push("B");
      assert.deepEqual(deps.get("A"), { a: 1 });
      return { b: 2 };
    });
    const C = phase("C", ["B"], async (_ctx, deps) => {
      trace.push("C");
      assert.deepEqual(deps.get("B"), { b: 2 });
      return { c: 3 };
    });

    const results = await runPipeline([A, B, C], makeCtx());
    assert.deepEqual(trace, ["A", "B", "C"]);
    assert.equal(results.length, 3);
    assert.ok(results[2] && typeof results[2].durationMs === "number");
  });

  it("isolates phases: only declared deps appear in the dependency map", async () => {
    const A = phase("A", [], async () => "a-out");
    const B = phase("B", [], async () => "b-out");
    const C = phase("C", ["A"], async (_ctx, deps) => {
      assert.equal(deps.get("A"), "a-out");
      assert.equal(deps.has("B"), false, "C must not see B even though B ran earlier");
      return "c-out";
    });
    await runPipeline([A, B, C], makeCtx());
  });

  it("wraps phase errors with the phase name and exposes the cause", async () => {
    const A = phase("A", [], async () => {
      throw new Error("boom");
    });
    await assert.rejects(runPipeline([A], makeCtx()), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Phase 'A' failed/);
      assert.match(err.message, /boom/);
      assert.ok(err.cause instanceof Error);
      return true;
    });
  });

  it("swallows errors in the progress callback so the original error propagates", async () => {
    const A = phase("A", [], async () => {
      throw new Error("primary");
    });
    const ctx: PipelineContext = {
      ...makeCtx(),
      onProgress: () => {
        throw new Error("callback boom");
      },
    };
    await assert.rejects(runPipeline([A], ctx), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /primary/);
      return true;
    });
  });
});
