/**
 * SWE-bench → variance-probe task conversion (Move 1, Phase 0).
 *
 * SWE-bench Verified (and Pro) ship each task as a fixed instance: a repo at a
 * `base_commit`, a natural-language `problem_statement`, a `test_patch` that
 * adds/updates the tests the fix must satisfy, and two test lists —
 * `FAIL_TO_PASS` (must pass *after* the fix) and `PASS_TO_PASS` (must stay
 * passing). That is exactly OCH's {@link Task} shape with an `assertion` oracle:
 * the instruction is the problem statement, and the oracle applies the
 * test_patch and runs the two test lists, exiting 0 iff all pass.
 *
 * Using real instances upgrades Finding 0001's honesty caveat — there,
 * correctness was an eyeball judgment; here the F2P/P2P tests grade it. And
 * because TraceProbe (arXiv:2607.06184) itself ran on SWE-bench Verified, the
 * INSIGHT per-detector numbers this produces are comparable to the paper's.
 *
 * This module is the **pure transform** — instance JSON → task + on-disk
 * artifacts descriptor. The clone / dependency-install / `codehub analyze`
 * orchestration is inherently side-effectful and lives in the sibling
 * `scripts/swebench-to-tasks.mjs` CLI; keeping the transform pure means it is
 * unit-tested with no network, Docker, or filesystem.
 *
 * ⚠️ Fidelity limits (documented, not hidden — see the PR + Finding 0002):
 *   1. **Per-run checkout isolation.** The v1 CLI runner runs the agent in the
 *      task's repo dir directly and does not reset between the N runs. Graded
 *      correctness needs a clean checkout per run; until the runner clones
 *      per-run, treat the *token + trajectory* deltas as the trustworthy
 *      headline and the assertion pass-rate as indicative.
 *   2. **Environment.** Real repos need their deps installed to run tests. The
 *      prep script installs into a `/tmp` clone; for leaderboard-grade parity
 *      use SWE-bench's official per-instance Docker images (v2).
 */

/** The subset of a SWE-bench instance this transform reads. */
export interface SweBenchInstance {
  readonly instance_id: string;
  readonly repo: string; // "owner/name"
  readonly base_commit: string;
  readonly problem_statement: string;
  readonly test_patch: string;
  /** JSON-encoded array of test node ids, or an already-parsed array. */
  readonly FAIL_TO_PASS: string | readonly string[];
  readonly PASS_TO_PASS: string | readonly string[];
  /** Optional install/version hint carried by some instances. */
  readonly version?: string;
}

/** The test runner a repo's F2P/P2P node ids are executed under. */
export type TestRunner = "pytest" | "node";

export interface ToTaskOptions {
  /**
   * Absolute directory each instance's repo is cloned into by the prep script.
   * The emitted task's `repo` is `${cloneRoot}/${instance_id}`. The generator
   * and the prep script must agree on this.
   */
  readonly cloneRoot: string;
  /**
   * Absolute path the instance's `test_patch` is written to (the assertion
   * `git apply`s it before running tests). The generator writes the patch here.
   */
  readonly testPatchPath: string;
  /** Test runner for the F2P/P2P node ids. Defaults to `pytest` (SWE-bench is ~94% Python). */
  readonly runner?: TestRunner;
  /** Per-command timeout (ms) for the assertion. Defaults to 600_000 (10 min). */
  readonly timeoutMs?: number;
}

/** A generated OCH task plus the on-disk artifacts the generator must write. */
export interface GeneratedTask {
  /** The OCH task document (serialize to `<instance_id>.task.json`). */
  readonly task: {
    readonly id: string;
    readonly repo: string;
    readonly commit: string;
    readonly instruction: string;
    readonly oracle: {
      readonly type: "assertion";
      readonly command: string;
      readonly timeoutMs: number;
    };
  };
  /** The clone spec the prep script consumes for this instance. */
  readonly clone: {
    readonly instanceId: string;
    readonly cloneUrl: string;
    readonly baseCommit: string;
    readonly dest: string;
  };
  /** The test_patch text to write to `testPatchPath` (empty when the instance carries none). */
  readonly testPatch: string;
}

/** Parse a FAIL_TO_PASS / PASS_TO_PASS field that may be a JSON string or an array. */
export function parseTestList(value: string | readonly string[]): string[] {
  if (Array.isArray(value)) return value.filter((t): t is string => typeof t === "string");
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.filter((t): t is string => typeof t === "string");
    } catch {
      // Not JSON — treat as a single whitespace-separated list.
      return value.trim().length > 0 ? value.trim().split(/\s+/) : [];
    }
  }
  return [];
}

/**
 * Build the assertion command that grades an instance: apply the test_patch,
 * then run the union of F2P + P2P tests, exiting 0 iff all pass. `-x` (pytest)
 * / bail (node) stops at the first failure so a broken run fails fast.
 *
 * The test_patch is applied with `git apply --3way`; the agent's fix is already
 * in the working tree (the runner ran the agent in this checkout), so we apply
 * only the tests on top. Shell-quoted so node ids with `::` and `[param]` are
 * passed verbatim.
 */
export function buildAssertionCommand(
  instance: SweBenchInstance,
  runner: TestRunner,
  testPatchPath: string,
): string {
  const tests = [...parseTestList(instance.FAIL_TO_PASS), ...parseTestList(instance.PASS_TO_PASS)];
  const applyPatch = `git apply --3way ${shquote(testPatchPath)}`;
  if (runner === "node") {
    // node --test takes files, not node ids; run the distinct test files.
    const files = [...new Set(tests.map((t) => t.split("::")[0] ?? t).filter((f) => f.length > 0))];
    const fileArgs = files.map(shquote).join(" ");
    return `${applyPatch} && node --test ${fileArgs}`;
  }
  // pytest: pass the node ids directly; -x bails on first failure.
  const idArgs = tests.map(shquote).join(" ");
  return `${applyPatch} && python -m pytest -x ${idArgs}`;
}

/** Convert one SWE-bench instance into a generated task + its artifacts. */
export function instanceToTask(instance: SweBenchInstance, options: ToTaskOptions): GeneratedTask {
  const runner = options.runner ?? "pytest";
  const timeoutMs = options.timeoutMs ?? 600_000;
  const dest = `${stripTrailingSlashes(options.cloneRoot)}/${instance.instance_id}`;
  return {
    task: {
      id: instance.instance_id,
      repo: dest,
      commit: instance.base_commit,
      instruction: instance.problem_statement,
      oracle: {
        type: "assertion",
        command: buildAssertionCommand(instance, runner, options.testPatchPath),
        timeoutMs,
      },
    },
    clone: {
      instanceId: instance.instance_id,
      cloneUrl: `https://github.com/${instance.repo}.git`,
      baseCommit: instance.base_commit,
      dest,
    },
    testPatch: instance.test_patch,
  };
}

/** Minimal single-quote shell quoting for a path / test node id. */
function shquote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Strip trailing `/` from a directory path. A linear char scan rather than a
 * `/\/+$/` regex, which backtracks polynomially on an all-slash string
 * (CodeQL js/polynomial-redos).
 */
function stripTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === "/") end -= 1;
  return path.slice(0, end);
}
