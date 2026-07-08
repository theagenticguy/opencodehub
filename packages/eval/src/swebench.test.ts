import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  buildAssertionCommand,
  instanceToTask,
  parseTestList,
  type SweBenchInstance,
} from "./swebench.js";

const INSTANCE: SweBenchInstance = {
  instance_id: "astropy__astropy-12907",
  repo: "astropy/astropy",
  base_commit: "d16bfe05a744909de4b27f5875fe0d4ed41ce607",
  problem_statement:
    "Modeling's `separability_matrix` does not compute correctly for nested CompoundModels.",
  test_patch: "diff --git a/astropy/modeling/tests/test_separable.py ...",
  FAIL_TO_PASS: '["astropy/modeling/tests/test_separable.py::test_nested"]',
  PASS_TO_PASS: '["astropy/modeling/tests/test_separable.py::test_basic", "...::test_other"]',
};

describe("parseTestList", () => {
  it("parses a JSON-string array", () => {
    assert.deepEqual(parseTestList('["a::t1", "b::t2"]'), ["a::t1", "b::t2"]);
  });
  it("passes through an already-parsed array", () => {
    assert.deepEqual(parseTestList(["a", "b"]), ["a", "b"]);
  });
  it("falls back to whitespace-split for a bare string", () => {
    assert.deepEqual(parseTestList("a::t1 b::t2"), ["a::t1", "b::t2"]);
  });
  it("returns [] for empty / malformed", () => {
    assert.deepEqual(parseTestList(""), []);
    assert.deepEqual(parseTestList("[not json"), ["[not", "json"]);
  });
});

describe("buildAssertionCommand", () => {
  it("applies the test_patch then runs F2P+P2P under pytest -x", () => {
    const cmd = buildAssertionCommand(INSTANCE, "pytest", "/tmp/p.patch");
    assert.match(cmd, /^git apply --3way '\/tmp\/p\.patch' && python -m pytest -x /);
    assert.ok(cmd.includes("'astropy/modeling/tests/test_separable.py::test_nested'"));
    assert.ok(cmd.includes("'astropy/modeling/tests/test_separable.py::test_basic'"));
    // P2P tests are included alongside F2P.
    assert.ok(cmd.includes("'...::test_other'"));
  });

  it("runs distinct test files (not node ids) under the node runner", () => {
    const nodeInstance: SweBenchInstance = {
      ...INSTANCE,
      FAIL_TO_PASS: '["test/a.test.js::x", "test/a.test.js::y"]',
      PASS_TO_PASS: '["test/b.test.js::z"]',
    };
    const cmd = buildAssertionCommand(nodeInstance, "node", "/tmp/p.patch");
    assert.match(cmd, /node --test /);
    // a.test.js appears once (deduped), b.test.js once.
    assert.ok(cmd.includes("'test/a.test.js'"));
    assert.ok(cmd.includes("'test/b.test.js'"));
    assert.equal((cmd.match(/a\.test\.js/g) ?? []).length, 1, "file deduped across two node ids");
  });

  it("shell-quotes node ids so :: and [param] pass verbatim", () => {
    const paramInstance: SweBenchInstance = {
      ...INSTANCE,
      FAIL_TO_PASS: '["pkg/test_x.py::test_f[param-1]"]',
      PASS_TO_PASS: "[]",
    };
    const cmd = buildAssertionCommand(paramInstance, "pytest", "/tmp/p.patch");
    assert.ok(cmd.includes("'pkg/test_x.py::test_f[param-1]'"));
  });
});

describe("instanceToTask", () => {
  it("maps an instance to an OCH assertion task + clone spec + patch", () => {
    const gen = instanceToTask(INSTANCE, {
      cloneRoot: "/tmp/swebench/",
      testPatchPath: "/tmp/swebench/astropy__astropy-12907.patch",
    });
    assert.equal(gen.task.id, "astropy__astropy-12907");
    assert.equal(gen.task.repo, "/tmp/swebench/astropy__astropy-12907");
    assert.equal(gen.task.commit, INSTANCE.base_commit);
    assert.equal(gen.task.instruction, INSTANCE.problem_statement);
    assert.equal(gen.task.oracle.type, "assertion");
    assert.equal(gen.task.oracle.timeoutMs, 600_000);
    // clone spec
    assert.equal(gen.clone.cloneUrl, "https://github.com/astropy/astropy.git");
    assert.equal(gen.clone.baseCommit, INSTANCE.base_commit);
    assert.equal(gen.clone.dest, "/tmp/swebench/astropy__astropy-12907");
    // patch carried through
    assert.equal(gen.testPatch, INSTANCE.test_patch);
  });

  it("honors a custom timeout and trailing-slash-normalizes cloneRoot", () => {
    const gen = instanceToTask(INSTANCE, {
      cloneRoot: "/tmp/sb///",
      testPatchPath: "/tmp/p.patch",
      timeoutMs: 120_000,
    });
    assert.equal(gen.task.repo, "/tmp/sb/astropy__astropy-12907");
    assert.equal(gen.task.oracle.timeoutMs, 120_000);
  });
});
