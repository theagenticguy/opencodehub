import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { aggregateInsight, breaksSearchLoop, scoreInsight, ZERO_INSIGHT } from "./insight.js";
import { type Action, normalizeQuery } from "./trajectory.js";

/* Small action builders keep the detector tables readable. `search` normalizes
 * its query exactly as the capture normalizers do — the detector's contract is
 * that `Action.query` is already normalized, so the builder must honor it. */
const search = (query = "q"): Action => ({ type: "search", query: normalizeQuery(query) });
const read = (target: string): Action => ({ type: "file_read", target });
const write = (target: string): Action => ({ type: "file_write", target });
const reason = (): Action => ({ type: "reason" });
const cmd = (command: string): Action => ({ type: "command", command });
/** N search actions in a row (distinct-enough queries to avoid redundant-search). */
const searches = (n: number): Action[] => Array.from({ length: n }, (_, i) => search(`q${i}`));
const reads = (target: string, n: number): Action[] =>
  Array.from({ length: n }, () => read(target));

describe("Search Loop", () => {
  it("fires on ≥10 consecutive search/read with no write or validation", () => {
    assert.equal(scoreInsight(searches(10)).searchLoop, 1);
    assert.equal(scoreInsight(searches(25)).searchLoop, 1, "one maximal loop, not many");
  });

  it("does NOT fire below the threshold of 10", () => {
    assert.equal(scoreInsight(searches(9)).searchLoop, 0);
  });

  it("is broken by a file_write and by a validation command, splitting the run", () => {
    // 6 reads, write, 6 reads → neither half reaches 10 → 0.
    assert.equal(scoreInsight([...reads("/a", 6), write("/a"), ...reads("/b", 6)]).searchLoop, 0);
    // 10 reads, validation cmd, 10 reads → two loops.
    assert.equal(
      scoreInsight([...reads("/a", 10), cmd("pnpm test"), ...reads("/b", 10)]).searchLoop,
      2,
    );
  });

  it("treats reason / non-validation commands as transparent (does not reset the run)", () => {
    // reason blocks interleave nearly every tool call — they must be transparent
    // or the detector would essentially never fire.
    const withReasons: Action[] = [];
    for (let i = 0; i < 10; i += 1) {
      withReasons.push(read(`/f${i}`), reason());
    }
    assert.equal(scoreInsight(withReasons).searchLoop, 1);
    // a non-validation command (e.g. `ls`) is also transparent.
    assert.equal(scoreInsight([...reads("/a", 5), cmd("ls -la"), ...reads("/b", 5)]).searchLoop, 1);
  });
});

describe("Re-read Churn", () => {
  it("fires when the same file is read ≥3 times within a 10-action window", () => {
    assert.equal(scoreInsight([read("/a"), read("/a"), read("/a")]).rereadChurn, 1);
  });

  it("does NOT fire at 2 reads", () => {
    assert.equal(scoreInsight([read("/a"), read("/a")]).rereadChurn, 0);
  });

  it("is reset by an intervening write to that same path", () => {
    assert.equal(
      scoreInsight([read("/a"), read("/a"), write("/a"), read("/a")]).rereadChurn,
      0,
      "the write resets the read tally for /a",
    );
  });

  it("counts distinct churning files separately, once each per window", () => {
    const counts = scoreInsight([
      read("/a"),
      read("/b"),
      read("/a"),
      read("/b"),
      read("/a"),
      read("/b"),
    ]);
    assert.equal(counts.rereadChurn, 2, "/a and /b each churn once in the window");
  });

  it("scores a churn that completes inside a short (< window) trajectory", () => {
    assert.equal(scoreInsight([read("/a"), read("/a"), read("/a")]).rereadChurn, 1);
  });
});

describe("Redundant Search", () => {
  it("fires on a repeated normalized query within a 10-action window", () => {
    assert.equal(scoreInsight([search("foo"), search("foo")]).redundantSearch, 1);
  });

  it("counts each repeat: three identical searches score 2", () => {
    assert.equal(scoreInsight([search("foo"), search("foo"), search("foo")]).redundantSearch, 2);
  });

  it("treats whitespace-different but normalized-equal queries as the same", () => {
    assert.equal(scoreInsight([search("foo  bar"), search(" foo bar ")]).redundantSearch, 1);
  });

  it("does NOT fire for distinct queries", () => {
    assert.equal(scoreInsight([search("foo"), search("bar")]).redundantSearch, 0);
  });

  it("does NOT fire when the repeat is outside the 10-action window", () => {
    // search("foo"), then 10 filler actions, then search("foo") → 11 apart > window.
    const actions = [search("foo"), ...reads("/x", 10), search("foo")];
    assert.equal(scoreInsight(actions).redundantSearch, 0);
  });
});

describe("Shell-over-Tool", () => {
  it("fires per shell read/search command", () => {
    const counts = scoreInsight([
      cmd("grep -rn foo ."),
      cmd("cat f"),
      cmd("/bin/zsh -lc 'find . -name x'"),
    ]);
    assert.equal(counts.shellOverTool, 3);
  });

  it("does NOT fire for builds/tests or non-read commands", () => {
    assert.equal(
      scoreInsight([cmd("pnpm test"), cmd("git status"), cmd("sed -i s/a/b/ f")]).shellOverTool,
      0,
    );
  });
});

describe("breaksSearchLoop", () => {
  it("true for writes and validation commands, false otherwise", () => {
    assert.equal(breaksSearchLoop(write("/a")), true);
    assert.equal(breaksSearchLoop(cmd("pytest")), true);
    assert.equal(breaksSearchLoop(cmd("ls")), false);
    assert.equal(breaksSearchLoop(read("/a")), false);
    assert.equal(breaksSearchLoop(reason()), false);
  });
});

describe("aggregateInsight", () => {
  it("sums firings and divides per scored (trajectory-bearing) run", () => {
    const loopTraj = searches(10); // searchLoop 1
    const cleanTraj = [read("/a")]; // all zero
    const agg = aggregateInsight([loopTraj, cleanTraj]);
    assert.ok(agg !== undefined);
    assert.equal(agg.scored, 2);
    assert.equal(agg.total.searchLoop, 1);
    assert.equal(agg.perRun.searchLoop, 0.5);
  });

  it("excludes trajectory-less runs from scored (crash ≠ clean)", () => {
    const agg = aggregateInsight([searches(10), undefined, undefined]);
    assert.ok(agg !== undefined);
    assert.equal(agg.scored, 1, "only the one trajectory-bearing run is scored");
    assert.equal(agg.perRun.searchLoop, 1);
  });

  it("returns undefined when no run carried a trajectory", () => {
    assert.equal(aggregateInsight([undefined, undefined]), undefined);
  });
});

describe("empty / degenerate trajectories", () => {
  it("an empty trajectory scores all zeros", () => {
    assert.deepEqual(scoreInsight([]), ZERO_INSIGHT);
  });
});
