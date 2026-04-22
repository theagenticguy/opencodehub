import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { isTestFile, pairedTestCandidates } from "./test-pair.js";

describe("isTestFile", () => {
  it("recognizes Python test files", () => {
    assert.equal(isTestFile("tests/test_foo.py"), true);
    assert.equal(isTestFile("src/test_foo.py"), true);
    assert.equal(isTestFile("src/foo_test.py"), true);
  });

  it("recognizes Go test files", () => {
    assert.equal(isTestFile("pkg/foo_test.go"), true);
  });

  it("recognizes TS/JS test and spec files", () => {
    assert.equal(isTestFile("src/foo.test.ts"), true);
    assert.equal(isTestFile("src/foo.spec.ts"), true);
    assert.equal(isTestFile("src/foo.test.js"), true);
  });

  it("recognizes Java/C# test files", () => {
    assert.equal(isTestFile("src/FooTest.java"), true);
    assert.equal(isTestFile("src/FooTests.cs"), true);
    assert.equal(isTestFile("src/Foo.Tests.cs"), true);
  });

  it("recognizes files under `tests/` or `test/` dirs", () => {
    assert.equal(isTestFile("tests/core.py"), true);
    assert.equal(isTestFile("pkg/tests/core.py"), true);
    assert.equal(isTestFile("src/__tests__/core.ts"), true);
  });

  it("returns false for ordinary source files", () => {
    assert.equal(isTestFile("src/foo.ts"), false);
    assert.equal(isTestFile("pkg/foo.py"), false);
    assert.equal(isTestFile("cmd/main.go"), false);
  });
});

describe("pairedTestCandidates", () => {
  it("TS source gets .test and .spec variants", () => {
    const c = pairedTestCandidates("src/foo.ts");
    assert.ok(c.includes("src/foo.test.ts"));
    assert.ok(c.includes("src/foo.spec.ts"));
  });

  it("Python source gets test_ and _test variants plus tests/", () => {
    const c = pairedTestCandidates("pkg/foo.py");
    assert.ok(c.includes("pkg/test_foo.py"));
    assert.ok(c.includes("pkg/foo_test.py"));
    assert.ok(c.includes("tests/test_foo.py"));
  });

  it("Go source gets _test.go", () => {
    const c = pairedTestCandidates("pkg/foo.go");
    assert.deepEqual([...c], ["pkg/foo_test.go"]);
  });

  it("Java source gets Test suffix", () => {
    const c = pairedTestCandidates("src/Foo.java");
    assert.ok(c.includes("src/FooTest.java"));
  });

  it("returns empty for test files themselves", () => {
    assert.deepEqual(pairedTestCandidates("src/foo.test.ts"), []);
    assert.deepEqual(pairedTestCandidates("tests/test_foo.py"), []);
  });
});
